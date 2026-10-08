import { it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  validSettings,
  validAdjustment,
  settingsSummary,
} from "./settings";
import {
  settingsModal,
  adjustmentModal,
  rewardsBlocks,
  rewardModal,
  goalText,
  help,
  historyBlocks,
} from "./blocks";
it("validates boundaries and arbitrary tier order without changing default values", () => {
  const { version, ...values } = DEFAULT_SETTINGS;
  expect(
    validSettings({
      ...values,
      dailyLimit: 0,
      smallCost: 1000000,
      mediumCost: 2,
      largeCost: 1,
    }),
  ).toBe(true);
  expect(validSettings({ ...values, dailyLimit: 1000 })).toBe(true);
  for (const invalid of [
    { dailyLimit: 1001 },
    { dailyLimit: -1 },
    { dailyLimit: 1.5 },
    { smallCost: 0 },
    { largeCost: 1000001 },
    { weeklyEnabled: "on" },
    { extra: 1 },
  ])
    expect(validSettings({ ...values, ...invalid })).toBe(false);
  for (const [delta, reason, valid] of [
    [1, "reason", true],
    [-1000000, "reason", true],
    [1000000, "reason", true],
    [0, "reason", false],
    [1000001, "reason", false],
    [1.5, "reason", false],
    [1, "   ", false],
    [1, "x".repeat(501), false],
  ] as const)
    expect(validAdjustment(delta, reason)).toBe(valid);
});
it("renders current knobs/presets/help and keeps revision only in modal metadata", () => {
  const custom = {
    ...DEFAULT_SETTINGS,
    version: 7,
    dailyLimit: 0,
    smallCost: 20,
    mediumCost: 4,
    largeCost: 11,
    weeklyEnabled: false,
  };
  expect(settingsModal(custom).private_metadata).toBe("7");
  expect(settingsSummary(custom)).not.toMatch(/Revision|activation/);
  expect(settingsSummary(custom)).toContain("giving paused");
  expect(help(custom)).toContain("0 to give");
  expect(help(custom)).not.toContain("Five");
  expect(goalText(0, null, custom)).toContain("Small 20 slices");
  expect(JSON.stringify(rewardsBlocks([], true, custom))).toContain(
    "Add Small (20)",
  );
  const preset = rewardModal(undefined, "small", custom);
  expect(JSON.stringify(preset)).toContain('"initial_value":"20"');
  const prize = {
    id: "reward",
    name: "Real prize",
    description: "",
    stock: null,
    active: true,
    cost: 6,
    tier: "small" as const,
  };
  expect(JSON.stringify(rewardModal(prize, undefined, custom))).toContain(
    '"initial_value":"6"',
  );
  expect(JSON.stringify(adjustmentModal())).toContain("users_select");
});
it("history puts trusted people in headings and hostile reasons in literal bounded blocks", () => {
  const rows = [
    {
      kind: "adjustment",
      job_id: "reference",
      actor: "U9",
      recipient: "U2",
      created_at: "2026-10-08T00:00:00Z",
      before_balance: 3,
      after_balance: 5,
      delta: 2,
      reason: "<!here> <@U999> *quote* `code`",
    },
  ];
  const blocks = historyBlocks(rows, 1);
  const json = JSON.stringify(blocks);
  expect(json).toContain("<@U9> adjusted <@U2>");
  expect(json).toContain("page 1");
  const text = blocks.filter((b) => "text" in b).map((b) => b.text);
  expect(
    text.some(
      (t) =>
        t?.type === "plain_text" &&
        t.text.includes("Reason: <!here> <@U999> *quote* `code`"),
    ),
  ).toBe(true);
  expect(
    text
      .filter((t) => t?.type === "mrkdwn")
      .some((t) => t?.text.includes("U999")),
  ).toBe(false);
  expect(blocks.length).toBeLessThan(50);
});
