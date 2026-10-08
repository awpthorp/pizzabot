import { type PizzaConfig } from "./config";
import { type AwardInput } from "./parser";
import { eligible } from "./policy";
import { help, rewardsBlocks, redemptionBlocks } from "./blocks";
import { PizzaSlack, SlackTransient } from "./slack";
import { PizzaStore, Refusal, LostLease, type Job, type Outbox } from "./store";
function backoff(attempts: number) {
  return Math.min(3600, Math.pow(2, Math.min(attempts, 10)));
}
export async function processJob(
  s: PizzaStore,
  api: PizzaSlack,
  c: PizzaConfig,
  job: Job,
) {
  if (!c.enabled) {
    await s.retry("pizza_inbox", job, 60, "disabled");
    return;
  }
  try {
    if (job.team_id !== c.team) throw new Refusal("Wrong workspace.");
    if (job.kind === "award") {
      const a = job.payload as unknown as AwardInput;
      const valid = await api.channel(a.channel, true);
      const identities = await Promise.all(
        [...new Set([a.giver, ...a.recipients])]
          .sort()
          .map((id) => api.identity(id)),
      );
      await s.award(
        job,
        a,
        identities,
        c,
        valid
          ? undefined
          : "Recognition requires the configured public internal channel.",
      );
      return;
    }
    if (job.kind === "user_change") {
      api.invalidate(String(job.payload.user));
      await s.invalidate(c.team, String(job.payload.user));
      await s.finish(job);
      return;
    }
    const user = String(job.payload.user),
      identity = await api.identity(user);
    if (!eligible(identity, c))
      throw new Refusal("Only eligible workspace staff can use PizzaBot.");
    if (job.kind === "redeem") {
      if (!(await api.channel(c.adminChannel, false)))
        throw new Refusal("Reward admin channel is unavailable or shared.");
      await s.redeem(job, identity, c);
      return;
    }
    if (job.kind === "admin_action") {
      await s.adminAction(job, identity, c);
      return;
    }
    if (job.kind === "catalogue") {
      await s.catalogue(job, identity, c);
      return;
    }
    if (job.kind !== "command") throw new Refusal("Unknown operation.");
    const words = String(job.payload.text ?? "")
        .trim()
        .split(/\s+/),
      command = words[0] || "balance";
    let result: Record<string, unknown>;
    if (command === "balance") {
      const b = await s.balance(c.team, user);
      result = {
        text: `Lifetime earned: ${b.earned} 🍕\nAvailable to spend: ${b.balance} 🍕\nLeft to give today: ${b.remaining}/${5} 🍕\nReset: midnight Asia/Dubai.`,
      };
    } else if (command === "help") result = { text: help };
    else if (
      command === "leaderboard" &&
      (!words[1] || ["month", "all"].includes(words[1]))
    ) {
      const rows = await s.leaderboard(c.team, words[1] === "all");
      result = {
        text: `${words[1] === "all" ? "All-time" : "This Dubai month"} recognition leaderboard\n${rows.map((r, i) => `${i + 1}. <@${r.recipient_id}> — ${r.earned} 🍕`).join("\n") || "No recognition yet."}`,
      };
    } else if (command === "rewards" || command === "admin") {
      if (command === "admin" && !c.admins.includes(user))
        throw new Refusal("Only configured admins can manage rewards.");
      const rewardPage =
        command === "admin" && /^\d{1,4}$/.test(words[2] ?? "")
          ? Number(words[2])
          : 0;
      const rows = await s.rewards(c.team, command === "admin", rewardPage);
      if (command === "admin") {
        const page = /^\d{1,4}$/.test(words[2] ?? "") ? Number(words[2]) : 0;
        const state = await s.adminState(c.team, page);
        const requests = state.requests.flatMap((r) =>
          redemptionBlocks(
            r.id,
            r.user_id,
            r.reward_name,
            r.cost,
            r.description,
          ),
        );
        const deliveries = state.deliveries.map((r) => ({
          type: "section",
          text: {
            type: "plain_text",
            text: `Ambiguous delivery ${r.id}\n${r.notification_key}\n${r.safe_error}. Check Slack for its stable request ID before retrying; request buttons below act once.`,
          },
        }));
        const guide = {
          type: "section",
          text: {
            type: "plain_text",
            text: `Admin view. /pizza admin requests [page] or deliveries [page] or rewards [page] (pages start at 0). Pending request actions work even when the original notification is ambiguous.`,
          },
        };
        result = {
          text: "Pizza admin",
          blocks:
            words[1] === "rewards"
              ? [guide, ...rewardsBlocks(rows, true)]
              : words[1] === "requests"
                ? [guide, ...requests]
                : words[1] === "deliveries"
                  ? [guide, ...deliveries]
                  : [
                      guide,
                      ...rewardsBlocks(rows.slice(0, 8), true),
                      ...requests,
                      ...deliveries.slice(0, 5),
                    ],
        };
      } else
        result = {
          text: rows.length
            ? "Pizza rewards"
            : "No rewards have been configured yet.",
          blocks: rewardsBlocks(rows),
        };
    } else result = { text: help };
    await s.finish(job, result);
  } catch (error) {
    if (error instanceof LostLease) return;
    if (error instanceof Refusal) {
      await s.finish(job, { text: error.message }, true);
      return;
    }
    await s.retry(
      "pizza_inbox",
      job,
      error instanceof SlackTransient ? error.delay : backoff(job.attempts),
      error instanceof SlackTransient
        ? error.code
        : "database_or_worker_unavailable",
    );
  }
}
export async function processDelivery(
  s: PizzaStore,
  api: PizzaSlack,
  job: Outbox,
) {
  try {
    if (job.expires_at && new Date(job.expires_at).getTime() <= Date.now()) {
      await s.delivered(job, undefined, "expired", "response_expired");
      return;
    }
    const ref = await api.deliver(job);
    await s.delivered(job, ref);
  } catch (error) {
    if (error instanceof SlackTransient && error.ambiguous) {
      await s.delivered(job, undefined, "ambiguous", error.code);
      return;
    }
    if (error instanceof Refusal) {
      await s.delivered(job, undefined, "expired", "delivery_unavailable");
      return;
    }
    await s.retry(
      "pizza_outbox",
      job,
      error instanceof SlackTransient ? error.delay : backoff(job.attempts),
      error instanceof SlackTransient ? error.code : "delivery_unavailable",
    );
  }
}
export async function drain(
  s: PizzaStore,
  api: PizzaSlack,
  c: PizzaConfig,
  limit = 20,
) {
  let inbox = 0,
    outbox = 0;
  const until = Date.now() + 20_000;
  if (c.enabled)
    while (inbox < limit && Date.now() < until) {
      const job = await s.claim("pizza_inbox", c.team);
      if (!job) break;
      await processJob(s, api, c, job);
      inbox++;
    }
  while (outbox < limit && Date.now() < until) {
    const job = (await s.claim("pizza_outbox", c.team)) as Outbox | null;
    if (!job) break;
    await processDelivery(s, api, job);
    outbox++;
  }
  await s.maintenance(c.team);
  return { inbox, outbox };
}
