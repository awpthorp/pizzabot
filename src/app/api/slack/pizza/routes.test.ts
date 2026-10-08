import { createHmac } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { POST as events } from "./events/route";
import { POST as commands } from "./commands/route";
import { POST as interactions } from "./interactions/route";
import { POST as drainRoute } from "./drain/route";
import { DEFAULT_SETTINGS } from "@/lib/pizza/settings";
import { Refusal } from "@/lib/pizza/store";
const mock = vi.hoisted(() => ({
  settings: vi.fn(),
  after: vi.fn(),
  enqueue: vi.fn(),
  intent: vi.fn(),
  checkIntent: vi.fn(),
  reward: vi.fn(),
  interactionFeedback: vi.fn(),
  identity: vi.fn(),
  modal: vi.fn(),
  invalidate: vi.fn(),
  drain: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mock.after }));
vi.mock("@/lib/pizza/store", async (original) => ({
  ...(await original<typeof import("@/lib/pizza/store")>()),
  store: () => mock,
}));
vi.mock("@/lib/pizza/slack", () => ({ slack: () => mock }));
vi.mock("@/lib/pizza/worker", () => ({ drain: mock.drain }));
const secret = "s".repeat(32),
  id = "11111111-1111-4111-8111-111111111111";
const env = {
  PIZZA_ENABLED: "true",
  PIZZA_BOT_TOKEN: "xoxb-test",
  PIZZA_SIGNING_SECRET: secret,
  PIZZA_TEAM_ID: "T1",
  PIZZA_APP_ID: "A1",
  PIZZA_RECOGNITION_CHANNEL_ID: "C1",
  PIZZA_ADMIN_CHANNEL_ID: "G2",
  PIZZA_ADMIN_USER_IDS: "U9",
  PIZZA_WORKER_SECRET: "w".repeat(32),
};
function request(
  body: unknown,
  form = false,
  changes: Record<string, string> = {},
) {
  const raw = form ? String(body) : JSON.stringify(body),
    ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.com/api/slack/pizza/events", {
    method: "POST",
    body: raw,
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature":
        "v0=" +
        createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex"),
      ...changes,
    },
  });
}
const envelope = {
  type: "event_callback",
  team_id: "T1",
  api_app_id: "A1",
  event_id: "Ev1",
  event: {
    type: "message",
    channel: "C1",
    user: "U1",
    ts: "1791489600.000001",
    text: "<@U2> 🍕",
  },
};
const interaction = <T extends object = Record<never, never>>(
  changes: T = {} as T,
) => ({
  type: "block_actions",
  team: { id: "T1" },
  api_app_id: "A1",
  user: { id: "U2" },
  channel: { id: "C1" },
  trigger_id: "trigger",
  response_url: "https://hooks.slack.com/actions/T1/token",
  actions: [{ action_id: "pizza_redeem", value: id }],
  ...changes,
});
function form(body: unknown) {
  return new URLSearchParams({ payload: JSON.stringify(body) }).toString();
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.entries(env).forEach(([key, value]) => vi.stubEnv(key, value));
  mock.settings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  mock.identity.mockResolvedValue({ id: "U2", team_id: "T1" });
  mock.intent.mockResolvedValue({
    id,
    reward: {
      id,
      name: "Lunch",
      cost: 2,
      description: "",
      stock: null,
      active: true,
    },
    balance: 10,
  });
  mock.checkIntent.mockResolvedValue(true);
  mock.drain.mockResolvedValue({ inbox: 1, outbox: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("signed durable Slack routes", () => {
  it("each Slack route rejects missing/bad signature independently", async () => {
    for (const handler of [events, commands, interactions])
      expect(
        (await handler(request({}, false, { "x-slack-signature": "bad" })))
          .status,
      ).toBe(401);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("challenge works with signing secret alone, including disabled rollout", async () => {
    vi.stubEnv("PIZZA_ENABLED", "false");
    vi.stubEnv("PIZZA_BOT_TOKEN", "");
    expect(
      await (
        await events(
          request({ type: "url_verification", challenge: "challenge" }),
        )
      ).json(),
    ).toEqual({ challenge: "challenge" });
  });
  it("durably persists before acknowledging and performs no external API before ACK", async () => {
    let resolve!: () => void;
    mock.enqueue.mockImplementation(
      () => new Promise<void>((r) => (resolve = r)),
    );
    let done = false;
    const p = events(request(envelope)).then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(mock.enqueue).toHaveBeenCalled());
    expect(done).toBe(false);
    expect(mock.identity).not.toHaveBeenCalled();
    resolve();
    expect((await p).status).toBe(200);
    expect(mock.after).toHaveBeenCalled();
  });
  it("DB failure returns retryable 503 and never awards; irrelevant text is not retained", async () => {
    mock.enqueue.mockRejectedValue(new Error("db down"));
    expect((await events(request(envelope))).status).toBe(503);
    mock.enqueue.mockClear();
    expect(
      (
        await events(
          request({ ...envelope, event: { ...envelope.event, text: "hi" } }),
        )
      ).status,
    ).toBe(200);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and wrong team/app and disabled mutation", async () => {
    expect((await events(request("not json", true))).status).toBe(400);
    for (const changes of [{ team_id: "T2" }, { api_app_id: "A2" }])
      expect((await events(request({ ...envelope, ...changes }))).status).toBe(
        403,
      );
    vi.stubEnv("PIZZA_ENABLED", "false");
    expect((await events(request(envelope))).status).toBe(503);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("commands queue secret capabilities and privately ACK, hostile URL rejected", async () => {
    const body = {
      team_id: "T1",
      api_app_id: "A1",
      user_id: "U2",
      channel_id: "C1",
      command: "/pizza",
      text: "balance",
      response_url: "https://hooks.slack.com/commands/T1/token",
    };
    const response = await commands(
      request(new URLSearchParams(body).toString(), true),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ response_type: "ephemeral" });
    expect(mock.enqueue).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "command",
      expect.objectContaining({ user: "U2", responseUrl: body.response_url }),
    );
    expect(
      (
        await commands(
          request(
            new URLSearchParams({
              ...body,
              response_url: "https://evil.example/commands/x",
            }).toString(),
            true,
          ),
        )
      ).status,
    ).toBe(400);
  });
  it("opens a persisted intent promptly and never debits on a click", async () => {
    expect(
      (await interactions(request(form(interaction()), true))).status,
    ).toBe(200);
    expect(mock.intent).toHaveBeenCalledBefore(mock.modal);
    expect(mock.modal).toHaveBeenCalledWith(
      "trigger",
      expect.objectContaining({ private_metadata: id }),
    );
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("measures combined identity+database+modal latency and refuses before a stale trigger", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    mock.identity.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { id: "U2", team_id: "T1" };
    });
    mock.intent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 650));
      return {
        id,
        reward: {
          id,
          name: "Lunch",
          cost: 2,
          description: "",
          stock: null,
          active: true,
        },
        balance: 10,
      };
    });
    mock.modal.mockImplementation(() => new Promise((r) => setTimeout(r, 600)));
    const p = interactions(request(form(interaction()), true));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).status).toBe(200);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(mock.modal).toHaveBeenCalled();
    mock.modal.mockClear();
    mock.intent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 1250));
      return { id, reward: { id, name: "Lunch", cost: 2 }, balance: 10 };
    });
    const slow = interactions(request(form(interaction()), true));
    await vi.advanceTimersByTimeAsync(2200);
    expect((await slow).status).toBe(200);
    expect(mock.modal).not.toHaveBeenCalled();
    expect(mock.interactionFeedback).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "U2",
      "C1",
      "https://hooks.slack.com/actions/T1/token",
      expect.stringMatching(/too long/),
    );
  });
  it("private refusal is durably delivered instead of discarded in action ACK", async () => {
    mock.intent.mockRejectedValue(new Refusal("Insufficient pizzas"));
    const response = await interactions(request(form(interaction()), true));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(mock.interactionFeedback).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "U2",
      "C1",
      "https://hooks.slack.com/actions/T1/token",
      "Insufficient pizzas",
    );
  });
  it("submissions validate server intent ownership and enqueue before ACK; spoofed actor fails", async () => {
    const submission = interaction({
      type: "view_submission",
      view: { id: "V1", callback_id: "pizza_confirm", private_metadata: id },
    });
    expect((await interactions(request(form(submission), true))).status).toBe(
      200,
    );
    expect(mock.checkIntent).toHaveBeenCalledWith("T1", "U2", id);
    expect(mock.enqueue).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "redeem",
      expect.objectContaining({ user: "U2", intent: id }),
    );
    mock.checkIntent.mockResolvedValue(false);
    expect(
      (
        await interactions(
          request(form({ ...submission, user: { id: "U3" } }), true),
        )
      ).status,
    ).toBe(403);
  });
  it("non-admin actions and forged metadata cannot modify catalogue or requests", async () => {
    for (const action of [
      "pizza_cancel",
      "pizza_fulfill",
      "pizza_archive",
      "pizza_add",
    ])
      expect(
        (
          await interactions(
            request(
              form(
                interaction({ actions: [{ action_id: action, value: id }] }),
              ),
              true,
            ),
          )
        ).status,
      ).toBe(403);
    const invalid = interaction({
      type: "view_submission",
      view: {
        id: "V1",
        callback_id: "pizza_confirm",
        private_metadata: "garbage",
      },
    });
    expect((await interactions(request(form(invalid), true))).status).toBe(403);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("admin catalogue modal errors reject invalid price and repeated submit keys match", async () => {
    const submission = interaction({
      type: "view_submission",
      user: { id: "U9" },
      view: {
        id: "V1",
        callback_id: "pizza_catalogue",
        private_metadata: "new",
        state: {
          values: {
            name: { value: { value: "Lunch" } },
            cost: { value: { value: "-1" } },
          },
        },
      },
    });
    expect(
      await (await interactions(request(form(submission), true))).json(),
    ).toMatchObject({
      response_action: "errors",
      errors: { cost: expect.any(String) },
    });
    submission.view.state.values.cost.value.value = "2";
    await interactions(request(form(submission), true));
    await interactions(request(form(submission), true));
    expect(mock.enqueue.mock.calls[0][1]).toBe(mock.enqueue.mock.calls[1][1]);
  });
  it("drain enforces its independent worker bearer and remains usable while disabled", async () => {
    expect(
      (await drainRoute(new Request("https://example.com", { method: "POST" })))
        .status,
    ).toBe(401);
    vi.stubEnv("PIZZA_ENABLED", "false");
    expect(
      (
        await drainRoute(
          new Request("https://example.com", {
            method: "POST",
            headers: { authorization: `Bearer ${env.PIZZA_WORKER_SECRET}` },
          }),
        )
      ).status,
    ).toBe(200);
  });
  it("preset reward modals start at 6/8/12 and accept explicitly edited tier prices", async () => {
    mock.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    for (const [tier, cost] of [
      ["small", 6],
      ["medium", 8],
      ["large", 12],
    ] as const) {
      const payload = interaction({
        user: { id: "U9" },
        actions: [{ action_id: `pizza_add_${tier}`, value: "new" }],
      });
      expect((await interactions(request(form(payload), true))).status).toBe(
        200,
      );
      const modal = mock.modal.mock.calls.at(-1)![1];
      expect(JSON.stringify(modal)).toContain(`"initial_value":"${cost}"`);
    }
    const submit = interaction({
      type: "view_submission",
      user: { id: "U9" },
      view: {
        id: "tier-view",
        callback_id: "pizza_catalogue",
        private_metadata: "new",
        state: {
          values: {
            name: { value: { value: "Georgia's prize" } },
            cost: { value: { value: "7" } },
            tier: { value: { selected_option: { value: "large" } } },
          },
        },
      },
    });
    expect((await interactions(request(form(submit), true))).status).toBe(200);
    expect(mock.enqueue).toHaveBeenLastCalledWith(
      "T1",
      expect.any(String),
      "catalogue",
      expect.objectContaining({ tier: "large", cost: 7, user: "U9" }),
    );
  });
  it("goal actions persist the signed actor rather than any spoofed payload user, without a modal trigger", async () => {
    const payload = interaction({
      actions: [{ action_id: "pizza_goal", value: id, user: "U9" }],
      trigger_id: undefined,
    });
    expect((await interactions(request(form(payload), true))).status).toBe(200);
    expect(mock.enqueue).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "goal",
      expect.objectContaining({
        user: "U2",
        reward: id,
        responseUrl: "https://hooks.slack.com/actions/T1/token",
      }),
    );
    expect(mock.modal).not.toHaveBeenCalled();
    const clear = interaction({
      actions: [{ action_id: "pizza_goal_clear", value: "clear" }],
    });
    expect((await interactions(request(form(clear), true))).status).toBe(200);
    expect(mock.enqueue).toHaveBeenLastCalledWith(
      "T1",
      expect.any(String),
      "goal",
      expect.objectContaining({ user: "U2", reward: null }),
    );
    const foreign = interaction({
      team: { id: "T2" },
      actions: [{ action_id: "pizza_goal", value: id }],
    });
    expect((await interactions(request(form(foreign), true))).status).toBe(403);
  });
  it("opens admin controls with current revision/preset defaults and denies nonadmins and ineligible admins", async () => {
    mock.settings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      version: 8,
      smallCost: 25,
    });
    mock.identity.mockResolvedValue({ id: "U9", team_id: "T1" });
    for (const action of [
      "pizza_settings",
      "pizza_adjust",
      "pizza_add_small",
    ]) {
      const response = await interactions(
        request(
          form(
            interaction({
              user: { id: "U9" },
              actions: [{ action_id: action, value: "open" }],
            }),
          ),
          true,
        ),
      );
      expect(response.status).toBe(200);
    }
    expect(mock.modal.mock.calls[0][1]).toMatchObject({
      callback_id: "pizza_settings_save",
      private_metadata: "8",
    });
    expect(JSON.stringify(mock.modal.mock.calls[1][1])).toContain(
      '"type":"users_select"',
    );
    expect(JSON.stringify(mock.modal.mock.calls[2][1])).toContain(
      '"initial_value":"25"',
    );
    mock.modal.mockClear();
    mock.identity.mockResolvedValue({ id: "U2", team_id: "T1" });
    expect(
      (
        await interactions(
          request(
            form(
              interaction({
                actions: [{ action_id: "pizza_settings", value: "open" }],
              }),
            ),
            true,
          ),
        )
      ).status,
    ).toBe(403);
    mock.identity.mockResolvedValue({
      id: "U9",
      team_id: "T1",
      is_restricted: true,
    });
    expect(
      (
        await interactions(
          request(
            form(
              interaction({
                user: { id: "U9" },
                actions: [{ action_id: "pizza_adjust", value: "open" }],
              }),
            ),
            true,
          ),
        )
      ).status,
    ).toBe(200);
    expect(mock.modal).not.toHaveBeenCalled();
    expect(mock.interactionFeedback).toHaveBeenCalledWith(
      "T1",
      expect.any(String),
      "U9",
      expect.any(String),
      expect.any(String),
      expect.stringContaining("eligible"),
    );
  });
  it("settings submissions validate every value/toggle and metadata before durable signed-actor enqueue", async () => {
    const numeric = (value: string) => ({ value: { value } }),
      toggle = (value: string) => ({ value: { selected_option: { value } } });
    const values = {
      dailyLimit: numeric("0"),
      smallCost: numeric("20"),
      mediumCost: numeric("2"),
      largeCost: numeric("1"),
      weeklyEnabled: toggle("off"),
      monthlyEnabled: toggle("on"),
    };
    const body = interaction({
      type: "view_submission",
      user: { id: "U9" },
      channel: { id: "CFAKE" },
      view: {
        id: "Vsettings",
        callback_id: "pizza_settings_save",
        private_metadata: "4",
        state: { values },
      },
    });
    expect(
      await (await interactions(request(form(body), true))).json(),
    ).toEqual({ response_action: "clear" });
    expect(mock.enqueue).toHaveBeenLastCalledWith(
      "T1",
      expect.any(String),
      "settings",
      {
        user: "U9",
        channel: "G2",
        version: 4,
        values: {
          dailyLimit: 0,
          smallCost: 20,
          mediumCost: 2,
          largeCost: 1,
          weeklyEnabled: false,
          monthlyEnabled: true,
        },
      },
    );
    mock.enqueue.mockClear();
    const bad = {
      ...body,
      view: {
        ...body.view,
        state: {
          values: {
            ...values,
            dailyLimit: numeric("1001"),
            smallCost: numeric("0"),
            mediumCost: numeric("1.5"),
            largeCost: numeric("1000001"),
            weeklyEnabled: toggle("maybe"),
          },
        },
      },
    };
    expect(
      (await (await interactions(request(form(bad), true))).json()).errors,
    ).toEqual({
      dailyLimit: expect.any(String),
      smallCost: expect.any(String),
      mediumCost: expect.any(String),
      largeCost: expect.any(String),
      weeklyEnabled: expect.any(String),
    });
    expect(
      (
        await interactions(
          request(
            form({
              ...body,
              view: {
                ...body.view,
                private_metadata: '{"user":"U9","version":4}',
              },
            }),
            true,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (await interactions(request(form({ ...body, user: { id: "U2" } }), true)))
        .status,
    ).toBe(403);
    expect(
      (
        await interactions(
          request(form(body), true, { "x-slack-signature": "bad" }),
        )
      ).status,
    ).toBe(401);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("adjustment submissions reject malformed/forged fields, trim reason and bind admin-channel feedback", async () => {
    const input = (value: unknown) => ({ value: { value } });
    const values = {
      recipient: { value: { selected_user: "U2" } },
      delta: input("-12"),
      reason: input("  real correction  "),
    };
    const body = interaction({
      type: "view_submission",
      user: { id: "U9" },
      view: {
        id: "Vadjust",
        callback_id: "pizza_adjust_save",
        private_metadata: '{"user":"U1","recipient":"U3","channel":"CFAKE"}',
        state: { values },
      },
    });
    expect(
      await (await interactions(request(form(body), true))).json(),
    ).toEqual({ response_action: "clear" });
    expect(mock.enqueue).toHaveBeenLastCalledWith(
      "T1",
      expect.any(String),
      "adjustment",
      {
        user: "U9",
        channel: "G2",
        recipient: "U2",
        delta: -12,
        reason: "real correction",
      },
    );
    mock.enqueue.mockClear();
    for (const rawDelta of ["0", "1.2", "NaN", "-1000001", {}, "1e3"]) {
      const invalid = {
        ...body,
        view: {
          ...body.view,
          state: { values: { ...values, delta: input(rawDelta) } },
        },
      };
      expect(
        (await (await interactions(request(form(invalid), true))).json()).errors
          .delta,
      ).toEqual(expect.any(String));
    }
    const invalid = {
      ...body,
      view: {
        ...body.view,
        state: {
          values: {
            ...values,
            recipient: { value: { selected_user: "<!here>" } },
            reason: input(" "),
          },
        },
      },
    };
    expect(
      (await (await interactions(request(form(invalid), true))).json()).errors,
    ).toMatchObject({
      recipient: expect.any(String),
      reason: expect.any(String),
    });
    expect(
      (await interactions(request(form({ ...body, user: { id: "U2" } }), true)))
        .status,
    ).toBe(403);
    expect(
      (await interactions(request(form({ ...body, team: { id: "T2" } }), true)))
        .status,
    ).toBe(403);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
});
