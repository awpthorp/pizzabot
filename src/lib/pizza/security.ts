import { createHmac, timingSafeEqual } from "node:crypto";
export function verifySignature(
  raw: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): boolean {
  if (
    !secret ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !signature ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected =
    "v0=" +
    createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export function verifyWorker(header: string | null, secret: string): boolean {
  if (secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7)),
    expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function responseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      ["hooks.slack.com", "hooks.slack-gov.com"].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password &&
      /^\/(commands|actions)\//.test(u.pathname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}

import { config, type PizzaConfig } from "./config";
export async function signedRequest(
  request: Request,
): Promise<{ raw: string; c: PizzaConfig } | Response> {
  const c = config();
  if (!c)
    return new Response("PizzaBot configuration unavailable", { status: 503 });
  const raw = await request.text();
  if (raw.length > 65_536) return new Response("Too large", { status: 413 });
  if (
    !verifySignature(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      c.signingSecret,
    )
  )
    return new Response("Unauthorized", { status: 401 });
  return { raw, c };
}
export function sameWorkspace(team: unknown, app: unknown, c: PizzaConfig) {
  return (
    team === c.team &&
    (app === undefined || app === null || app === "" || app === c.app)
  );
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  );
}
