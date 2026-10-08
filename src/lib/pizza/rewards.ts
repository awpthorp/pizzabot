export const TIERS = { small: 6, medium: 8, large: 12 } as const;
export type Tier = keyof typeof TIERS;
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && Object.hasOwn(TIERS, value);
}
export function tierLabel(tier: Tier | null | undefined): string {
  return tier ? tier[0].toUpperCase() + tier.slice(1) : "Custom";
}
export function progressMeter(balance: number, cost: number): string {
  const cells = Math.min(12, Math.max(1, cost));
  const filled = Math.min(
    cells,
    Math.max(0, Math.floor((cells * balance) / Math.max(1, cost))),
  );
  return "●".repeat(filled) + "○".repeat(cells - filled);
}
export const tierGuide =
  "Reward tiers: Small 6 slices · Medium 8 slices · Large 12 slices. Admins choose the actual prizes; costs may be customised. Use /pizza rewards to track a reward.";
