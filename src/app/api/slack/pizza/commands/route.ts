import { createHash } from "node:crypto";
import { after } from "next/server";
import {
  signedRequest,
  sameWorkspace,
  responseUrl,
} from "@/lib/pizza/security";
import { store } from "@/lib/pizza/store";
import { slack } from "@/lib/pizza/slack";
import { drain } from "@/lib/pizza/worker";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const verified = await signedRequest(request);
  if (verified instanceof Response) return verified;
  const { raw, c } = verified,
    body = new URLSearchParams(raw);
  if (!sameWorkspace(body.get("team_id"), body.get("api_app_id"), c))
    return new Response("Wrong workspace/app", { status: 403 });
  if (!c.enabled)
    return Response.json({
      response_type: "ephemeral",
      text: "PizzaBot is not enabled yet.",
    });
  const url = responseUrl(body.get("response_url")),
    user = body.get("user_id"),
    channel = body.get("channel_id");
  if (
    body.get("command") !== "/pizza" ||
    !url ||
    !user ||
    !/^[UW][A-Z0-9]+$/.test(user) ||
    !channel ||
    !/^[CGD][A-Z0-9]+$/.test(channel)
  )
    return new Response("Malformed command", { status: 400 });
  try {
    const s = store();
    await s.enqueue(
      c.team,
      `command:${createHash("sha256").update(raw).digest("hex")}`,
      "command",
      {
        user,
        channel,
        text: body.get("text") ?? "",
        responseUrl: url,
        responseExpires: Date.now() + 25 * 60_000,
      },
    );
    after(async () => {
      try {
        await drain(s, slack(c), c, 5);
      } catch {
        console.error("pizza_worker_unavailable");
      }
    });
    return Response.json({
      response_type: "ephemeral",
      text: "Checking PizzaBot…",
    });
  } catch {
    return new Response("Persistence unavailable; retry", { status: 503 });
  }
}
