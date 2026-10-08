import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { PizzaSlack, SlackTransient, validPermalink } from "./slack";
import { config } from "./config";
import { type Outbox } from "./store";
const mock = vi.hoisted(() => ({
  user: vi.fn(),
  channel: vi.fn(),
  post: vi.fn(),
  ephemeral: vi.fn(),
  modal: vi.fn(),
  permalink: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    constructor(...args: unknown[]) {
      mock.constructor(...args);
    }
    users = { info: mock.user };
    conversations = { info: mock.channel };
    chat = {
      postMessage: mock.post,
      postEphemeral: mock.ephemeral,
      getPermalink: mock.permalink,
    };
    views = { open: mock.modal };
  },
}));
const c = config({
  PIZZA_ENABLED: "true",
  PIZZA_BOT_TOKEN: "xoxb-pizza",
  PIZZA_SIGNING_SECRET: "s".repeat(32),
  PIZZA_TEAM_ID: "T1",
  PIZZA_APP_ID: "A1",
  PIZZA_RECOGNITION_CHANNEL_ID: "C1",
  PIZZA_ADMIN_CHANNEL_ID: "G2",
  PIZZA_ADMIN_USER_IDS: "U9",
  PIZZA_WORKER_SECRET: "w".repeat(32),
})!;
beforeEach(() => {
  vi.resetAllMocks();
  mock.user.mockResolvedValue({ user: { id: "U1", team_id: "T1" } });
  mock.channel.mockResolvedValue({
    channel: { is_member: true, is_private: false },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("dedicated bounded Slack client", () => {
  it("fresh adjustment identity bypasses cached membership", async () => {
    const api = new PizzaSlack(c);
    expect((await api.identity("U1")).is_restricted).toBeUndefined();
    mock.user.mockResolvedValue({
      user: { id: "U1", team_id: "T1", is_restricted: true },
    });
    expect((await api.identity("U1")).is_restricted).toBeUndefined();
    expect((await api.identity("U1", true)).is_restricted).toBe(true);
    expect(mock.user).toHaveBeenCalledTimes(2);
  });

  it("uses only PizzaBot token with zero internal retries and bounded calls", () => {
    new PizzaSlack(c);
    expect(mock.constructor).toHaveBeenCalledWith(
      c.token,
      expect.objectContaining({
        timeout: 600,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      }),
    );
  });
  it("caches identities for 30 seconds, bounds cache, invalidates changes and retries unknown users", async () => {
    vi.useFakeTimers();
    const api = new PizzaSlack(c);
    await api.identity("U1");
    await api.identity("U1");
    expect(mock.user).toHaveBeenCalledTimes(1);
    api.invalidate("U1");
    await api.identity("U1");
    expect(mock.user).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30001);
    await api.identity("U1");
    expect(mock.user).toHaveBeenCalledTimes(3);
    mock.user.mockResolvedValue({ user: { id: "U2" } });
    await expect(api.identity("U2")).rejects.toBeInstanceOf(SlackTransient);
  });
  it("strictly rejects private/shared/archived/non-member recognition channels but permits private admin channel", async () => {
    for (const changes of [
      { is_private: true },
      { is_shared: true },
      { is_ext_shared: true },
      { is_org_shared: true },
      { is_archived: true },
      { is_member: false },
    ]) {
      const api = new PizzaSlack(c);
      mock.channel.mockResolvedValue({
        channel: { is_member: true, is_private: false, ...changes },
      });
      expect(await api.channel("C1", true)).toBe(false);
    }
    mock.channel.mockResolvedValue({
      channel: { is_private: true, is_member: true },
    });
    expect(await new PizzaSlack(c).channel("G2", false)).toBe(true);
  });
  it("validates Slack message permalinks, including threads, and omits deleted/unavailable links", async () => {
    const url =
      "https://gr.slack.com/archives/C1/p1791489600000001?thread_ts=1791489500.000001&cid=C1";
    expect(validPermalink(url, "C1")).toBe(url);
    for (const invalid of [
      "https://evil.example/archives/C1/p1",
      "http://gr.slack.com/archives/C1/p1",
      "https://gr.slack.com/archives/C2/p1",
      "https://user@gr.slack.com/archives/C1/p1",
      "https://gr.slack.com/archives/C1/p1|bad",
    ])
      expect(validPermalink(invalid, "C1")).toBeNull();
    const api = new PizzaSlack(c);
    mock.permalink.mockResolvedValue({ permalink: url });
    expect(await api.permalink("C1", "1791489600.000001")).toBe(url);
    expect(mock.permalink).toHaveBeenCalledWith({
      channel: "C1",
      message_ts: "1791489600.000001",
    });
    mock.permalink.mockRejectedValue({ data: { error: "message_not_found" } });
    expect(await api.permalink("C1", "1791489600.000001")).toBeNull();
  });
  it("response delivery rejects redirects and sends private responses, honours rate-limit delay", async () => {
    const api = new PizzaSlack(c),
      fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const o = {
      id: "id",
      target: {
        kind: "response",
        url: "https://hooks.slack.com/actions/T1/secret",
      },
      payload: { text: "balance" },
    } as unknown as Outbox;
    await api.deliver(o);
    expect(fetcher).toHaveBeenCalledWith(
      o.target.url,
      expect.objectContaining({
        redirect: "error",
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: false,
          text: "balance",
        }),
      }),
    );
    fetcher.mockResolvedValue(
      new Response("", { status: 429, headers: { "Retry-After": "43" } }),
    );
    await expect(api.deliver(o)).rejects.toMatchObject({
      delay: 43,
      ambiguous: false,
    });
  });
  it("withholds committed notifications if the configured channel becomes shared", async () => {
    mock.channel.mockResolvedValue({
      channel: { is_member: true, is_private: true, is_ext_shared: true },
    });
    const api = new PizzaSlack(c);
    await expect(
      api.deliver({
        id: "id",
        target: { kind: "message", channel: "G2" },
        payload: { text: "private reward request" },
      } as unknown as Outbox),
    ).rejects.toMatchObject({
      code: "delivery_channel_unavailable",
      ambiguous: false,
    });
    expect(mock.post).not.toHaveBeenCalled();
  });
  it("distinguishes retryable outage from ambiguous post timeout", async () => {
    mock.post.mockRejectedValue({
      code: "slack_webapi_request_error",
      message: "ETIMEDOUT",
    });
    const api = new PizzaSlack(c),
      o = {
        id: "id",
        target: { kind: "message", channel: "C1" },
        payload: { text: "message" },
      } as unknown as Outbox;
    await expect(api.deliver(o)).rejects.toMatchObject({ ambiguous: true });
    expect(mock.post).toHaveBeenCalledWith(
      expect.objectContaining({ client_msg_id: "id" }),
    );
    mock.user.mockRejectedValue({
      code: "slack_webapi_request_error",
      message: "timeout",
    });
    await expect(api.identity("U1")).rejects.toMatchObject({
      ambiguous: false,
    });
  });
});
