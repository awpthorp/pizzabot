import { DAILY_LIMIT } from "./config";
import { TIERS } from "./rewards";
export type PizzaSettings = {
  version: number;
  dailyLimit: number;
  smallCost: number;
  mediumCost: number;
  largeCost: number;
  weeklyEnabled: boolean;
  monthlyEnabled: boolean;
};
export const DEFAULT_SETTINGS: PizzaSettings = {
  version: 0,
  dailyLimit: DAILY_LIMIT,
  smallCost: TIERS.small,
  mediumCost: TIERS.medium,
  largeCost: TIERS.large,
  weeklyEnabled: true,
  monthlyEnabled: true,
};
export type SettingsValues = Omit<PizzaSettings, "version">;
export function settingsFromRow(row?: Record<string, unknown>): PizzaSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    version: Number(row.version),
    dailyLimit: Number(row.daily_limit),
    smallCost: Number(row.small_cost),
    mediumCost: Number(row.medium_cost),
    largeCost: Number(row.large_cost),
    weeklyEnabled: row.weekly_enabled === true,
    monthlyEnabled: row.monthly_enabled === true,
  };
}
export function validSettings(value: unknown): value is SettingsValues {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 6 &&
    Number.isInteger(v.dailyLimit) &&
    Number(v.dailyLimit) >= 0 &&
    Number(v.dailyLimit) <= 1000 &&
    ["smallCost", "mediumCost", "largeCost"].every(
      (k) =>
        Number.isInteger(v[k]) && Number(v[k]) >= 1 && Number(v[k]) <= 1000000,
    ) &&
    typeof v.weeklyEnabled === "boolean" &&
    typeof v.monthlyEnabled === "boolean"
  );
}
export function presetCosts(s: PizzaSettings) {
  return { small: s.smallCost, medium: s.mediumCost, large: s.largeCost };
}
export function validAdjustment(delta: unknown, reason: unknown): boolean {
  return (
    Number.isInteger(delta) &&
    Number(delta) !== 0 &&
    Math.abs(Number(delta)) <= 1000000 &&
    typeof reason === "string" &&
    reason.trim().length >= 1 &&
    reason.trim().length <= 500
  );
}
export function settingsSummary(s: PizzaSettings) {
  return `Daily giving limit: ${s.dailyLimit} 🍕 per Dubai day${s.dailyLimit === 0 ? " (giving paused)" : ""}\nNew preset costs: Small ${s.smallCost} · Medium ${s.mediumCost} · Large ${s.largeCost} slices\nWeekly reports: ${s.weeklyEnabled ? "on" : "off"} · Monthly reports: ${s.monthlyEnabled ? "on" : "off"}\nPresets affect new prize defaults; existing prices stay unchanged. Weekly: Friday 4pm Dubai; monthly: first day 10am Dubai. Switches affect new reports; already queued messages may still arrive.`;
}
