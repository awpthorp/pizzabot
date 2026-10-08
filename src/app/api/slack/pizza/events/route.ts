import { after } from "next/server";
import { config } from "@/lib/pizza/config";
import { parseAward } from "@/lib/pizza/parser";
import { verifySignature, sameWorkspace } from "@/lib/pizza/security";
import { store } from "@/lib/pizza/store";
import { slack } from "@/lib/pizza/slack";
import { drain } from "@/lib/pizza/worker";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 65_536) return new Response("Too large", { status: 413 });
  if (
    !verifySignature(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      process.env.PIZZA_SIGNING_SECRET ?? "",
    )
  )
    return new Response("Unauthorized", { status: 401 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Malformed JSON", { status: 400 });
  }
  if (!body || typeof body !== "object")
    return new Response("Malformed event", { status: 400 });
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    if (
      (body.team_id &&
        process.env.PIZZA_TEAM_ID &&
        body.team_id !== process.env.PIZZA_TEAM_ID) ||
      (body.api_app_id &&
        process.env.PIZZA_APP_ID &&
        body.api_app_id !== process.env.PIZZA_APP_ID)
    )
      return new Response("Wrong workspace/app", { status: 403 });
    return Response.json({ challenge: body.challenge });
  }
  const c = config();
  if (!c)
    return new Response("PizzaBot configuration unavailable", { status: 503 });
  if (!sameWorkspace(body.team_id, body.api_app_id, c))
    return new Response("Wrong workspace/app", { status: 403 });
  if (!c.enabled) return new Response("PizzaBot disabled", { status: 503 });
  if (
    body.type !== "event_callback" ||
    typeof body.event_id !== "string" ||
    body.event_id.length > 200 ||
    !body.event ||
    typeof body.event !== "object"
  )
    return new Response(null, { status: 200 });
  const event = body.event,
    award = parseAward(event, c.recognitionChannel);
  if (!award && event.type !== "user_change")
    return new Response(null, { status: 200 });
  try {
    const s = store();
    if (award) await s.enqueue(c.team, body.event_id, "award", award);
    else if (typeof event.user?.id === "string") {
      slack(c).invalidate(event.user.id);
      await s.enqueue(c.team, body.event_id, "user_change", {
        user: event.user.id,
      });
    }
    after(async () => {
      try {
        await drain(s, slack(c), c, 5);
      } catch {
        console.error("pizza_worker_unavailable");
      }
    });
    return new Response(null, { status: 200 });
  } catch {
    return new Response("Persistence unavailable; retry", { status: 503 });
  }
}
