import { WebClient } from "@slack/web-api";
import { type PizzaConfig } from "./config";
import { type Identity } from "./policy";
import { responseUrl } from "./security";
import { Refusal, type Outbox } from "./store";
export class SlackTransient extends Error {
  constructor(
    readonly code: string,
    readonly delay = 5,
    readonly ambiguous = false,
  ) {
    super(code);
  }
}
export class PizzaSlack {
  readonly client: WebClient;
  private users = new Map<string, { user: Identity; expires: number }>();
  private channels = new Map<string, { allowed: boolean; expires: number }>();
  constructor(readonly c: PizzaConfig) {
    this.client = new WebClient(c.token, {
      timeout: 600,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  }
  invalidate(id: string) {
    this.users.delete(id);
  }
  async identity(id: string): Promise<Identity> {
    const cached = this.users.get(id);
    if (cached && cached.expires > Date.now()) return cached.user;
    let result;
    try {
      result = await this.client.users.info({ user: id });
    } catch (e) {
      throw slackFailure(e);
    }
    if (!result.user || result.user.id !== id || !result.user.team_id)
      throw new SlackTransient("identity_unknown");
    const user = result.user as Identity;
    // Small bounded cache, with short expiry and explicit user_change invalidation.
    if (this.users.size >= 200)
      this.users.delete(this.users.keys().next().value!);
    this.users.set(id, { user, expires: Date.now() + 30_000 });
    return user;
  }
  async channel(id: string, recognition: boolean): Promise<boolean> {
    const key = `${id}:${recognition}`,
      cached = this.channels.get(key);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    let result;
    try {
      result = await this.client.conversations.info({ channel: id });
    } catch (e) {
      throw slackFailure(e);
    }
    if (!result.channel) throw new SlackTransient("channel_unknown");
    const ch = result.channel,
      allowed =
        !ch.is_archived &&
        !ch.is_shared &&
        !ch.is_ext_shared &&
        !ch.is_org_shared &&
        ch.is_member === true &&
        (!recognition || ch.is_private === false);
    this.channels.set(key, { allowed, expires: Date.now() + 30_000 });
    return allowed;
  }
  async modal(trigger: string, view: unknown) {
    try {
      await this.client.views.open({
        trigger_id: trigger,
        view: view as Parameters<WebClient["views"]["open"]>[0]["view"],
      });
    } catch (e) {
      throw slackFailure(e);
    }
  }
  async permalink(channel: string, timestamp: string): Promise<string | null> {
    try {
      const result = await this.client.chat.getPermalink({
        channel,
        message_ts: timestamp,
      });
      return validPermalink(result.permalink, channel);
    } catch {
      return null;
    } // Deleted/stale/rate-limited highlights never block the recap.
  }
  async deliver(job: Outbox): Promise<string | undefined> {
    const target = job.target;
    if (!target) throw new Refusal("No delivery target.");
    if (target.kind === "response") {
      const url = responseUrl(target.url);
      if (!url) throw new Refusal("Invalid response capability.");
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            replace_original: false,
            ...job.payload,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(2500),
        });
      } catch {
        throw new SlackTransient("response_delivery_ambiguous", 5, true);
      }
      if (response.status === 429)
        throw new SlackTransient(
          "rate_limited",
          Number(response.headers.get("Retry-After")) || 30,
        );
      if (response.status >= 500) throw new SlackTransient("slack_unavailable");
      if (!response.ok)
        throw new Refusal("Response capability expired or unavailable.");
      return undefined;
    }
    // Revalidate configured delivery channels after a retry or deployment too.
    // An accepted operation never authorises disclosure to a later shared channel.
    if (
      target.channel === this.c.recognitionChannel ||
      target.channel === this.c.adminChannel
    ) {
      if (
        !(await this.channel(
          target.channel,
          target.channel === this.c.recognitionChannel,
        ))
      )
        throw new SlackTransient("delivery_channel_unavailable", 60);
    } else if (target.kind === "message") {
      throw new Refusal("Unexpected channel delivery target.");
    }
    try {
      if (target.kind === "ephemeral") {
        const result = await this.client.chat.postEphemeral({
          channel: target.channel!,
          user: target.user!,
          ...job.payload,
        } as Parameters<WebClient["chat"]["postEphemeral"]>[0]);
        return result.message_ts;
      }
      const result = await this.client.chat.postMessage({
        channel: target.channel!,
        thread_ts: target.thread_ts,
        client_msg_id: job.id,
        ...job.payload,
      } as unknown as Parameters<WebClient["chat"]["postMessage"]>[0]);
      return result.ts;
    } catch (e) {
      throw slackFailure(e, true);
    }
  }
}
export function slackFailure(error: unknown, delivery = false): SlackTransient {
  const e = error as {
    code?: string;
    retryAfter?: number;
    data?: { error?: string };
    message?: string;
  };
  if (
    e.code === "slack_webapi_rate_limited_error" ||
    e.data?.error === "ratelimited"
  )
    return new SlackTransient("rate_limited", e.retryAfter ?? 30);
  const ambiguous =
    delivery &&
    (e.code === "slack_webapi_request_error" ||
      /timeout|ETIMEDOUT|ECONNRESET/i.test(e.message ?? ""));
  return new SlackTransient(
    ambiguous ? "slack_delivery_ambiguous" : "slack_unavailable",
    5,
    ambiguous,
  );
}
let cached: { token: string; slack: PizzaSlack } | undefined;
export function slack(c: PizzaConfig) {
  if (!cached || cached.token !== c.token)
    cached = { token: c.token, slack: new PizzaSlack(c) };
  return cached.slack;
}

export function validPermalink(value: unknown, channel: string): string | null {
  if (typeof value !== "string" || /[<>|\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9-]+\.(slack\.com|slack-gov\.com)$/i.test(url.hostname) &&
      new RegExp(`^/archives/${channel}/p[0-9]+$`).test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
