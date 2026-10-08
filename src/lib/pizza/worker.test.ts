import { beforeEach, describe, it, expect, vi } from "vitest";
import { processJob, processDelivery, drain } from "./worker";
import { PizzaStore, type Job, type Outbox, Refusal } from "./store";
import { PizzaSlack, SlackTransient } from "./slack";
import { DEFAULT_SETTINGS } from "./settings";
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
    settings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    saveSettings: vi.fn(),
    adjustBalance: vi.fn(),
    adminHistory: vi.fn().mockResolvedValue([]),
    retry: vi.fn(),
    finish: vi.fn(),
    award: vi.fn(),
    redeem: vi.fn(),
    adminAction: vi.fn(),
    catalogue: vi.fn(),
    delivered: vi.fn(),
    claim: vi.fn().mockResolvedValue(null),
    maintenance: vi.fn(),
    balance: vi.fn().mockResolvedValue({
      earned: 10,
      balance: 3,
      remaining: 4,
      dailyLimit: 5,
    }),
    goal: vi.fn().mockResolvedValue(null),
    setGoal: vi.fn(),
    celebrationSnapshot: vi.fn().mockResolvedValue({
      received: [],
      given: [],
      messages: 0,
      slices: 0,
      givers: 0,
      recipients: 0,
      participants: 0,
      highlights: [],
    }),
    queueCelebration: vi.fn(),
    leaderboard: vi
      .fn<
        (
          ...args: unknown[]
        ) => Promise<
          { user_id: string; slices: number; teammates: number; rank: number }[]
        >
      >()
      .mockResolvedValue([]),
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
    expect(f.storage.finish).toHaveBeenCalledWith(
      j,
      expect.objectContaining({
        text: expect.stringMatching(
          /Lifetime earned: 10 slices.*\nAvailable to spend: 3 slices.*\nLeft to give today: 4\/5/,
        ),
      }),
    );
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
  it("current admin previews remain private and create no scheduling receipt", async () => {
    const f = fixtures();
    f.api.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    const preview = {
      ...j,
      payload: { user: "U9", channel: "G2", text: "admin preview week" },
    };
    await processJob(
      f.s,
      f.slack,
      {
        ...c,
        celebrationsEnabled: true,
        celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
      },
      preview,
    );
    expect(f.storage.finish).toHaveBeenCalledWith(
      preview,
      expect.objectContaining({
        text: expect.stringContaining("Private current week preview"),
      }),
      false,
      "preview",
    );
    expect(f.storage.queueCelebration).not.toHaveBeenCalled();
    const denied = {
      ...j,
      payload: { user: "U2", text: "admin preview month" },
    };
    await processJob(f.s, f.slack, c, denied);
    expect(f.storage.finish).toHaveBeenCalledWith(
      denied,
      { text: expect.stringMatching(/Only configured admins/) },
      true,
    );
  });
  it("goal jobs bind the authenticated user", async () => {
    const f = fixtures(),
      goal = { ...j, kind: "goal", payload: { user: "U2", reward: "reward" } };
    await processJob(f.s, f.slack, c, goal);
    expect(f.storage.setGoal).toHaveBeenCalledWith(
      goal,
      { id: "U2", team_id: "T1" },
      c,
    );
  });
  it("leaderboard commands preserve defaults, route week/given and reject invalid arguments privately", async () => {
    const f = fixtures();
    const command = (text: string) => ({ ...j, payload: { user: "U2", text } });
    await processJob(f.s, f.slack, c, command("leaderboard"));
    expect(f.storage.leaderboard).toHaveBeenLastCalledWith(
      "T1",
      expect.objectContaining({ kind: "month" }),
      "received",
    );
    expect(f.storage.finish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: expect.stringContaining("Received recognition leaderboard"),
      }),
    );
    f.storage.leaderboard.mockResolvedValue([
      { user_id: "U1", slices: 5, teammates: 2, rank: 1 },
      { user_id: "U3", slices: 5, teammates: 3, rank: 1 },
      { user_id: "U4", slices: 2, teammates: 1, rank: 3 },
    ]);
    await processJob(f.s, f.slack, c, command("leaderboard week given"));
    expect(f.storage.leaderboard).toHaveBeenLastCalledWith(
      "T1",
      expect.objectContaining({
        kind: "week",
        label: expect.stringContaining("Asia/Dubai (end exclusive)"),
      }),
      "given",
    );
    expect(f.storage.finish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: expect.stringContaining(
          "1. <@U1> — 5 slices · 2 teammates thanked\n1. <@U3> — 5 slices · 3 teammates thanked\n3. <@U4> — 2 slices · 1 teammates thanked",
        ),
      }),
    );
    f.storage.leaderboard.mockClear();
    for (const text of ["leaderboard year given", "leaderboard week spent"]) {
      const invalid = command(text);
      await processJob(f.s, f.slack, c, invalid);
      expect(f.storage.finish).toHaveBeenLastCalledWith(
        invalid,
        { text: expect.stringContaining("Use /pizza leaderboard") },
        true,
      );
    }
    expect(f.storage.leaderboard).not.toHaveBeenCalled();
  });
  it("settings/adjustment jobs freshly validate actor and recipient; stale/refused changes remain private in the admin channel", async () => {
    const f = fixtures(),
      settingsJob = {
        ...j,
        kind: "settings",
        payload: { user: "U9", channel: "G2", version: 0, values: {} },
      };
    f.api.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    f.storage.saveSettings.mockRejectedValue(
      new Refusal("Settings changed; refresh"),
    );
    await processJob(f.s, f.slack, c, settingsJob);
    expect(f.api.identity).toHaveBeenCalledWith("U9", true);
    expect(f.storage.finish).toHaveBeenCalledWith(
      settingsJob,
      { text: expect.stringContaining("refresh") },
      true,
    );
    f.api.identity.mockImplementation(async (id: string) => ({
      id,
      team_id: "T1",
      ...(id === "U2" ? { is_bot: true } : {}),
    }));
    const adjustment = {
      ...j,
      kind: "adjustment",
      payload: {
        user: "U9",
        channel: "G2",
        recipient: "U2",
        delta: 3,
        reason: "Correction",
      },
    };
    // Store independently rejects the freshly passed ineligible identity.
    f.storage.adjustBalance.mockRejectedValue(
      new Refusal("Choose eligible staff"),
    );
    await processJob(f.s, f.slack, c, adjustment);
    expect(f.api.identity).toHaveBeenCalledWith("U2", true);
    expect(f.storage.adjustBalance).toHaveBeenCalledWith(
      adjustment,
      { id: "U9", team_id: "T1" },
      { id: "U2", team_id: "T1", is_bot: true },
      c,
    );
    const unprivileged = {
      ...adjustment,
      payload: { ...adjustment.payload, user: "U3" },
    };
    f.storage.adjustBalance.mockClear();
    await processJob(f.s, f.slack, c, unprivileged);
    expect(f.storage.adjustBalance).not.toHaveBeenCalled();
  });
  it("commands reflect changed limit/presets and expose private paginated history and admin controls", async () => {
    const f = fixtures();
    f.storage.settings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dailyLimit: 12,
      smallCost: 20,
    });
    f.storage.balance.mockResolvedValue({
      earned: 10,
      balance: 3,
      remaining: 8,
      dailyLimit: 12,
    });
    await processJob(f.s, f.slack, c, j);
    expect(JSON.stringify(f.storage.finish.mock.calls[0][1])).toContain(
      "8/12 🍕",
    );
    expect(JSON.stringify(f.storage.finish.mock.calls[0][1])).toContain(
      "Small 20 slices",
    );
    await processJob(f.s, f.slack, c, {
      ...j,
      payload: { user: "U2", text: "help" },
    });
    expect(f.storage.finish.mock.calls[1][1].text).toContain("12 to give");
    f.api.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    const admin = (text: string) => ({ ...j, payload: { user: "U9", text } });
    await processJob(f.s, f.slack, c, admin("admin"));
    expect(JSON.stringify(f.storage.finish.mock.calls[2][1])).toContain(
      "pizza_settings",
    );
    expect(JSON.stringify(f.storage.finish.mock.calls[2][1])).toContain(
      "pizza_adjust",
    );
    await processJob(f.s, f.slack, c, admin("admin settings"));
    expect(JSON.stringify(f.storage.finish.mock.calls[3][1])).toContain(
      "Daily giving limit: 12",
    );
    await processJob(f.s, f.slack, c, admin("admin history 2"));
    expect(f.storage.adminHistory).toHaveBeenCalledWith("T1", 2);
    expect(f.storage.finish.mock.calls[4][1]).toMatchObject({
      text: "Private admin history",
    });
    f.api.identity.mockResolvedValue({ id: "U2", team_id: "T1" });
    f.storage.adminHistory.mockClear();
    const denied = { ...j, payload: { user: "U2", text: "admin history" } };
    await processJob(f.s, f.slack, c, denied);
    expect(f.storage.adminHistory).not.toHaveBeenCalled();
    expect(f.storage.finish).toHaveBeenLastCalledWith(
      denied,
      { text: expect.any(String) },
      true,
    );
  });
});
