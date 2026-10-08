import { describe, it, expect } from "vitest";
import { config } from "./config";
import { eligible, localDay, rejection } from "./policy";
export const env = {
  PIZZA_ENABLED: "true",
  PIZZA_BOT_TOKEN: "xoxb-test",
  PIZZA_SIGNING_SECRET: "s".repeat(32),
  PIZZA_TEAM_ID: "T1",
  PIZZA_APP_ID: "A1",
  PIZZA_RECOGNITION_CHANNEL_ID: "C1",
  PIZZA_ADMIN_CHANNEL_ID: "C2",
  PIZZA_ADMIN_USER_IDS: "U9",
  PIZZA_WORKER_SECRET: "w".repeat(32),
};
const c = config(env)!;
describe("policy and configuration", () => {
  it("uses original Dubai day across midnight", () => {
    expect(localDay(Date.parse("2026-10-08T19:59:59Z") / 1000)).toBe(
      "2026-10-08",
    );
    expect(localDay(Date.parse("2026-10-08T20:00:00Z") / 1000)).toBe(
      "2026-10-09",
    );
  });
  it("rejects bots, guests, deleted/external/unknown identity and respects explicit allowlist", () => {
    const human = { id: "U1", team_id: "T1" };
    expect(eligible(human, c)).toBe(true);
    for (const changes of [
      { is_bot: true },
      { is_app_user: true },
      { is_restricted: true },
      { is_ultra_restricted: true },
      { deleted: true },
      { is_stranger: true },
      { team_id: "T2" },
      { team_id: undefined },
    ])
      expect(eligible({ ...human, ...changes }, c)).toBe(false);
    expect(eligible(human, { ...c, participants: ["U2"] })).toBe(false);
  });
  it("fails closed for incomplete config and separate secrets", () => {
    expect(config({})).toBeNull();
    expect(
      config({ ...env, PIZZA_WORKER_SECRET: env.PIZZA_SIGNING_SECRET }),
    ).toBeNull();
    expect(config({ ...env, PIZZA_RECOGNITION_CHANNEL_ID: "G1" })).toBeNull();
    expect(config({ ...env, PIZZA_ADMIN_CHANNEL_ID: "G1" })).not.toBeNull();
  });
  it("rejects entire self gift or insufficient allowance", () => {
    expect(
      rejection("U1", ["U1"], 1, 0, [{ id: "U1", team_id: "T1" }], c),
    ).toMatch(/yourself/);
    expect(
      rejection(
        "U1",
        ["U2"],
        6,
        0,
        [
          { id: "U1", team_id: "T1" },
          { id: "U2", team_id: "T1" },
        ],
        c,
      ),
    ).toMatch(/needs 6/);
  });
});
