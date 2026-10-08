import { it, expect } from "vitest";
import { progressMeter, TIERS } from "./rewards";
import { goalText, rewardModal } from "./blocks";
it("uses literal slice cells for presets and fixed-size proportional cells for large costs", () => {
  expect(TIERS).toEqual({ small: 6, medium: 8, large: 12 });
  expect(progressMeter(7, 12)).toBe("●".repeat(7) + "○".repeat(5));
  expect(progressMeter(4, 8)).toBe("●●●●○○○○");
  expect(progressMeter(2000000, 1000000)).toBe("●".repeat(12));
  expect(progressMeter(500000, 1000000)).toBe("●".repeat(6) + "○".repeat(6));
});
it("preset cost is editable and editing tier never overwrites existing price", () => {
  for (const tier of ["small", "medium", "large"] as const) {
    const modal = rewardModal(undefined, tier);
    expect(JSON.stringify(modal)).toContain(`"initial_value":"${TIERS[tier]}"`);
  }
  const edit = rewardModal({
    id: "reward",
    name: "Real prize",
    cost: 7,
    description: "",
    stock: null,
    active: true,
    tier: "large",
  });
  expect(JSON.stringify(edit)).toContain('"initial_value":"7"');
  expect(JSON.stringify(edit)).toContain('"value":"large"');
});
it("goal progress is truthful for current price/availability, escapes names and promises no automatic spending", () => {
  const r = {
    id: "reward",
    name: "<@U9> & reward",
    cost: 12,
    description: "",
    stock: 1,
    active: true,
  };
  expect(goalText(7, r)).toContain("5 more slices");
  expect(goalText(7, r)).toContain("&lt;@U9&gt; &amp;");
  expect(goalText(12, r)).toContain("Ready to redeem");
  expect(goalText(12, { ...r, active: false })).not.toContain(
    "Ready to redeem",
  );
  expect(goalText(12, { ...r, stock: 0 })).toContain("sold out");
  expect(goalText(7, { ...r, cost: 14 })).toContain("proportional");
  expect(goalText(0, null)).toContain("Admins choose the actual prizes");
});
