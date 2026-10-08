import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifySignature, verifyWorker, responseUrl } from "./security";
describe("dedicated Slack authentication", () => {
  it("authenticates exact raw body and rejects stale, malformed, missing and changed signatures", () => {
    const secret = "s".repeat(32),
      now = 1791489600000,
      ts = String(now / 1000),
      raw = "text=hello%20world";
    const sig =
      "v0=" +
      createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
    expect(verifySignature(raw, ts, sig, secret, now)).toBe(true);
    for (const [body, time, sign, key] of [
      [raw, ts, sig, "wrong"],
      [raw + "!", ts, sig, secret],
      [raw, String(Number(ts) - 301), sig, secret],
      [raw, ts, null, secret],
      [raw, ts, "v0=bad", secret],
    ])
      expect(verifySignature(body!, time!, sign, key!, now)).toBe(false);
  });
  it("permits only Slack response capabilities and refuses arbitrary URLs", () => {
    for (const path of ["commands/T1/token", "actions/T1/token"])
      expect(responseUrl(`https://hooks.slack.com/${path}`)).toBeTruthy();
    for (const url of [
      "https://evil.example/commands/test",
      "http://hooks.slack.com/actions/test",
      "https://hooks.slack.com.evil.example/actions/test",
      "https://user@hooks.slack.com/commands/test",
      "https://hooks.slack.com:444/commands/test",
      "https://hooks.slack.com/services/test",
      "https://hooks.slack.com/anything",
    ])
      expect(responseUrl(url)).toBeNull();
  });
  it("authenticates worker independently", () => {
    const secret = "w".repeat(32);
    expect(verifyWorker(`Bearer ${secret}`, secret)).toBe(true);
    expect(verifyWorker("Bearer wrong", secret)).toBe(false);
    expect(verifyWorker(null, secret)).toBe(false);
  });
});
