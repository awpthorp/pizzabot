import { pathToFileURL } from "node:url";
export async function runPizzaWorker(env = process.env, fetcher = fetch) {
  const origin = env.PIZZA_WORKER_ORIGIN,
    secret = env.PIZZA_WORKER_SECRET;
  if (!origin || !secret || secret.length < 32)
    throw new Error(
      "PIZZA_WORKER_ORIGIN and PIZZA_WORKER_SECRET (32+ characters) are required",
    );
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Use an HTTPS origin (HTTP allowed only on loopback)");
  const endpoint = new URL("/api/slack/pizza/drain", url);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Pizza worker returned HTTP ${response.status}`);
  const result = await response.json();
  return { inbox: result.inbox, outbox: result.outbox };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify({
        message: "PizzaBot recovery drain complete",
        ...(await runPizzaWorker()),
      }),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Pizza worker failed",
    );
    process.exitCode = 1;
  }
}
