import { config } from "@/lib/pizza/config";
import { verifyWorker } from "@/lib/pizza/security";
import { store } from "@/lib/pizza/store";
import { slack } from "@/lib/pizza/slack";
import { drain } from "@/lib/pizza/worker";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const c = config();
  if (!c || !verifyWorker(request.headers.get("authorization"), c.workerSecret))
    return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json(await drain(store(), slack(c), c));
  } catch {
    return new Response("Worker unavailable", { status: 503 });
  }
}
