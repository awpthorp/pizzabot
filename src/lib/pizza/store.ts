import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { type PizzaConfig } from "./config";
import { type AwardInput } from "./parser";
import { type Identity, eligible, localDay, rejection } from "./policy";
import { redemptionBlocks, escapeSlackText } from "./blocks";
import { type Period, rankStandings } from "./periods";
import { type CelebrationSnapshot } from "./celebrations";
import { isTier, type Tier } from "./rewards";
import {
  settingsFromRow,
  validSettings,
  validAdjustment,
  settingsSummary,
  type PizzaSettings,
  type SettingsValues,
} from "./settings";

export type Job = {
  id: string;
  team_id: string;
  kind: string;
  payload: Record<string, unknown>;
  lease_owner: string;
  attempts: number;
};
export type Outbox = Job & {
  target: {
    kind: string;
    channel?: string;
    user?: string;
    thread_ts?: string;
    url?: string;
  };
  payload: Record<string, unknown>;
  expires_at: Date | null;
  notification_key: string;
};
export type Reward = {
  id: string;
  name: string;
  cost: number;
  description: string;
  stock: number | null;
  active: boolean;
  tier?: Tier | null;
};
export class Refusal extends Error {}
export class LostLease extends Error {}
let defaultStore: PizzaStore | undefined;
export function store(): PizzaStore {
  if (!defaultStore) {
    const dsn = process.env.DATABASE_URL ?? "";
    defaultStore = new PizzaStore(
      new Pool({
        connectionString: dsn,
        max: 5,
        connectionTimeoutMillis: 300,
        statement_timeout: 650,
        query_timeout: 800,
        ssl: /localhost|127\.0\.0\.1/.test(dsn)
          ? undefined
          : { rejectUnauthorized: false },
      }),
    );
  }
  return defaultStore;
}
export class PizzaStore {
  constructor(readonly db: Pool) {}
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='1000ms'");
      await client.query("SET LOCAL lock_timeout='500ms'");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async enqueue(
    team: string,
    event: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    return (
      await this.db.query(
        `WITH locked AS (SELECT CASE WHEN $4='award' THEN pg_advisory_xact_lock(hashtextextended($2||':celebration-schedule',0)) END)
         INSERT INTO pizza_inbox(id,team_id,event_id,kind,payload) SELECT $1,$2,$3,$4,$5 FROM locked ON CONFLICT(team_id,event_id) DO NOTHING RETURNING id`,
        [randomUUID(), team, event, kind, payload],
      )
    ).rows[0]?.id;
  }
  async claim(
    table: "pizza_inbox" | "pizza_outbox",
    team: string,
  ): Promise<Job | Outbox | null> {
    const owner = randomUUID();
    const row = (
      await this.db.query(
        `WITH ready AS (SELECT id FROM ${table} WHERE team_id=$1 AND ((status='pending' AND retry_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE ${table} j SET status='running',lease_owner=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1 FROM ready WHERE j.id=ready.id RETURNING j.*`,
        [team, owner],
      )
    ).rows[0];
    return row ?? null;
  }
  async guard(client: PoolClient, job: Job) {
    const r = await client.query(
      "SELECT id FROM pizza_inbox WHERE id=$1 AND team_id=$2 AND status='running' AND lease_owner=$3 AND lease_until>now() FOR UPDATE",
      [job.id, job.team_id, job.lease_owner],
    );
    if (!r.rowCount) throw new LostLease();
  }
  async complete(client: PoolClient, job: Job, rejected = false) {
    await client.query(
      "UPDATE pizza_inbox SET status=$4,completed_at=now(),lease_owner=null,lease_until=null WHERE id=$1 AND team_id=$2 AND lease_owner=$3",
      [
        job.id,
        job.team_id,
        job.lease_owner,
        rejected ? "rejected" : "complete",
      ],
    );
  }
  async retry(
    table: "pizza_inbox" | "pizza_outbox",
    job: Job,
    seconds: number,
    code: string,
  ) {
    await this.db.query(
      `UPDATE ${table} SET status='pending',retry_at=now()+$4*interval '1 second',lease_owner=null,lease_until=null,safe_error=$5 WHERE id=$1 AND team_id=$2 AND lease_owner=$3 AND status='running'`,
      [
        job.id,
        job.team_id,
        job.lease_owner,
        Number.isFinite(seconds) ? Math.max(1, seconds) : 60,
        code,
      ],
    );
  }
  async identity(
    client: PoolClient,
    team: string,
    users: Identity[],
    c: PizzaConfig,
  ) {
    for (const user of [...users].sort((a, b) => a.id.localeCompare(b.id)))
      await client.query(
        "INSERT INTO pizza_users(team_id,user_id,identity,eligible) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,user_id) DO UPDATE SET identity=excluded.identity,eligible=excluded.eligible,refreshed_at=now()",
        [team, user.id, user, eligible(user, c)],
      );
  }
  async notify(
    client: PoolClient,
    team: string,
    key: string,
    target: Record<string, unknown>,
    payload: Record<string, unknown>,
    expires?: Date,
  ) {
    await client.query(
      "INSERT INTO pizza_outbox(id,team_id,notification_key,target,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(team_id,notification_key) DO NOTHING",
      [randomUUID(), team, key, target, payload, expires ?? null],
    );
  }
  async award(
    job: Job,
    a: AwardInput,
    identities: Identity[],
    c: PizzaConfig,
    channelRejection?: string,
  ) {
    return this.tx(async (client) => {
      await this.guard(client, job);
      // Stable message lock prevents distinct event IDs allocating the same message.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${job.team_id}:${a.channel}:${a.ts}`],
      );
      const prior = (
        await client.query(
          "SELECT * FROM pizza_awards WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3",
          [job.team_id, a.channel, a.ts],
        )
      ).rows[0];
      if (prior) {
        await this.complete(client, job, prior.result === "rejected");
        return prior.result;
      }
      const settings = await this.settings(job.team_id, client, "shared");
      await this.identity(client, job.team_id, identities, c);
      const day = localDay(a.ts);
      await client.query(
        "INSERT INTO pizza_daily_usage(team_id,giver_id,local_day,daily_limit) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,giver_id,local_day) DO UPDATE SET daily_limit=excluded.daily_limit",
        [job.team_id, a.giver, day, settings.dailyLimit],
      );
      const used = (
        await client.query(
          "SELECT used FROM pizza_daily_usage WHERE team_id=$1 AND giver_id=$2 AND local_day=$3 FOR UPDATE",
          [job.team_id, a.giver, day],
        )
      ).rows[0].used;
      await client.query(
        "SELECT user_id FROM pizza_users WHERE team_id=$1 AND user_id=ANY($2) ORDER BY user_id FOR UPDATE",
        [job.team_id, [a.giver, ...a.recipients]],
      );
      const reject =
          channelRejection ??
          rejection(
            a.giver,
            a.recipients,
            a.total,
            used,
            identities,
            c,
            settings.dailyLimit,
          ),
        id = randomUUID();
      await client.query(
        "INSERT INTO pizza_awards(id,team_id,channel_id,message_ts,giver_id,local_day,reason,total,result,rejection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          job.team_id,
          a.channel,
          a.ts,
          a.giver,
          day,
          a.reason,
          a.total,
          reject ? "rejected" : "accepted",
          reject,
        ],
      );
      if (!reject) {
        for (const recipient of a.recipients) {
          await client.query(
            "INSERT INTO pizza_award_recipients(team_id,award_id,recipient_id,amount) VALUES($1,$2,$3,$4)",
            [job.team_id, id, recipient, a.amount],
          );
          await client.query(
            "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES($1,$2,'award',$3,$4,$5,$5,$6)",
            [
              job.team_id,
              recipient,
              id,
              a.giver,
              a.amount,
              `award:${id}:${recipient}`,
            ],
          );
          await client.query(
            "UPDATE pizza_users SET earned=earned+$3,balance=balance+$3 WHERE team_id=$1 AND user_id=$2",
            [job.team_id, recipient, a.amount],
          );
        }
        await client.query(
          "UPDATE pizza_daily_usage SET used=used+$4 WHERE team_id=$1 AND giver_id=$2 AND local_day=$3",
          [job.team_id, a.giver, day, a.total],
        );
      }
      const remaining = Math.max(0, settings.dailyLimit - used - a.total);
      await this.notify(
        client,
        job.team_id,
        `award:${id}`,
        reject
          ? { kind: "ephemeral", channel: a.channel, user: a.giver }
          : { kind: "message", channel: a.channel, thread_ts: a.thread },
        {
          text:
            reject ??
            `${a.recipients.map((u) => `<@${u}>`).join(", ")} received ${a.amount} slice${a.amount === 1 ? "" : "s"} each (1 🍕 = 1 slice).\n\n<@${a.giver}> has ${remaining === 0 ? "no more pizzas" : `${remaining} pizza${remaining === 1 ? "" : "s"}`} left to give for ${day} (Asia/Dubai).`,
        },
      );
      await this.complete(client, job, !!reject);
      return reject ? "rejected" : "accepted";
    });
  }
  async balance(team: string, user: string) {
    const row = (
      await this.db.query(
        "SELECT earned,balance FROM pizza_users WHERE team_id=$1 AND user_id=$2",
        [team, user],
      )
    ).rows[0] ?? { earned: 0, balance: 0 };
    const used =
      (
        await this.db.query(
          "SELECT used FROM pizza_daily_usage WHERE team_id=$1 AND giver_id=$2 AND local_day=$3",
          [team, user, localDay()],
        )
      ).rows[0]?.used ?? 0;
    const settings = await this.settings(team);
    return {
      ...row,
      remaining: Math.max(0, settings.dailyLimit - used),
      dailyLimit: settings.dailyLimit,
    } as {
      earned: number;
      balance: number;
      remaining: number;
      dailyLimit: number;
    };
  }
  async leaderboard(
    team: string,
    p: Period,
    mode: "received" | "given" = "received",
  ) {
    const snapshot = await this.celebrationSnapshot(team, p);
    return (mode === "received" ? snapshot.received : snapshot.given).slice(
      0,
      10,
    );
  }
  async celebrationSnapshot(
    team: string,
    p: Period,
  ): Promise<CelebrationSnapshot> {
    const result = (
      await this.db.query(
        `WITH awards AS (
      SELECT * FROM pizza_awards WHERE team_id=$1 AND result='accepted'
        AND ($2::numeric IS NULL OR message_ts::numeric >= $2::numeric)
        AND ($3::numeric IS NULL OR message_ts::numeric < $3::numeric)
    ), recipients AS (SELECT r.* FROM pizza_award_recipients r JOIN awards a ON a.id=r.award_id AND a.team_id=r.team_id),
    received AS (SELECT recipient_id AS user_id,sum(amount)::int AS slices FROM recipients GROUP BY recipient_id),
    given AS (SELECT giver_id AS user_id,sum(total)::int AS slices FROM awards GROUP BY giver_id),
    teammates AS (SELECT a.giver_id AS user_id,count(DISTINCT r.recipient_id)::int AS teammates FROM awards a JOIN recipients r ON r.award_id=a.id GROUP BY a.giver_id),
    people AS (SELECT giver_id AS user_id FROM awards UNION SELECT recipient_id FROM recipients),
    highlights AS (
      SELECT a.id,a.channel_id AS channel,a.message_ts AS ts,chosen.recipient_id AS recipient,a.reason FROM awards a
      JOIN LATERAL (SELECT recipient_id FROM recipients r WHERE r.award_id=a.id ORDER BY md5(r.recipient_id||$4) LIMIT 1) chosen ON true
      WHERE a.reason IS NOT NULL AND length(trim(a.reason))>0 ORDER BY md5(a.id::text||$4),a.id LIMIT 20
    )
    SELECT (SELECT count(*)::int FROM awards) AS messages,COALESCE((SELECT sum(total)::int FROM awards),0) AS slices,
      (SELECT count(*)::int FROM given) AS givers,(SELECT count(*)::int FROM received) AS recipients,(SELECT count(*)::int FROM people) AS participants,
      COALESCE((SELECT jsonb_agg(received ORDER BY slices DESC,user_id) FROM received),'[]') AS received,
      COALESCE((SELECT jsonb_agg(gs ORDER BY slices DESC,user_id) FROM (SELECT given.*,teammates.teammates FROM given JOIN teammates USING(user_id)) gs),'[]') AS given,
      COALESCE((SELECT jsonb_agg(highlights) FROM highlights),'[]') AS highlights`,
        [
          team,
          p.start ? String(p.start.getTime() / 1000) : null,
          p.end ? String(p.end.getTime() / 1000) : null,
          p.key,
        ],
      )
    ).rows[0];
    return {
      ...result,
      received: rankStandings(result.received),
      given: rankStandings(result.given),
    };
  }
  private async pendingAwards(
    client: Pick<PoolClient, "query">,
    team: string,
    p: Period,
  ) {
    return !!(
      await client.query(
        `SELECT 1 FROM pizza_inbox WHERE team_id=$1 AND kind='award' AND status IN('pending','running')
      AND (payload->>'ts')::numeric >= $2::numeric AND (payload->>'ts')::numeric < $3::numeric LIMIT 1`,
        [
          team,
          String(p.start!.getTime() / 1000),
          String(p.end!.getTime() / 1000),
        ],
      )
    ).rowCount;
  }
  async celebrationReady(team: string, p: Period) {
    if (
      (
        await this.db.query(
          "SELECT 1 FROM pizza_celebrations WHERE team_id=$1 AND period_kind=$2 AND period_start=$3",
          [team, p.kind, p.start],
        )
      ).rowCount
    )
      return false;
    return !(await this.pendingAwards(this.db, team, p));
  }
  async queueCelebration(
    team: string,
    p: Period,
    sourceCount: number,
    payload: Record<string, unknown>,
    channel: string,
  ): Promise<boolean> {
    if (p.kind === "all" || !p.start || !p.end || !p.due)
      throw new Refusal("A completed week or month is required.");
    return this.tx(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${team}:celebration-schedule`],
      );
      const settings = await this.settings(team, client, "shared");
      if (
        !(p.kind === "week" ? settings.weeklyEnabled : settings.monthlyEnabled)
      )
        return false;
      if (await this.pendingAwards(client, team, p)) return false;
      const count = (
        await client.query(
          "SELECT count(*)::int count FROM pizza_awards WHERE team_id=$1 AND result='accepted' AND message_ts::numeric >=$2::numeric AND message_ts::numeric <$3::numeric",
          [
            team,
            String(p.start!.getTime() / 1000),
            String(p.end!.getTime() / 1000),
          ],
        )
      ).rows[0].count;
      if (count !== sourceCount) return false; // Award committed while permalink lookup ran: rebuild on the next drain.
      const key = `celebration:${p.key}`;
      const receipt = await client.query(
        "INSERT INTO pizza_celebrations(team_id,period_kind,period_start,period_end,due_at,notification_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING period_start",
        [team, p.kind, p.start, p.end, p.due, key],
      );
      if (!receipt.rowCount) return false;
      await this.notify(
        client,
        team,
        key,
        { kind: "message", channel },
        payload,
      );
      return true;
    });
  }
  async goal(team: string, user: string): Promise<Reward | null> {
    return (
      (
        await this.db.query(
          "SELECT r.* FROM pizza_reward_goals g JOIN pizza_rewards r ON r.team_id=g.team_id AND r.id=g.reward_id WHERE g.team_id=$1 AND g.user_id=$2",
          [team, user],
        )
      ).rows[0] ?? null
    );
  }
  async setGoal(job: Job, actor: Identity, c: PizzaConfig) {
    if (
      !eligible(actor, c) ||
      actor.id !== job.payload.user ||
      job.team_id !== c.team
    )
      throw new Refusal(
        "Only eligible staff can choose their own reward goal.",
      );
    return this.tx(async (client) => {
      await this.guard(client, job);
      let text: string;
      if (job.payload.reward === null) {
        await client.query(
          "DELETE FROM pizza_reward_goals WHERE team_id=$1 AND user_id=$2",
          [job.team_id, actor.id],
        );
        text = "Reward goal cleared. Use /pizza rewards to choose another.";
      } else {
        const r = (
          await client.query(
            "SELECT * FROM pizza_rewards WHERE team_id=$1 AND id=$2 FOR SHARE",
            [job.team_id, job.payload.reward],
          )
        ).rows[0];
        if (!r?.active || r.stock === 0)
          throw new Refusal(
            "Choose an active, available reward from /pizza rewards.",
          );
        await client.query(
          "INSERT INTO pizza_reward_goals(team_id,user_id,reward_id) VALUES($1,$2,$3) ON CONFLICT(team_id,user_id) DO UPDATE SET reward_id=excluded.reward_id,updated_at=now()",
          [job.team_id, actor.id, r.id],
        );
        text = `Now tracking ${escapeSlackText(r.name)} (${r.cost} slices). Use /pizza balance for progress. Tracking does not spend or reserve slices.`;
      }
      const url =
        typeof job.payload.responseUrl === "string"
          ? job.payload.responseUrl
          : null;
      await this.notify(
        client,
        job.team_id,
        `goal:${job.id}`,
        url
          ? { kind: "response", url }
          : {
              kind: "ephemeral",
              channel: job.payload.channel ?? c.recognitionChannel,
              user: actor.id,
            },
        { text },
        url ? new Date(Number(job.payload.responseExpires)) : undefined,
      );
      await this.complete(client, job);
    });
  }
  async settings(
    team: string,
    client: Pick<PoolClient, "query"> = this.db,
    lock?: "shared" | "exclusive",
  ): Promise<PizzaSettings> {
    if (lock)
      await client.query(
        `SELECT pg_advisory_xact_lock${lock === "shared" ? "_shared" : ""}(hashtextextended($1,0))`,
        [`${team}:settings`],
      );
    return settingsFromRow(
      (
        await client.query("SELECT * FROM pizza_settings WHERE team_id=$1", [
          team,
        ])
      ).rows[0],
    );
  }
  private adminIdentity(job: Job, actor: Identity, c: PizzaConfig) {
    if (
      job.team_id !== c.team ||
      actor.id !== job.payload.user ||
      !c.admins.includes(actor.id) ||
      !eligible(actor, c)
    )
      throw new Refusal("Only configured eligible staff admins can do that.");
  }
  async saveSettings(job: Job, actor: Identity, c: PizzaConfig) {
    this.adminIdentity(job, actor, c);
    const { version, values } = job.payload;
    if (
      !Number.isInteger(version) ||
      Number(version) < 0 ||
      !validSettings(values)
    )
      throw new Refusal("Invalid settings values.");
    return this.tx(async (client) => {
      await this.guard(client, job);
      const old = await this.settings(job.team_id, client, "exclusive");
      if (old.version !== version)
        throw new Refusal(
          "Settings changed since this modal opened. Refresh /pizza admin settings and save again.",
        );
      const unchanged = Object.keys(values).every(
        (key) =>
          old[key as keyof SettingsValues] ===
          values[key as keyof SettingsValues],
      );
      if (!unchanged) {
        const next = { ...values, version: old.version + 1 };
        await client.query(
          `INSERT INTO pizza_settings(team_id,version,daily_limit,small_cost,medium_cost,large_cost,weekly_enabled,monthly_enabled)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(team_id) DO UPDATE SET version=excluded.version,daily_limit=excluded.daily_limit,small_cost=excluded.small_cost,medium_cost=excluded.medium_cost,large_cost=excluded.large_cost,weekly_enabled=excluded.weekly_enabled,monthly_enabled=excluded.monthly_enabled`,
          [
            job.team_id,
            next.version,
            next.dailyLimit,
            next.smallCost,
            next.mediumCost,
            next.largeCost,
            next.weeklyEnabled,
            next.monthlyEnabled,
          ],
        );
        await client.query(
          "INSERT INTO pizza_settings_changes(team_id,job_id,actor,old_values,new_values) VALUES($1,$2,$3,$4,$5)",
          [job.team_id, job.id, actor.id, old, next],
        );
      }
      await this.notify(
        client,
        job.team_id,
        `settings:${job.id}`,
        { kind: "ephemeral", channel: c.adminChannel, user: actor.id },
        {
          text: unchanged
            ? "Settings are unchanged; no history entry created."
            : `Settings saved by <@${actor.id}>.\n${settingsSummary({ ...values, version: old.version + 1 })}`,
        },
      );
      await this.complete(client, job);
    });
  }
  async adjustBalance(
    job: Job,
    actor: Identity,
    target: Identity,
    c: PizzaConfig,
  ) {
    this.adminIdentity(job, actor, c);
    const { recipient, delta, reason } = job.payload;
    if (
      recipient !== target.id ||
      !eligible(target, c) ||
      !validAdjustment(delta, reason)
    )
      throw new Refusal(
        "Choose eligible staff, a nonzero integer adjustment and a reason up to 500 characters.",
      );
    const change = Number(delta),
      explanation = String(reason).trim();
    return this.tx(async (client) => {
      await this.guard(client, job);
      await this.identity(client, job.team_id, [target], c);
      const account = (
        await client.query(
          "SELECT balance FROM pizza_users WHERE team_id=$1 AND user_id=$2 FOR UPDATE",
          [job.team_id, target.id],
        )
      ).rows[0];
      const after = account.balance + change;
      if (after < 0 || after > 2147483647)
        throw new Refusal(
          "Adjustment would make available balance negative or exceed its maximum.",
        );
      await client.query(
        "INSERT INTO pizza_balance_adjustments(team_id,job_id,actor,recipient,delta,reason,before_balance,after_balance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          job.team_id,
          job.id,
          actor.id,
          target.id,
          change,
          explanation,
          account.balance,
          after,
        ],
      );
      await client.query(
        "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES($1,$2,'adjustment',$3,$4,0,$5,$6)",
        [
          job.team_id,
          target.id,
          job.id,
          actor.id,
          change,
          `adjustment:${job.id}`,
        ],
      );
      await client.query(
        "UPDATE pizza_users SET balance=$3 WHERE team_id=$1 AND user_id=$2",
        [job.team_id, target.id, after],
      );
      const text = `Balance adjustment ${job.id}\nAdmin: <@${actor.id}> · Recipient: <@${target.id}>\nAvailable slices: ${account.balance} → ${after} (${change > 0 ? "+" : ""}${change}). Earned recognition and giving allowance stay unchanged.`;
      const payload = {
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "section",
            text: { type: "plain_text", text: `Reason: ${explanation}` },
          },
        ],
      };
      await this.notify(
        client,
        job.team_id,
        `adjustment-admin:${job.id}`,
        { kind: "ephemeral", channel: c.adminChannel, user: actor.id },
        payload,
      );
      await this.notify(
        client,
        job.team_id,
        `adjustment-recipient:${job.id}`,
        { kind: "ephemeral", channel: c.recognitionChannel, user: target.id },
        payload,
      );
      await this.complete(client, job);
    });
  }
  async adminHistory(team: string, page = 0) {
    return (
      await this.db.query(
        `SELECT * FROM (
      SELECT job_id,actor,'settings'::text AS kind,created_at,NULL::text AS recipient,NULL::integer AS delta,NULL::text AS reason,NULL::integer AS before_balance,NULL::integer AS after_balance,old_values,new_values FROM pizza_settings_changes WHERE team_id=$1
      UNION ALL SELECT job_id,actor,'adjustment'::text,created_at,recipient,delta,reason,before_balance,after_balance,NULL::jsonb,NULL::jsonb FROM pizza_balance_adjustments WHERE team_id=$1
    ) history ORDER BY created_at DESC,job_id DESC LIMIT 10 OFFSET $2`,
        [team, page * 10],
      )
    ).rows;
  }
  async rewards(team: string, admin = false, page = 0): Promise<Reward[]> {
    return (
      await this.db.query(
        "SELECT * FROM pizza_rewards WHERE team_id=$1 AND ($2::boolean OR active) ORDER BY name,id LIMIT 20 OFFSET $3",
        [team, admin, page * 20],
      )
    ).rows;
  }
  async reward(team: string, id: string): Promise<Reward | null> {
    return (
      (
        await this.db.query(
          "SELECT * FROM pizza_rewards WHERE team_id=$1 AND id=$2",
          [team, id],
        )
      ).rows[0] ?? null
    );
  }
  async intent(
    team: string,
    user: string,
    reward: string,
  ): Promise<{ id: string; reward: Reward; balance: number }> {
    const id = randomUUID();
    // One bounded statement keeps the click-to-modal path inside the trigger lifetime.
    const row = (
      await this.db.query(
        `WITH candidate AS (
      SELECT r.*,COALESCE(u.balance,0) AS available FROM pizza_rewards r LEFT JOIN pizza_users u ON u.team_id=r.team_id AND u.user_id=$2
      WHERE r.team_id=$1 AND r.id=$3 AND r.active AND (r.stock IS NULL OR r.stock>0) AND COALESCE(u.balance,0)>=r.cost
    ), inserted AS (
      INSERT INTO pizza_redemption_intents(id,team_id,user_id,reward_id,confirmed_cost,expires_at)
      SELECT $4,$1,$2,id,cost,now()+interval '15 minutes' FROM candidate RETURNING id
    ) SELECT inserted.id,row_to_json(candidate) AS reward,candidate.available AS balance FROM inserted,candidate`,
        [team, user, reward, id],
      )
    ).rows[0];
    if (!row) throw new Refusal("Reward unavailable or insufficient slices.");
    return row;
  }
  async checkIntent(team: string, user: string, id: string) {
    return !!(
      await this.db.query(
        "SELECT id FROM pizza_redemption_intents WHERE team_id=$1 AND user_id=$2 AND id=$3 AND (expires_at>now() OR redemption_id IS NOT NULL)",
        [team, user, id],
      )
    ).rowCount;
  }
  async redeem(job: Job, user: Identity, c: PizzaConfig) {
    return this.tx(async (client) => {
      await this.guard(client, job);
      const intent = (
        await client.query(
          "SELECT * FROM pizza_redemption_intents WHERE team_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE",
          [job.team_id, user.id, job.payload.intent],
        )
      ).rows[0];
      if (!intent) throw new Refusal("Invalid redemption confirmation.");
      if (intent.redemption_id) {
        await this.complete(client, job);
        return intent.redemption_id as string;
      }
      if (new Date(intent.expires_at).getTime() <= Date.now())
        throw new Refusal("Confirmation expired. Open rewards again.");
      if (!eligible(user, c))
        throw new Refusal("Only eligible staff can redeem rewards.");
      await this.identity(client, job.team_id, [user], c);
      const account = (
        await client.query(
          "SELECT balance FROM pizza_users WHERE team_id=$1 AND user_id=$2 FOR UPDATE",
          [job.team_id, user.id],
        )
      ).rows[0];
      const r = (
        await client.query(
          "SELECT * FROM pizza_rewards WHERE team_id=$1 AND id=$2 FOR UPDATE",
          [job.team_id, intent.reward_id],
        )
      ).rows[0];
      if (!r?.active || r.stock === 0)
        throw new Refusal("This reward is unavailable.");
      if (r.cost !== intent.confirmed_cost)
        throw new Refusal(
          "The price changed. Open rewards and confirm the new price.",
        );
      if (account.balance < r.cost)
        throw new Refusal("You do not have enough slices.");
      const id = randomUUID();
      await client.query(
        "INSERT INTO pizza_redemptions(id,team_id,intent_id,user_id,reward_id,cost,reward_name,description,reserved_stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          job.team_id,
          intent.id,
          user.id,
          r.id,
          r.cost,
          r.name,
          r.description,
          r.stock !== null,
        ],
      );
      await client.query(
        "UPDATE pizza_redemption_intents SET redemption_id=$3 WHERE team_id=$1 AND id=$2",
        [job.team_id, intent.id, id],
      );
      await client.query(
        "UPDATE pizza_users SET balance=balance-$3 WHERE team_id=$1 AND user_id=$2",
        [job.team_id, user.id, r.cost],
      );
      if (r.stock !== null)
        await client.query(
          "UPDATE pizza_rewards SET stock=stock-1 WHERE team_id=$1 AND id=$2",
          [job.team_id, r.id],
        );
      await client.query(
        "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES($1,$2,'redeem',$3,$2,0,$4,$5)",
        [job.team_id, user.id, id, -r.cost, `redeem:${id}`],
      );
      await this.notify(
        client,
        job.team_id,
        `request:${id}`,
        { kind: "message", channel: c.adminChannel },
        {
          text: `Reward request ${id}: <@${user.id}> — ${escapeSlackText(r.name)} (${r.cost} slices)`,
          blocks: redemptionBlocks(id, user.id, r.name, r.cost, r.description),
        },
      );
      await this.notify(
        client,
        job.team_id,
        `receipt:${id}`,
        {
          kind: "ephemeral",
          channel: job.payload.channel ?? c.recognitionChannel,
          user: user.id,
        },
        {
          text: `Request ${id} is pending. ${r.cost} slices deducted. An admin will fulfil it.`,
        },
      );
      await this.complete(client, job);
      return id;
    });
  }
  async adminAction(job: Job, actor: Identity, c: PizzaConfig) {
    if (!c.admins.includes(actor.id) || !eligible(actor, c))
      throw new Refusal("Only configured staff admins can do that.");
    return this.tx(async (client) => {
      await this.guard(client, job);
      // Lock account before redemption/reward for a consistent ordering with redeem.
      const read = (
        await client.query(
          "SELECT * FROM pizza_redemptions WHERE team_id=$1 AND id=$2",
          [job.team_id, job.payload.request],
        )
      ).rows[0];
      if (!read) throw new Refusal("Unknown request.");
      await client.query(
        "SELECT user_id FROM pizza_users WHERE team_id=$1 AND user_id=$2 FOR UPDATE",
        [job.team_id, read.user_id],
      );
      const r = (
        await client.query(
          "SELECT * FROM pizza_redemptions WHERE team_id=$1 AND id=$2 FOR UPDATE",
          [job.team_id, job.payload.request],
        )
      ).rows[0];
      const status =
        job.payload.action === "cancel" ? "cancelled" : "fulfilled";
      if (r.status === "pending") {
        await client.query(
          "UPDATE pizza_redemptions SET status=$3,admin_actor=$4,acted_at=now() WHERE team_id=$1 AND id=$2",
          [job.team_id, r.id, status, actor.id],
        );
        if (status === "cancelled") {
          await client.query(
            "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES($1,$2,'refund',$3,$4,0,$5,$6)",
            [job.team_id, r.user_id, r.id, actor.id, r.cost, `refund:${r.id}`],
          );
          await client.query(
            "UPDATE pizza_users SET balance=balance+$3 WHERE team_id=$1 AND user_id=$2",
            [job.team_id, r.user_id, r.cost],
          );
          if (r.reserved_stock)
            await client.query(
              "UPDATE pizza_rewards SET stock=CASE WHEN stock IS NULL THEN NULL ELSE stock+1 END WHERE team_id=$1 AND id=$2",
              [job.team_id, r.reward_id],
            );
        }
        await this.notify(
          client,
          job.team_id,
          `status:${r.id}`,
          { kind: "message", channel: c.adminChannel },
          {
            text: `Request ${r.id}: ${status} by <@${actor.id}>${status === "cancelled" ? `; ${r.cost} slices refunded` : ""}.`,
          },
        );
        await this.notify(
          client,
          job.team_id,
          `user-status:${r.id}`,
          { kind: "ephemeral", channel: c.recognitionChannel, user: r.user_id },
          {
            text: `Request ${r.id} (${escapeSlackText(r.reward_name)}): ${status}${status === "cancelled" ? `; ${r.cost} slices refunded` : ""}.`,
          },
        );
      }
      await this.complete(client, job);
      return r.status === "pending" ? status : r.status;
    });
  }
  async catalogue(job: Job, actor: Identity, c: PizzaConfig) {
    if (!c.admins.includes(actor.id) || !eligible(actor, c))
      throw new Refusal("Only configured staff admins can edit rewards.");
    return this.tx(async (client) => {
      await this.guard(client, job);
      if (job.payload.action === "archive") {
        const result = await client.query(
          "UPDATE pizza_rewards SET active=$3 WHERE team_id=$1 AND id=$2 RETURNING id",
          [job.team_id, job.payload.reward, job.payload.active === true],
        );
        if (!result.rowCount) throw new Refusal("Unknown reward.");
      } else {
        const { name, cost, description, stock } = job.payload;
        const tier = job.payload.tier ?? null;
        if (
          (tier !== null && !isTier(tier)) ||
          typeof name !== "string" ||
          !name.trim() ||
          name.length > 100 ||
          !Number.isInteger(cost) ||
          Number(cost) <= 0 ||
          Number(cost) > 1000000 ||
          typeof description !== "string" ||
          description.length > 2000 ||
          !(
            stock === null ||
            (Number.isInteger(stock) &&
              Number(stock) >= 0 &&
              Number(stock) <= 1000000)
          )
        )
          throw new Refusal("Invalid reward values.");
        if (job.payload.reward === "new")
          await client.query(
            "INSERT INTO pizza_rewards(id,team_id,name,cost,description,stock,tier) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              job.team_id,
              name.trim(),
              cost,
              description,
              stock,
              tier,
            ],
          );
        else {
          const result = await client.query(
            "UPDATE pizza_rewards SET name=$3,cost=$4,description=$5,stock=$6,tier=$7 WHERE team_id=$1 AND id=$2 RETURNING id",
            [
              job.team_id,
              job.payload.reward,
              name.trim(),
              cost,
              description,
              stock,
              tier,
            ],
          );
          if (!result.rowCount) throw new Refusal("Unknown reward.");
        }
      }
      await this.notify(
        client,
        job.team_id,
        `catalogue:${job.id}`,
        { kind: "ephemeral", channel: c.adminChannel, user: actor.id },
        { text: "Reward catalogue updated. Use /pizza admin to refresh." },
      );
      await this.complete(client, job);
    });
  }
  async finish(
    job: Job,
    payload?: Record<string, unknown>,
    reject = false,
    namespace: "result" | "preview" = "result",
  ) {
    return this.tx(async (client) => {
      await this.guard(client, job);
      if (payload) {
        const url =
          typeof job.payload.responseUrl === "string"
            ? job.payload.responseUrl
            : null;
        await this.notify(
          client,
          job.team_id,
          `${namespace}:${job.id}`,
          url
            ? { kind: "response", url }
            : {
                kind: "ephemeral",
                channel: job.payload.channel,
                user: job.payload.user,
              },
          payload,
          url ? new Date(Number(job.payload.responseExpires)) : undefined,
        );
      }
      await this.complete(client, job, reject);
    });
  }
  async interactionFeedback(
    team: string,
    key: string,
    user: string,
    channel: string,
    url: string | null,
    text: string,
  ) {
    await this.db.query(
      "INSERT INTO pizza_outbox(id,team_id,notification_key,target,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(team_id,notification_key) DO NOTHING",
      [
        randomUUID(),
        team,
        key,
        url ? { kind: "response", url } : { kind: "ephemeral", channel, user },
        { text },
        url ? new Date(Date.now() + 25 * 60_000) : null,
      ],
    );
  }
  async adminState(team: string, page = 0) {
    const requests = (
      await this.db.query(
        "SELECT * FROM pizza_redemptions WHERE team_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 10 OFFSET $2",
        [team, page * 10],
      )
    ).rows;
    const deliveries = (
      await this.db.query(
        "SELECT id,notification_key,safe_error,external_ref FROM pizza_outbox WHERE team_id=$1 AND status='ambiguous' ORDER BY created_at,id LIMIT 10 OFFSET $2",
        [team, page * 10],
      )
    ).rows;
    return { requests, deliveries };
  }
  async invalidate(team: string, user: string) {
    await this.db.query(
      "UPDATE pizza_users SET refreshed_at='epoch',eligible=false WHERE team_id=$1 AND user_id=$2",
      [team, user],
    );
  }
  async delivered(job: Outbox, ref?: string, status = "sent", error?: string) {
    await this.db.query(
      "UPDATE pizza_outbox SET status=$4,sent_at=CASE WHEN $4='sent' THEN now() ELSE NULL END,external_ref=$5,safe_error=$6,lease_owner=null,lease_until=null,target=CASE WHEN target->>'kind'='response' THEN NULL ELSE target END WHERE id=$1 AND team_id=$2 AND lease_owner=$3 AND status='running'",
      [
        job.id,
        job.team_id,
        job.lease_owner,
        status,
        ref ?? null,
        error ?? null,
      ],
    );
    if (job.target?.kind === "response")
      await this.db.query(
        "UPDATE pizza_inbox SET payload=payload-'responseUrl' WHERE team_id=$1 AND id::text=$2",
        [
          job.team_id,
          job.notification_key?.replace(/^(result|goal|preview):/, "") ?? "",
        ],
      );
  }
  async maintenance(team: string) {
    await this.db.query(
      "UPDATE pizza_outbox SET payload=jsonb_build_object('text','Celebration content removed after 30 days.') WHERE team_id=$1 AND (notification_key LIKE 'celebration:%' OR notification_key LIKE 'preview:%') AND status IN('sent','expired','ambiguous') AND created_at<now()-interval '30 days' AND payload ? 'blocks'",
      [team],
    );

    await this.db.query(
      "UPDATE pizza_inbox SET payload=NULL WHERE team_id=$1 AND status IN('complete','rejected') AND completed_at<now()-interval '30 days' AND payload IS NOT NULL",
      [team],
    );
    await this.db.query(
      "UPDATE pizza_inbox SET payload=payload-'responseUrl' WHERE team_id=$1 AND payload ? 'responseUrl' AND (payload->>'responseExpires')::bigint<$2",
      [team, Date.now()],
    );
    await this.db.query(
      "UPDATE pizza_awards SET reason=NULL WHERE team_id=$1 AND created_at<now()-interval '30 days' AND reason IS NOT NULL",
      [team],
    );
    await this.db.query(
      "UPDATE pizza_outbox SET status='expired',target=null,lease_owner=null,lease_until=null WHERE team_id=$1 AND status IN('pending','running') AND expires_at<now()",
      [team],
    );
  }
}
