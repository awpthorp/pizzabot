import { describe, it, expect, vi } from "vitest";
import {
  celebrationPayload,
  celebrationText,
  linkedHighlights,
  scheduleCelebrations,
  type CelebrationSnapshot,
} from "./celebrations";
import { DEFAULT_SETTINGS } from "./settings";
import { period } from "./periods";
import { config } from "./config";
import type { PizzaStore } from "./store";
import type { PizzaSlack } from "./slack";
const empty: CelebrationSnapshot = {
  messages: 0,
  slices: 0,
  givers: 0,
  recipients: 0,
  participants: 0,
  received: [],
  given: [],
  highlights: [],
};
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
const week = period("week", new Date("2026-10-08T10:00:00Z"));
describe("celebrations without fabrication", () => {
  it("has a supportive empty recap without standings or invented highlights", () => {
    const text = celebrationText(week, empty);
    expect(text).toContain("No recognition this period");
    expect(text).not.toContain("champion");
    expect(text).not.toContain("highlight");
  });
  it("counts all champions/co-givers and preserves shared podium ranks", () => {
    const data = {
      ...empty,
      messages: 2,
      slices: 5,
      received: [
        { user_id: "U1", slices: 2, rank: 1 },
        { user_id: "U2", slices: 2, rank: 1 },
        { user_id: "U3", slices: 1, rank: 3 },
      ],
      given: [{ user_id: "U4", slices: 5, rank: 1, teammates: 3 }],
      givers: 1,
      recipients: 3,
      participants: 4,
    };
    const text = celebrationText(week, data);
    expect(text).toContain("co-winners: 2");
    expect(text).toContain("3 teammates thanked");
    expect(text).toContain("3. <@U3>");
    expect(text).toContain("5 slices shared across 2 recognition messages");
    expect(text).toContain("/pizza rewards");
  });
  it("renders actual excerpts as bounded plain text, preventing formatting/control injection", () => {
    const quote =
        "<@U999> <!here> *bold* `code` _name_ \u202e" + "x".repeat(1000),
      data = { ...empty, messages: 1 };
    const payload = celebrationPayload(week, data, [
      {
        id: "a",
        channel: "C1",
        ts: "1",
        recipient: "U2",
        reason: quote,
        url: "https://gr.slack.com/archives/C1/p1",
      },
    ]);
    const blocks = payload.blocks as {
      text?: { type: string; text: string };
    }[];
    const block = blocks.find((b) => b.text?.type === "plain_text")!;
    expect(block.text!.text).toContain("*bold* `code` _name_");
    expect(block.text!.text).not.toContain("\u202e");
    expect(block.text!.text.length).toBeLessThan(300);
    expect(String(payload.text)).not.toContain("<@U999>");
    expect(blocks.length).toBeLessThan(50);
  });
  it("prefers different recipients/messages and omits stale links with bounded attempts", async () => {
    const highlights = [
      { id: "a", recipient: "U1" },
      { id: "b", recipient: "U1" },
      { id: "c", recipient: "U2" },
    ].map((h) => ({ ...h, reason: "Thanks", channel: "C1", ts: h.id }));
    const api = {
      permalink: vi
        .fn()
        .mockResolvedValue("https://gr.slack.com/archives/C1/p1"),
    } as unknown as PizzaSlack;
    const selected = await linkedHighlights(api, { ...empty, highlights });
    expect(selected.map((h) => h.id)).toEqual(["a", "c"]);
    const missing = { permalink: vi.fn().mockResolvedValue(null) };
    expect(
      await linkedHighlights(missing as unknown as PizzaSlack, {
        ...empty,
        highlights: Array.from({ length: 20 }, (_, n) => ({
          ...highlights[0],
          id: String(n),
        })),
      }),
    ).toEqual([]);
    expect(missing.permalink).toHaveBeenCalledTimes(4);
  });
  it("requires both enable flags and a valid activation timestamp without disabling core bot", async () => {
    const fake = { celebrationReady: vi.fn() };
    for (const cfg of [
      c,
      { ...c, celebrationsEnabled: true },
      {
        ...c,
        enabled: false,
        celebrationsEnabled: true,
        celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
      },
    ])
      expect(
        await scheduleCelebrations(
          fake as unknown as PizzaStore,
          {} as PizzaSlack,
          cfg,
        ),
      ).toBe(0);
    expect(fake.celebrationReady).not.toHaveBeenCalled();
  });
  it("skips pre-activation due dates and selects at most the latest due week/month after an outage", async () => {
    const s = {
      settings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
      celebrationReady: vi.fn().mockResolvedValue(true),
      celebrationSnapshot: vi.fn().mockResolvedValue(empty),
      queueCelebration: vi.fn().mockResolvedValue(true),
    };
    const cfg = {
      ...c,
      celebrationsEnabled: true,
      celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
    };
    expect(
      await scheduleCelebrations(
        s as unknown as PizzaStore,
        {} as PizzaSlack,
        cfg,
        new Date("2026-10-08T10:00:00Z"),
      ),
    ).toBe(0);
    expect(
      await scheduleCelebrations(
        s as unknown as PizzaStore,
        {} as PizzaSlack,
        cfg,
        new Date("2026-12-15T10:00:00Z"),
      ),
    ).toBe(2);
    expect(s.queueCelebration).toHaveBeenCalledTimes(2);
    expect(s.queueCelebration.mock.calls.map((call) => call[1].kind)).toEqual([
      "week",
      "month",
    ]);
  });
  it("per-team weekly/monthly switches skip only their report without resetting activation or latest recovery", async () => {
    const s = {
      settings: vi.fn(),
      celebrationReady: vi.fn().mockResolvedValue(true),
      celebrationSnapshot: vi.fn().mockResolvedValue(empty),
      queueCelebration: vi.fn().mockResolvedValue(true),
    };
    const cfg = {
      ...c,
      celebrationsEnabled: true,
      celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
    };
    s.settings.mockResolvedValue({ ...DEFAULT_SETTINGS, weeklyEnabled: false });
    expect(
      await scheduleCelebrations(
        s as unknown as PizzaStore,
        {} as PizzaSlack,
        cfg,
        new Date("2026-12-15T10:00:00Z"),
      ),
    ).toBe(1);
    expect(s.queueCelebration.mock.calls.map((call) => call[1].kind)).toEqual([
      "month",
    ]);
    s.queueCelebration.mockClear();
    s.settings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      monthlyEnabled: false,
    });
    expect(
      await scheduleCelebrations(
        s as unknown as PizzaStore,
        {} as PizzaSlack,
        cfg,
        new Date("2026-12-15T10:00:00Z"),
      ),
    ).toBe(1);
    expect(s.queueCelebration.mock.calls.map((call) => call[1].kind)).toEqual([
      "week",
    ]);
    s.queueCelebration.mockClear();
    s.settings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      weeklyEnabled: false,
      monthlyEnabled: false,
    });
    expect(
      await scheduleCelebrations(
        s as unknown as PizzaStore,
        {} as PizzaSlack,
        cfg,
        new Date("2026-12-15T10:00:00Z"),
      ),
    ).toBe(0);
    expect(s.queueCelebration).not.toHaveBeenCalled();
  });
});
