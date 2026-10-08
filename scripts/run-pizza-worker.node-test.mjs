import { test } from "node:test";
import assert from "node:assert/strict";
import { runPizzaWorker } from "./run-pizza-worker.mjs";
const env = {
  PIZZA_WORKER_ORIGIN: "https://clients.gr.agency",
  PIZZA_WORKER_SECRET: "x".repeat(32),
};
test("authenticated scheduled drain, forbids redirect and limits request duration", async () => {
  let called;
  const result = await runPizzaWorker(env, async (url, options) => {
    called = { url: String(url), options };
    return Response.json({ inbox: 2, outbox: 1 });
  });
  assert.deepEqual(result, { inbox: 2, outbox: 1 });
  assert.equal(called.url, "https://clients.gr.agency/api/slack/pizza/drain");
  assert.equal(
    called.options.headers.authorization,
    `Bearer ${env.PIZZA_WORKER_SECRET}`,
  );
  assert.equal(called.options.redirect, "error");
  assert.ok(called.options.signal);
});
test("refuses missing secret, insecure remote URLs and credentials", async () => {
  for (const override of [
    { PIZZA_WORKER_SECRET: "" },
    { PIZZA_WORKER_ORIGIN: "http://evil.example" },
    { PIZZA_WORKER_ORIGIN: "https://user:pass@example.com" },
  ])
    await assert.rejects(runPizzaWorker({ ...env, ...override }));
});
test("reports safe HTTP failures without leaking secrets", async () => {
  await assert.rejects(
    runPizzaWorker(env, async () => new Response("secret", { status: 503 })),
    /HTTP 503/,
  );
});
