import { beforeEach, describe, it, expect, vi } from "vitest";
import { processJob, processDelivery, drain } from "./worker";
import { PizzaStore, type Job, type Outbox, Refusal } from "./store";
import { PizzaSlack, SlackTransient } from "./slack";
import { config } from "./config";
const c = config({
  PIZZA_ENABLED: "true",
  PIZZA_BOT_TOKEN: "xoxb-test",
  PIZZA_SIGNING_SECRET: "s".repeat(32),
  PIZZA_TEAM_ID: "T1",
  PIZZA_APP_ID: "A1",
  PIZZA_RECOGNITION_CHANNEL_ID: "C1",
  PIZZA_ADMIN_CHANNEL_ID: "G2",
  PIZZA_ADMIN_USER_IDS: "U9",
  PIZZA_WORKER_SECRET: "w".repeat(32),
})!;
const fixtures = () => {
  const storage = {
    retry: vi.fn(),
    finish: vi.fn(),
    award: vi.fn(),
    redeem: vi.fn(),
    adminAction: vi.fn(),
    catalogue: vi.fn(),
    delivered: vi.fn(),
    claim: vi.fn().mockResolvedValue(null),
    maintenance: vi.fn(),
    balance: vi
      .fn()
      .mockResolvedValue({ earned: 10, balance: 3, remaining: 4 }),
    rewards: vi.fn().mockResolvedValue([]),
    adminState: vi.fn().mockResolvedValue({ requests: [], deliveries: [] }),
  };
  const api = {
    identity: vi.fn().mockResolvedValue({ id: "U2", team_id: "T1" }),
    channel: vi.fn().mockResolvedValue(true),
    deliver: vi.fn().mockResolvedValue("123"),
    invalidate: vi.fn(),
  };
  return {
    storage,
    api,
    s: storage as unknown as PizzaStore,
    slack: api as unknown as PizzaSlack,
  };
};
const j = {
  id: "job",
  team_id: "T1",
  lease_owner: "owner",
  attempts: 1,
  kind: "command",
  payload: { user: "U2", channel: "C1", text: "balance" },
} satisfies Job;
describe("recoverable worker", () => {
  it("does not mutate when disabled; still drains committed outbox", async () => {
    const f = fixtures();
    await processJob(f.s, f.slack, { ...c, enabled: false }, j);
    expect(f.storage.retry).toHaveBeenCalledWith(
      "pizza_inbox",
      j,
      60,
      "disabled",
    );
    expect(f.storage.finish).not.toHaveBeenCalled();
    await drain(f.s, f.slack, { ...c, enabled: false });
    expect(f.storage.claim).toHaveBeenCalledWith("pizza_outbox", "T1");
    expect(f.storage.claim).not.toHaveBeenCalledWith("pizza_inbox", "T1");
  });
  it("unknown identity retries without allocation", async () => {
    const f = fixtures();
    f.api.identity.mockRejectedValue(new SlackTransient("identity_unknown"));
    await processJob(f.s, f.slack, c, j);
    expect(f.storage.retry).toHaveBeenCalled();
    expect(f.storage.finish).not.toHaveBeenCalled();
    expect(f.storage.award).not.toHaveBeenCalled();
  });
  it("validates identity/channel before entering award transaction, shared/private channel rejects entirely", async () => {
    const f = fixtures(),
      a = {
        ...j,
        kind: "award",
        payload: { giver: "U1", recipients: ["U2"], channel: "C1" },
      };
    f.api.channel.mockResolvedValue(false);
    await processJob(f.s, f.slack, c, a);
    expect(f.api.identity).toHaveBeenCalledTimes(2);
    expect(f.storage.award).toHaveBeenCalledWith(
      a,
      a.payload,
      expect.any(Array),
      c,
      expect.stringMatching(/public internal/),
    );
  });
  it("balance is private and distinguishes earned, spendable and giving", async () => {
    const f = fixtures();
    await processJob(f.s, f.slack, c, j);
    expect(f.storage.finish).toHaveBeenCalledWith(j, {
      text: expect.stringMatching(
        /Lifetime earned: 10.*\nAvailable to spend: 3.*\nLeft to give today: 4\/5/,
      ),
    });
  });
  it("refusal becomes durable private feedback; transient DB/Slack failures retry", async () => {
    const f = fixtures();
    f.api.identity.mockResolvedValue({
      id: "U2",
      team_id: "T1",
      deleted: true,
    } as never);
    await processJob(f.s, f.slack, c, j);
    expect(f.storage.finish).toHaveBeenCalledWith(
      j,
      { text: expect.any(String) },
      true,
    );
  });
  it("429 respects Retry-After without repeating accounting; ambiguous posts are exposed", async () => {
    const f = fixtures(),
      o = {
        ...j,
        target: { kind: "message", channel: "C1" },
        expires_at: null,
        notification_key: "request:123",
      } as Outbox;
    f.api.deliver.mockRejectedValue(new SlackTransient("rate_limited", 43));
    await processDelivery(f.s, f.slack, o);
    expect(f.storage.retry).toHaveBeenCalledWith(
      "pizza_outbox",
      o,
      43,
      "rate_limited",
    );
    expect(f.storage.redeem).not.toHaveBeenCalled();
    f.api.deliver.mockRejectedValue(
      new SlackTransient("slack_delivery_ambiguous", 5, true),
    );
    await processDelivery(f.s, f.slack, o);
    expect(f.storage.delivered).toHaveBeenCalledWith(
      o,
      undefined,
      "ambiguous",
      "slack_delivery_ambiguous",
    );
  });
  it("admin exposes pending action buttons and ambiguous notification records", async () => {
    const f = fixtures();
    f.api.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    f.storage.adminState.mockResolvedValue({
      requests: [
        {
          id: "request",
          user_id: "U2",
          reward_name: "Lunch",
          cost: 2,
          description: "manual",
        },
      ],
      deliveries: [
        {
          id: "outbox",
          notification_key: "request:request",
          safe_error: "slack_delivery_ambiguous",
        },
      ],
    } as never);
    const admin = { ...j, payload: { user: "U9", text: "admin" } };
    await processJob(f.s, f.slack, c, admin);
    const result = f.storage.finish.mock.calls[0][1];
    expect(JSON.stringify(result)).toMatch(/pizza_fulfill/);
    expect(JSON.stringify(result)).toMatch(/pizza_cancel/);
    expect(JSON.stringify(result)).toMatch(/Ambiguous delivery outbox/);
  });
});
