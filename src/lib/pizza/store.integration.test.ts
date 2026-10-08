import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { PizzaStore, Refusal, LostLease, type Job, type Outbox } from "./store";
import { period, latestDue } from "./periods";
import { scheduleCelebrations } from "./celebrations";
import { type PizzaSlack } from "./slack";
import { DEFAULT_SETTINGS, type PizzaSettings } from "./settings";
import { config } from "./config";
import { type AwardInput } from "./parser";
import { type Identity } from "./policy";
const dsn = process.env.PIZZA_TEST_DATABASE_URL;
const c = config({
  PIZZA_ENABLED: "true",
  PIZZA_BOT_TOKEN: "xoxb-test",
  PIZZA_SIGNING_SECRET: "s".repeat(32),
  PIZZA_TEAM_ID: "T1",
  PIZZA_APP_ID: "A1",
  PIZZA_RECOGNITION_CHANNEL_ID: "C1",
  PIZZA_ADMIN_CHANNEL_ID: "G2",
  PIZZA_ADMIN_USER_IDS: "U9",
  PIZZA_WORKER_SECRET: "w".repeat(32),
})!;
const user = (id: string, changes = {}) => ({
  id,
  team_id: c.team,
  ...changes,
});
const ts = (second: number) => `${1791440000 + second}.000001`;
let pool: Pool, admin: Pool, s: PizzaStore;
const schema = `pizza_test_${process.pid}`;
let sequence = 0;
async function job(
  kind: string,
  payload: Record<string, unknown>,
  key = `event-${++sequence}`,
): Promise<Job> {
  await s.enqueue(c.team, key, kind, payload);
  const row = await s.claim("pizza_inbox", c.team);
  expect(row).not.toBeNull();
  return row as Job;
}
function award(
  giver = "U1",
  recipients = ["U2"],
  amount = 1,
  second = ++sequence,
): AwardInput {
  return {
    giver,
    recipients,
    amount,
    total: amount * recipients.length,
    channel: "C1",
    ts: ts(second),
    thread: ts(second),
    reason: "thanks",
  };
}
async function give(
  a = award(),
  identities: Identity[] = [...new Set([a.giver, ...a.recipients])].map((id) =>
    user(id),
  ),
) {
  return s.award(await job("award", a), a, identities, c);
}
async function reward(cost = 2, stock: number | null = null) {
  return (
    await pool.query(
      "INSERT INTO pizza_rewards(id,team_id,name,cost,stock,description) VALUES(gen_random_uuid(),'T1','Lunch',$1,$2,'Manual fulfilment') RETURNING *",
      [cost, stock],
    )
  ).rows[0];
}
async function seed(id = "U2", amount = 10) {
  await give(award(`U3${id.slice(1)}`, [id], 5));
  if (amount > 5) await give(award(`U4${id.slice(1)}`, [id], amount - 5));
}
async function redeem(u: string, id: string) {
  return s.redeem(
    await job("redeem", { intent: id, user: u, channel: "C1" }),
    user(u),
    c,
  );
}
async function setSettings(
  changes: Partial<PizzaSettings> = {},
  revision?: number,
) {
  const settings = await s.settings(c.team),
    { version, ...values } = settings;
  const j = await job("settings", {
    user: "U9",
    version: revision ?? version,
    values: { ...values, ...changes },
  });
  await s.saveSettings(j, user("U9"), c);
  return j;
}
async function adjust(delta: number, recipient = "U2", reason = "Correction") {
  const j = await job("adjustment", { user: "U9", recipient, delta, reason });
  await s.adjustBalance(j, user("U9"), user(recipient), c);
  return j;
}
describe.skipIf(!dsn)(
  "Pizza accounting with real PostgreSQL and concurrent connections",
  () => {
    beforeAll(async () => {
      if (!["localhost", "127.0.0.1"].includes(new URL(dsn!).hostname))
        throw new Error("Use a disposable local database");
      admin = new Pool({ connectionString: dsn });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: dsn,
        max: 20,
        options: `-c search_path=${schema},public`,
      });
      s = new PizzaStore(pool);
      const directory = new URL("../../../db/migrations/", import.meta.url);
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        const migration = await readFile(new URL(name, directory), "utf8");
        await pool.query(migration);
        await pool.query(migration);
      }
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE pizza_settings,pizza_settings_changes,pizza_balance_adjustments,pizza_celebrations,pizza_reward_goals,pizza_users,pizza_inbox,pizza_daily_usage,pizza_awards,pizza_award_recipients,pizza_rewards,pizza_redemption_intents,pizza_redemptions,pizza_ledger,pizza_outbox RESTART IDENTITY CASCADE",
      );
    });
    afterAll(async () => {
      if (pool) await pool.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    it("commits one public leaderboard and private receipt atomically without accounting changes; retries cannot publish twice", async () => {
      const command = await job("command", { user: "U2", channel: "C1", text: "leaderboard share", responseUrl: "https://hooks.slack.com/commands/test", responseExpires: Date.now() + 60000 });
      const payload = { text: "Received recognition leaderboard\nNo recognition yet." };
      await s.shareLeaderboard(command, payload, c);
      await expect(s.shareLeaderboard(command, payload, c)).rejects.toBeInstanceOf(LostLease);
      const rows = (await pool.query("SELECT notification_key,target,payload FROM pizza_outbox ORDER BY notification_key")).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ notification_key: `leaderboard-share:${command.id}`, target: { kind: "message", channel: "C1" }, payload });
      expect(rows[1]).toMatchObject({ target: { kind: "ephemeral", channel: "C1", user: "U2" } });
      expect((await pool.query("SELECT status FROM pizza_inbox WHERE id=$1", [command.id])).rows[0].status).toBe("complete");
      expect((await pool.query("SELECT * FROM pizza_ledger")).rowCount).toBe(0);
      expect((await pool.query("SELECT * FROM pizza_daily_usage")).rowCount).toBe(0);
    });
    it("cannot queue a public leaderboard for a different workspace or channel", async () => {
      for (const changes of [{ channel: "G2" }, { channel: "D1" }]) {
        const command = await job("command", { user: "U2", text: "leaderboard share", ...changes });
        await expect(s.shareLeaderboard(command, { text: "standings" }, c)).rejects.toBeInstanceOf(Refusal);
        await s.finish(command, { text: "refused" }, true);
      }
      const command = await job("command", { user: "U2", channel: "C1" });
      await expect(s.shareLeaderboard(command, { text: "standings" }, { ...c, team: "T_OTHER" })).rejects.toBeInstanceOf(Refusal);
      expect((await pool.query("SELECT * FROM pizza_outbox WHERE target->>'kind'='message'")).rowCount).toBe(0);
    });
    it("allocates two per recipient, distinct lifetime/spendable/allowance and immutable ledger", async () => {
      await give(award("U1", ["U2", "U3"], 2));
      expect(await s.balance(c.team, "U2")).toMatchObject({
        earned: 2,
        balance: 2,
      });
      expect(
        (
          await pool.query(
            "SELECT used FROM pizza_daily_usage WHERE giver_id='U1'",
          )
        ).rows[0].used,
      ).toBe(4);
      expect((await s.balance(c.team, "U2")).remaining).toBe(5);
      await expect(
        pool.query("UPDATE pizza_ledger SET balance_delta=0"),
      ).rejects.toThrow(/append-only/);
    });
    it("five awards exhaust allowance, six and self gifts reject atomically", async () => {
      for (let i = 0; i < 5; i++) expect(await give()).toBe("accepted");
      expect(await give()).toBe("rejected");
      expect((await s.balance(c.team, "U2")).balance).toBe(5);
      expect(await give(award("U5", ["U2"], 6))).toBe("rejected");
      expect(await give(award("U5", ["U5"], 1))).toBe("rejected");
      expect((await s.balance(c.team, "U2")).earned).toBe(5);
    });
    it.each([
      { is_bot: true },
      { deleted: true },
      { is_restricted: true },
      { is_ultra_restricted: true },
      { is_stranger: true },
      { team_id: "T2" },
    ])(
      "rejects an invalid recipient without partial allocation: %j",
      async (changes) => {
        const a = award("U1", ["U2", "U3"], 1);
        expect(
          await give(a, [user("U1"), user("U2"), user("U3", changes)]),
        ).toBe("rejected");
        expect((await s.balance(c.team, "U2")).balance).toBe(0);
        expect(
          (await pool.query("SELECT count(*)::int n FROM pizza_ledger")).rows[0]
            .n,
        ).toBe(0);
      },
    );
    it("uses original Dubai dates even for delayed processing", async () => {
      const a = award("U1", ["U2"], 5);
      a.ts = String(Date.parse("2026-10-08T19:59:59Z") / 1000) + ".000001";
      const b = {
        ...a,
        ts: String(Date.parse("2026-10-08T20:00:00Z") / 1000) + ".000001",
      };
      await give(a);
      await give(b);
      expect(
        (
          await pool.query(
            'SELECT local_day::text AS "day",used FROM pizza_daily_usage ORDER BY local_day',
          )
        ).rows,
      ).toEqual([
        { day: "2026-10-08", used: 5 },
        { day: "2026-10-09", used: 5 },
      ]);
    });
    it("deduplicates event IDs and stable message timestamps across independent claims", async () => {
      const a = award();
      const first = await job("award", a, "same-event");
      expect(await s.enqueue(c.team, "same-event", "award", a)).toBeUndefined();
      const second = await job("award", a, "distinct-event");
      await Promise.all([
        s.award(first, a, [user("U1"), user("U2")], c),
        s.award(second, a, [user("U1"), user("U2")], c),
      ]);
      expect((await s.balance(c.team, "U2")).earned).toBe(1);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_awards")).rows[0]
          .n,
      ).toBe(1);
    });
    it("two racing three-pizza awards cannot consume six", async () => {
      const a = award("U1", ["U2"], 3),
        b = award("U1", ["U3"], 3);
      const jobs = [await job("award", a), await job("award", b)];
      const results = await Promise.all([
        s.award(jobs[0], a, [user("U1"), user("U2")], c),
        s.award(jobs[1], b, [user("U1"), user("U3")], c),
      ]);
      expect(results.sort()).toEqual(["accepted", "rejected"]);
      expect(
        (await pool.query("SELECT used FROM pizza_daily_usage")).rows[0].used,
      ).toBe(3);
    });
    it("expired lease is reclaimable and stale worker cannot mutate or finish", async () => {
      const a = award(),
        old = await job("award", a);
      await pool.query(
        "UPDATE pizza_inbox SET lease_until=now()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      const recovered = (await new PizzaStore(pool).claim(
        "pizza_inbox",
        c.team,
      )) as Job;
      await expect(
        s.award(old, a, [user("U1"), user("U2")], c),
      ).rejects.toBeInstanceOf(LostLease);
      await s.award(recovered, a, [user("U1"), user("U2")], c);
      await expect(
        s.award(recovered, a, [user("U1"), user("U2")], c),
      ).rejects.toBeInstanceOf(LostLease);
      expect((await s.balance(c.team, "U2")).earned).toBe(1);
    });
    it("a failed transaction leaves no accounting and retry after process loss awards once", async () => {
      const a = award(),
        j = await job("award", a);
      await pool.query(
        "CREATE FUNCTION test_fail_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated crash before commit'; END $$; CREATE TRIGGER test_fail_notify BEFORE INSERT ON pizza_outbox FOR EACH ROW EXECUTE FUNCTION test_fail_notify()",
      );
      await expect(s.award(j, a, [user("U1"), user("U2")], c)).rejects.toThrow(
        /simulated crash/,
      );
      expect((await s.balance(c.team, "U2")).earned).toBe(0);
      await pool.query(
        "DROP TRIGGER test_fail_notify ON pizza_outbox; DROP FUNCTION test_fail_notify()",
      );
      await s.award(j, a, [user("U1"), user("U2")], c);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_ledger")).rows[0]
          .n,
      ).toBe(1);
    });
    it("parallel redemption cannot overspend and repeated intent spends once", async () => {
      await seed();
      const r = await reward(6),
        i1 = await s.intent(c.team, "U2", r.id),
        i2 = await s.intent(c.team, "U2", r.id);
      const j1 = await job("redeem", { intent: i1.id, user: "U2" }),
        j2 = await job("redeem", { intent: i2.id, user: "U2" });
      const results = await Promise.allSettled([
        s.redeem(j1, user("U2"), c),
        s.redeem(j2, user("U2"), c),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await s.balance(c.team, "U2")).toMatchObject({
        earned: 10,
        balance: 4,
      });
      const winner = results[0].status === "fulfilled" ? i1 : i2;
      const old = (await pool.query("SELECT id FROM pizza_redemptions")).rows[0]
        .id;
      expect(await redeem("U2", winner.id)).toBe(old);
      expect((await s.balance(c.team, "U2")).balance).toBe(4);
    });
    it("stock-one racing requests have one winner", async () => {
      await seed("U2");
      await seed("U5");
      const r = await reward(2, 1),
        i1 = await s.intent(c.team, "U2", r.id),
        i2 = await s.intent(c.team, "U5", r.id);
      const j1 = await job("redeem", { intent: i1.id, user: "U2" }),
        j2 = await job("redeem", { intent: i2.id, user: "U5" });
      const results = await Promise.allSettled([
        s.redeem(j1, user("U2"), c),
        s.redeem(j2, user("U5"), c),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await s.reward(c.team, r.id))?.stock).toBe(0);
    });
    it("revalidates price, actor, expiry and active reward and preserves snapshots", async () => {
      await seed();
      const r = await reward(2, 2),
        i = await s.intent(c.team, "U2", r.id);
      await expect(redeem("U5", i.id)).rejects.toBeInstanceOf(Refusal);
      await pool.query("UPDATE pizza_rewards SET cost=3 WHERE id=$1", [r.id]);
      await expect(redeem("U2", i.id)).rejects.toThrow(/price changed/);
      const confirmed = await s.intent(c.team, "U2", r.id),
        id = await redeem("U2", confirmed.id);
      await pool.query(
        "UPDATE pizza_rewards SET name='Different',cost=7 WHERE id=$1",
        [r.id],
      );
      expect(
        (
          await pool.query(
            "SELECT reward_name,cost FROM pizza_redemptions WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ reward_name: "Lunch", cost: 3 });
      const expired = await s.intent(c.team, "U2", r.id);
      await pool.query(
        "UPDATE pizza_redemption_intents SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [expired.id],
      );
      await expect(redeem("U2", expired.id)).rejects.toThrow(/expired/);
    });
    it("revalidates inactive reward, zero stock and user eligibility at submission", async () => {
      await seed();
      const r = await reward(2, 1),
        intent = await s.intent(c.team, "U2", r.id);
      await pool.query("UPDATE pizza_rewards SET active=false WHERE id=$1", [
        r.id,
      ]);
      await expect(redeem("U2", intent.id)).rejects.toThrow(/unavailable/);
      await pool.query(
        "UPDATE pizza_rewards SET active=true,stock=0 WHERE id=$1",
        [r.id],
      );
      await expect(redeem("U2", intent.id)).rejects.toThrow(/unavailable/);
      await pool.query("UPDATE pizza_rewards SET stock=1 WHERE id=$1", [r.id]);
      await expect(
        s.redeem(
          await job("redeem", { intent: intent.id, user: "U2" }),
          user("U2", { deleted: true }),
          c,
        ),
      ).rejects.toThrow(/eligible staff/);
      expect((await s.balance(c.team, "U2")).balance).toBe(10);
    });
    it("admin catalogue add, edit, archive are durable and reject non-admins", async () => {
      const add = await job("catalogue", {
        reward: "new",
        name: "Lunch",
        cost: 2,
        description: "Manual",
        stock: 1,
      });
      await expect(s.catalogue(add, user("U2"), c)).rejects.toThrow(/admins/);
      await s.catalogue(add, user("U9"), c);
      const r = (await s.rewards(c.team, true))[0];
      await s.catalogue(
        await job("catalogue", {
          reward: r.id,
          name: "Coffee",
          cost: 3,
          description: "Cafe",
          stock: null,
        }),
        user("U9"),
        c,
      );
      await s.catalogue(
        await job("catalogue", {
          reward: r.id,
          action: "archive",
          active: false,
        }),
        user("U9"),
        c,
      );
      await s.catalogue(
        await job("catalogue", {
          reward: r.id,
          action: "archive",
          active: false,
        }),
        user("U9"),
        c,
      );
      expect(await s.rewards(c.team)).toHaveLength(0);
      expect(await s.reward(c.team, r.id)).toMatchObject({
        name: "Coffee",
        cost: 3,
        stock: null,
        active: false,
      });
    });
    it("competing fulfil/cancel cannot both win; cancellation and repeated refunds restore stock once", async () => {
      await seed();
      const r = await reward(2, 1),
        i = await s.intent(c.team, "U2", r.id),
        id = await redeem("U2", i.id);
      const cancel1 = await job("admin_action", {
          request: id,
          action: "cancel",
          user: "U9",
        }),
        cancel2 = await job("admin_action", {
          request: id,
          action: "cancel",
          user: "U9",
        });
      await Promise.all([
        s.adminAction(cancel1, user("U9"), c),
        s.adminAction(cancel2, user("U9"), c),
      ]);
      expect((await s.balance(c.team, "U2")).balance).toBe(10);
      expect((await s.reward(c.team, r.id))?.stock).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pizza_ledger WHERE kind='refund'",
          )
        ).rows[0].n,
      ).toBe(1);
      const next = await s.intent(c.team, "U2", r.id),
        id2 = await redeem("U2", next.id),
        f = await job("admin_action", {
          request: id2,
          action: "fulfill",
          user: "U9",
        }),
        x = await job("admin_action", {
          request: id2,
          action: "cancel",
          user: "U9",
        });
      const statuses = await Promise.all([
        s.adminAction(f, user("U9"), c),
        s.adminAction(x, user("U9"), c),
      ]);
      expect(new Set(statuses).size).toBe(1);
    });
    it("unauthorised admin cannot act, fulfilled cannot refund", async () => {
      await seed();
      const r = await reward(),
        i = await s.intent(c.team, "U2", r.id),
        id = await redeem("U2", i.id);
      await expect(
        s.adminAction(
          await job("admin_action", { request: id, action: "cancel" }),
          user("U2"),
          c,
        ),
      ).rejects.toThrow(/admins/);
      await s.adminAction(
        await job("admin_action", { request: id, action: "fulfill" }),
        user("U9"),
        c,
      );
      expect(
        await s.adminAction(
          await job("admin_action", { request: id, action: "cancel" }),
          user("U9"),
          c,
        ),
      ).toBe("fulfilled");
      expect((await s.balance(c.team, "U2")).balance).toBe(8);
    });
    it("leaderboard scores earned regardless of redemption and ties sort by Slack ID", async () => {
      await give(award("U1", ["U3", "U2"], 2));
      const r = await reward(),
        i = await s.intent(c.team, "U2", r.id);
      await redeem("U2", i.id);
      expect(await s.leaderboard(c.team, period("all"))).toEqual([
        { user_id: "U2", slices: 2, rank: 1 },
        { user_id: "U3", slices: 2, rank: 1 },
      ]);
    });
    it("given standings avoid recipient join inflation and both scores ignore spending", async () => {
      await give(award("U1", ["U2", "U3"], 1));
      await give(award("U1", ["U2"], 2));
      await give(award("U4", ["U3"], 3));
      const all = period("all"),
        snapshot = await s.celebrationSnapshot(c.team, all);
      expect(snapshot).toMatchObject({
        messages: 3,
        slices: 7,
        givers: 2,
        recipients: 2,
        participants: 4,
      });
      expect(snapshot.given).toEqual([
        { user_id: "U1", slices: 4, teammates: 2, rank: 1 },
        { user_id: "U4", slices: 3, teammates: 1, rank: 2 },
      ]);
      const r = await reward(2),
        i = await s.intent(c.team, "U2", r.id);
      await redeem("U2", i.id);
      expect(await s.leaderboard(c.team, all, "received")).toEqual(
        snapshot.received,
      );
      expect(await s.leaderboard(c.team, all, "given")).toEqual(snapshot.given);
    });
    it("uses start-inclusive/end-exclusive original timestamp, with microsecond precision", async () => {
      const p = latestDue("week", new Date("2026-10-09T12:00:00Z")),
        start = p.start!.getTime() / 1000,
        end = p.end!.getTime() / 1000;
      for (const stamp of [
        `${start}.000000`,
        `${end}.000000`,
        `${end - 1}.999999`,
        `${start - 1}.999999`,
      ])
        await give({ ...award("U1", ["U2"], 1), ts: stamp });
      expect((await s.celebrationSnapshot(c.team, p)).messages).toBe(2);
      const current = period("week", p.end!);
      expect((await s.celebrationSnapshot(c.team, current)).messages).toBe(1);
    });
    it("Dubai calendar year transition uses original timestamps and genuine deterministic highlights", async () => {
      const p = period("month", new Date("2027-01-02T00:00:00Z")),
        start = p.start!.getTime() / 1000,
        end = p.end!.getTime() / 1000;
      const reasons = [
        "before month",
        "thanks for the real launch",
        "real final handover",
        "next month",
      ];
      const stamps = [
        `${start - 1}.999999`,
        `${start}.000000`,
        `${end - 1}.999999`,
        `${end}.000000`,
      ];
      for (let i = 0; i < stamps.length; i++)
        await give({
          ...award(`U1${i}`, [`U2${i}`], 1),
          ts: stamps[i],
          reason: reasons[i],
        });
      const first = await s.celebrationSnapshot(c.team, p),
        second = await s.celebrationSnapshot(c.team, p);
      expect(first.messages).toBe(2);
      expect(first.highlights).toEqual(second.highlights);
      expect(first.highlights.map((h) => h.reason).sort()).toEqual(
        [reasons[1], reasons[2]].sort(),
      );
      expect(new Set(first.highlights.map((h) => h.id)).size).toBe(2);
      expect(new Set(first.highlights.map((h) => h.recipient)).size).toBe(2);
      expect(first.highlights.every((h) => h.channel === "C1")).toBe(true);
    });
    it("all top ties are counted beyond the private top-ten list", async () => {
      for (let n = 0; n < 13; n++) await give(award(`U1${n}`, [`U3${n}`], 1));
      const snapshot = await s.celebrationSnapshot(c.team, period("all"));
      expect(snapshot.received).toHaveLength(13);
      expect(snapshot.received.every((row) => row.rank === 1)).toBe(true);
      expect(await s.leaderboard(c.team, period("all"))).toHaveLength(10);
    });
    it("celebration receipt and outbox commit once under concurrent drains and restart", async () => {
      const p = latestDue("week", new Date("2026-10-09T12:00:00Z"));
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          s.queueCelebration(
            c.team,
            p,
            0,
            { text: "Empty truthful recap" },
            "C1",
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await new PizzaStore(pool).queueCelebration(
          c.team,
          p,
          0,
          { text: "Retry" },
          "C1",
        ),
      ).toBe(false);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_celebrations"))
          .rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pizza_outbox WHERE notification_key LIKE 'celebration:%'",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("pending in-period awards delay recap; accepted changes during link lookup force a new snapshot", async () => {
      const p = latestDue("week", new Date("2026-10-09T12:00:00Z")),
        a = {
          ...award(),
          ts: String(p.start!.getTime() / 1000 + 10) + ".000001",
        },
        j = await job("award", a);
      expect(await s.celebrationReady(c.team, p)).toBe(false);
      expect(
        await s.queueCelebration(c.team, p, 0, { text: "Stale" }, "C1"),
      ).toBe(false);
      await s.award(j, a, [user("U1"), user("U2")], c);
      expect(
        await s.queueCelebration(c.team, p, 0, { text: "Stale" }, "C1"),
      ).toBe(false);
      const snapshot = await s.celebrationSnapshot(c.team, p);
      expect(snapshot.messages).toBe(1);
      await s.enqueue(c.team, "future", "award", {
        ...a,
        ts: String(p.end!.getTime() / 1000 + 1) + ".000001",
      });
      expect(
        await s.queueCelebration(
          c.team,
          p,
          snapshot.messages,
          { text: "Fresh" },
          "C1",
        ),
      ).toBe(true);
    });
    it("scheduler guards activation/pause and bounds outage recovery to latest week/month", async () => {
      const api = { permalink: async () => null } as unknown as PizzaSlack,
        enabled = {
          ...c,
          celebrationsEnabled: true,
          celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
        };
      expect(
        await scheduleCelebrations(
          s,
          api,
          enabled,
          new Date("2026-10-08T10:00:00Z"),
        ),
      ).toBe(0);
      expect(
        await scheduleCelebrations(
          s,
          api,
          { ...enabled, enabled: false },
          new Date("2026-12-15T10:00:00Z"),
        ),
      ).toBe(0);
      expect(
        await scheduleCelebrations(
          s,
          api,
          enabled,
          new Date("2026-12-15T10:00:00Z"),
        ),
      ).toBe(2);
      expect(
        await scheduleCelebrations(
          new PizzaStore(pool),
          api,
          enabled,
          new Date("2026-12-15T10:00:00Z"),
        ),
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT period_kind,period_start FROM pizza_celebrations ORDER BY period_kind",
          )
        ).rows,
      ).toHaveLength(2);
    });
    it("failed outbox insertion rolls back schedule receipt and later drain recovers it", async () => {
      const p = latestDue("week", new Date("2026-10-09T12:00:00Z"));
      await pool.query(
        "CREATE FUNCTION test_fail_celebration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary outbox failure'; END $$; CREATE TRIGGER test_fail_celebration BEFORE INSERT ON pizza_outbox FOR EACH ROW EXECUTE FUNCTION test_fail_celebration()",
      );
      await expect(
        s.queueCelebration(c.team, p, 0, { text: "Recap" }, "C1"),
      ).rejects.toThrow(/temporary/);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_celebrations"))
          .rows[0].n,
      ).toBe(0);
      await pool.query(
        "DROP TRIGGER test_fail_celebration ON pizza_outbox; DROP FUNCTION test_fail_celebration()",
      );
      expect(
        await s.queueCelebration(c.team, p, 0, { text: "Recap" }, "C1"),
      ).toBe(true);
    });
    it("goal can precede first award, change and clear without ledger/account side effects", async () => {
      const a = await reward(12),
        b = await reward(6);
      await s.setGoal(
        await job("goal", { user: "U5", reward: a.id }),
        user("U5"),
        c,
      );
      expect((await s.goal(c.team, "U5"))!.cost).toBe(12);
      expect((await s.balance(c.team, "U5")).balance).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pizza_users WHERE user_id='U5'",
          )
        ).rows[0].n,
      ).toBe(0);
      await s.setGoal(
        await job("goal", { user: "U5", reward: b.id }),
        user("U5"),
        c,
      );
      expect((await s.goal(c.team, "U5"))!.id).toBe(b.id);
      await s.setGoal(
        await job("goal", { user: "U5", reward: null }),
        user("U5"),
        c,
      );
      expect(await s.goal(c.team, "U5")).toBeNull();
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_ledger")).rows[0]
          .n,
      ).toBe(0);
    });
    it("cross-team, unknown, archived, sold-out and spoofed goal requests fail", async () => {
      const r = await reward();
      await expect(
        s.setGoal(
          await job("goal", { user: "U2", reward: r.id }),
          user("U3"),
          c,
        ),
      ).rejects.toThrow(/own reward/);
      await pool.query("UPDATE pizza_rewards SET team_id='T2' WHERE id=$1", [
        r.id,
      ]);
      await expect(
        s.setGoal(
          await job("goal", { user: "U2", reward: r.id }),
          user("U2"),
          c,
        ),
      ).rejects.toThrow(/active/);
      await pool.query(
        "UPDATE pizza_rewards SET team_id='T1',active=false WHERE id=$1",
        [r.id],
      );
      await expect(
        s.setGoal(
          await job("goal", { user: "U2", reward: r.id }),
          user("U2"),
          c,
        ),
      ).rejects.toThrow(/active/);
      await pool.query(
        "UPDATE pizza_rewards SET active=true,stock=0 WHERE id=$1",
        [r.id],
      );
      await expect(
        s.setGoal(
          await job("goal", { user: "U2", reward: r.id }),
          user("U2"),
          c,
        ),
      ).rejects.toThrow(/active/);
      await expect(
        s.setGoal(
          await job("goal", {
            user: "U2",
            reward: "11111111-1111-4111-8111-111111111111",
          }),
          user("U2"),
          c,
        ),
      ).rejects.toThrow(/active/);
      expect(await s.goal(c.team, "U2")).toBeNull();
    });
    it("goal reads latest price/availability; custom tier price remains explicitly chosen", async () => {
      const add = await job("catalogue", {
        reward: "new",
        name: "Real prize",
        cost: 7,
        description: "Georgia decides",
        stock: 1,
        tier: "large",
      });
      await s.catalogue(add, user("U9"), c);
      const r = (await s.rewards(c.team))[0];
      expect(r).toMatchObject({ tier: "large", cost: 7 });
      await s.setGoal(
        await job("goal", { user: "U2", reward: r.id }),
        user("U2"),
        c,
      );
      await pool.query(
        "UPDATE pizza_rewards SET cost=12,active=false WHERE id=$1",
        [r.id],
      );
      expect(await s.goal(c.team, "U2")).toMatchObject({
        cost: 12,
        active: false,
      });
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_ledger")).rows[0]
          .n,
      ).toBe(0);
    });
    it("removes delivered recap quote copies after 30 days while preserving pending content/receipts", async () => {
      const p = latestDue("week", new Date("2026-10-09T12:00:00Z"));
      await s.queueCelebration(
        c.team,
        p,
        0,
        { text: "Summary", blocks: [{ text: "private excerpt" }] },
        "C1",
      );
      await pool.query(
        "UPDATE pizza_outbox SET created_at=now()-interval '31 days'",
      );
      await s.maintenance(c.team);
      expect(
        (await pool.query("SELECT payload FROM pizza_outbox")).rows[0].payload
          .blocks,
      ).toBeDefined();
      await pool.query("UPDATE pizza_outbox SET status='sent'");
      await s.maintenance(c.team);
      expect(
        (await pool.query("SELECT payload,notification_key FROM pizza_outbox"))
          .rows[0].payload.blocks,
      ).toBeUndefined();
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_celebrations"))
          .rows[0].n,
      ).toBe(1);
    });
    it("private preview results clear response capability and redact excerpts without a public receipt", async () => {
      const preview = await job("command", {
        user: "U9",
        channel: "G2",
        responseUrl: "https://hooks.slack.com/commands/secret",
        responseExpires: Date.now() + 60000,
      });
      await s.finish(
        preview,
        { text: "Private preview", blocks: [{ text: "original reason" }] },
        false,
        "preview",
      );
      const delivery = (await s.claim("pizza_outbox", c.team)) as Outbox;
      expect(delivery.notification_key).toBe(`preview:${preview.id}`);
      expect(delivery.target.kind).toBe("response");
      await s.delivered(delivery);
      expect(
        (
          await pool.query("SELECT payload FROM pizza_inbox WHERE id=$1", [
            preview.id,
          ])
        ).rows[0].payload.responseUrl,
      ).toBeUndefined();
      await pool.query(
        "UPDATE pizza_outbox SET created_at=now()-interval '31 days'",
      );
      await s.maintenance(c.team);
      const row = (
        await pool.query(
          "SELECT payload,notification_key,status FROM pizza_outbox",
        )
      ).rows[0];
      expect(row.payload.blocks).toBeUndefined();
      expect(row.notification_key).toBe(`preview:${preview.id}`);
      expect(row.status).toBe("sent");
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_celebrations"))
          .rows[0].n,
      ).toBe(0);
    });
    it("outbox retries and expired leases do not change ledger; response secrets removed on delivery", async () => {
      await give();
      let o = (await s.claim("pizza_outbox", c.team)) as Outbox;
      await s.retry("pizza_outbox", o, 30, "rate_limited");
      expect(await s.claim("pizza_outbox", c.team)).toBeNull();
      await pool.query(
        "UPDATE pizza_outbox SET retry_at=now()-interval '1 second'",
      );
      o = (await s.claim("pizza_outbox", c.team)) as Outbox;
      await pool.query(
        "UPDATE pizza_outbox SET lease_until=now()-interval '1 second'",
      );
      const newer = (await s.claim("pizza_outbox", c.team)) as Outbox;
      await s.delivered(o, "stale");
      expect(
        (await pool.query("SELECT status FROM pizza_outbox")).rows[0].status,
      ).toBe("running");
      await s.delivered(newer, "known");
      expect((await s.balance(c.team, "U2")).balance).toBe(1);
      const cmd = await job("command", {
        user: "U2",
        channel: "C1",
        responseUrl: "https://hooks.slack.com/commands/secret",
        responseExpires: Date.now() + 60000,
      });
      await s.finish(cmd, { text: "balance" });
      const response = (await s.claim("pizza_outbox", c.team)) as Outbox;
      await s.delivered(response);
      expect(
        (
          await pool.query("SELECT payload FROM pizza_inbox WHERE id=$1", [
            cmd.id,
          ])
        ).rows[0].payload.responseUrl,
      ).toBeUndefined();
    });
    it("purges raw inbound text and expired capabilities while preserving accounting keys", async () => {
      await give();
      await pool.query(
        "UPDATE pizza_inbox SET completed_at=now()-interval '31 days'; UPDATE pizza_awards SET created_at=now()-interval '31 days'",
      );
      await s.maintenance(c.team);
      expect(
        (await pool.query("SELECT payload FROM pizza_inbox")).rows[0].payload,
      ).toBeNull();
      expect(
        (await pool.query("SELECT reason FROM pizza_awards")).rows[0].reason,
      ).toBeNull();
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_ledger")).rows[0]
          .n,
      ).toBe(1);
    });
    it("bounded DB stall fails durable ingestion inside the Slack acknowledgement budget", async () => {
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK pizza_inbox IN ACCESS EXCLUSIVE MODE");
      const bounded = new Pool({
        connectionString: dsn,
        connectionTimeoutMillis: 300,
        statement_timeout: 650,
        query_timeout: 800,
        options: `-c search_path=${schema},public`,
      });
      const started = Date.now();
      try {
        await expect(
          new PizzaStore(bounded).enqueue(c.team, "stalled", "award", {}),
        ).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(1900);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await bounded.end();
      }
    });
    it("fails ingestion when schema missing rather than accepting in memory", async () => {
      const bare = new Pool({
        connectionString: dsn,
        options: "-c search_path=pg_catalog",
      });
      try {
        await expect(
          new PizzaStore(bare).enqueue(c.team, "missing", "award", {}),
        ).rejects.toThrow(/does not exist/);
      } finally {
        await bare.end();
      }
    });
    it("dynamic allowance supports more than five; lowering clamps without refund and raising restores only unused allowance", async () => {
      await setSettings({ dailyLimit: 10 });
      const now = String(Math.floor(Date.now() / 1000)) + ".000001";
      await give({ ...award("U1", ["U2"], 7), ts: now });
      expect(await s.balance(c.team, "U1")).toMatchObject({
        remaining: 3,
        dailyLimit: 10,
      });
      await setSettings({ dailyLimit: 3 });
      expect(await s.balance(c.team, "U1")).toMatchObject({
        remaining: 0,
        dailyLimit: 3,
      });
      expect(
        await give({
          ...award("U1", ["U2"], 1),
          ts: now.replace("000001", "000002"),
        }),
      ).toBe("rejected");
      expect(
        (
          await pool.query(
            "SELECT used,daily_limit FROM pizza_daily_usage WHERE giver_id='U1'",
          )
        ).rows[0],
      ).toEqual({ used: 7, daily_limit: 3 });
      await setSettings({ dailyLimit: 9 });
      expect(await s.balance(c.team, "U1")).toMatchObject({ remaining: 2 });
      expect(
        await give({
          ...award("U1", ["U2"], 2),
          ts: now.replace("000001", "000003"),
        }),
      ).toBe("accepted");
      expect((await s.balance(c.team, "U2")).earned).toBe(9);
    });
    it("zero pauses recognition only; settings and other operations remain available", async () => {
      await setSettings({ dailyLimit: 0 });
      expect(await give()).toBe("rejected");
      expect(
        (await pool.query("SELECT rejection FROM pizza_awards")).rows[0]
          .rejection,
      ).toContain("Giving is paused");
      expect(await s.balance(c.team, "U1")).toMatchObject({
        remaining: 0,
        dailyLimit: 0,
      });
      await adjust(6);
      const r = await reward(2),
        intent = await s.intent(c.team, "U2", r.id);
      await redeem("U2", intent.id);
      await setSettings({ dailyLimit: 5 });
      expect(await give()).toBe("accepted");
    });
    it("settings optimistic revisions serialize concurrent saves, reject stale/replay and no-op creates no history", async () => {
      const { version, ...values } = DEFAULT_SETTINGS;
      const one = await job("settings", {
          user: "U9",
          version,
          values: { ...values, dailyLimit: 8 },
        }),
        two = await job("settings", {
          user: "U9",
          version,
          values: { ...values, dailyLimit: 9 },
        });
      const results = await Promise.allSettled([
        s.saveSettings(one, user("U9"), c),
        s.saveSettings(two, user("U9"), c),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(Refusal);
      expect(rejected.reason.message).toMatch(/Settings changed/);
      const success = results[0].status === "fulfilled" ? one : two;
      await expect(
        s.saveSettings(success, user("U9"), c),
      ).rejects.toBeInstanceOf(LostLease);
      const current = await s.settings(c.team);
      await setSettings();
      expect(await s.settings(c.team)).toEqual(current);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_settings_changes"))
          .rows[0].n,
      ).toBe(1);
    });
    it("settings reject spoofed actor, nonadmin, guest, wrong team and invalid values, and remain team isolated", async () => {
      const { version, ...values } = DEFAULT_SETTINGS;
      for (const actor of [
        user("U2"),
        user("U9", { deleted: true }),
        user("U9", { team_id: "T2" }),
      ]) {
        const j = await job("settings", {
          user: "U9",
          version,
          values: { ...values, dailyLimit: 8 },
        });
        await expect(s.saveSettings(j, actor, c)).rejects.toBeInstanceOf(
          Refusal,
        );
      }
      const wrong = await job("settings", { user: "U9", version, values });
      await expect(
        s.saveSettings({ ...wrong, team_id: "T2" }, user("U9"), c),
      ).rejects.toBeInstanceOf(Refusal);
      for (const change of [
        { dailyLimit: -1 },
        { dailyLimit: 1001 },
        { smallCost: 0 },
        { largeCost: 1000001 },
        { monthlyEnabled: "true" },
        { token: "secret" },
      ]) {
        const j = await job("settings", {
          user: "U9",
          version,
          values: { ...values, ...change },
        });
        await expect(s.saveSettings(j, user("U9"), c)).rejects.toBeInstanceOf(
          Refusal,
        );
      }
      await setSettings({
        dailyLimit: 8,
        smallCost: 14,
        mediumCost: 2,
        largeCost: 1,
      });
      expect(await s.settings("T2")).toEqual(DEFAULT_SETTINGS);
      expect((await s.settings(c.team)).dailyLimit).toBe(8);
    });
    it("award waits for settings save lock then uses newly committed limit, without resetting original day usage", async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${c.team}:settings`],
      );
      await client.query(
        "INSERT INTO pizza_settings(team_id,daily_limit) VALUES('T1',9)",
      );
      const a = award("U1", ["U2"], 8),
        j = await job("award", a);
      let done = false;
      const waiting = s.award(j, a, [user("U1"), user("U2")], c).then((r) => {
        done = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(done).toBe(false);
      await client.query("COMMIT");
      client.release();
      expect(await waiting).toBe("accepted");
      expect(
        (await pool.query("SELECT used,daily_limit FROM pizza_daily_usage"))
          .rows[0],
      ).toEqual({ used: 8, daily_limit: 9 });
    });
    it("new presets and report switches never reprice existing rewards/intents or stop committed reports", async () => {
      await adjust(20);
      const r = await reward(6),
        i = await s.intent(c.team, "U2", r.id);
      const week = latestDue("week", new Date("2026-10-09T12:00:00Z")),
        month = latestDue("month", new Date("2026-11-01T06:00:00Z"));
      expect(
        await s.queueCelebration(c.team, week, 0, { text: "Committed" }, "C1"),
      ).toBe(true);
      await setSettings({
        smallCost: 9,
        mediumCost: 3,
        largeCost: 20,
        weeklyEnabled: false,
        monthlyEnabled: false,
      });
      expect((await s.reward(c.team, r.id))!.cost).toBe(6);
      expect(
        (
          await pool.query(
            "SELECT confirmed_cost FROM pizza_redemption_intents WHERE id=$1",
            [i.id],
          )
        ).rows[0].confirmed_cost,
      ).toBe(6);
      expect(
        await s.queueCelebration(
          c.team,
          month,
          0,
          { text: "Do not queue" },
          "C1",
        ),
      ).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT status FROM pizza_outbox WHERE notification_key LIKE 'celebration:%'",
          )
        ).rows[0].status,
      ).toBe("pending");
      await setSettings({ monthlyEnabled: true });
      expect(
        await s.queueCelebration(
          c.team,
          month,
          0,
          { text: "Latest month" },
          "C1",
        ),
      ).toBe(true);
    });
    it("report final transaction sees a switch disabled during permalink lookup", async () => {
      const now = new Date("2026-10-09T12:00:00Z"),
        p = latestDue("week", now);
      await give({
        ...award(),
        ts: String(p.start!.getTime() / 1000 + 1) + ".000001",
      });
      let calls = 0;
      const api = {
        permalink: async () => {
          calls++;
          await setSettings({ weeklyEnabled: false });
          return "https://gr.slack.com/archives/C1/p1";
        },
      } as unknown as PizzaSlack;
      expect(
        await scheduleCelebrations(
          s,
          api,
          {
            ...c,
            celebrationsEnabled: true,
            celebrationsStartAt: new Date("2026-10-08T00:00:00Z"),
          },
          now,
        ),
      ).toBe(0);
      expect(calls).toBe(1);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_celebrations"))
          .rows[0].n,
      ).toBe(0);
    });
    it("balance corrections before first award credit/debit once without recognition or daily allowance changes", async () => {
      const first = await adjust(
        12,
        "U5",
        "  Onboarding correction <@U999> *literal*  ",
      );
      await adjust(-5, "U5");
      expect(await s.balance(c.team, "U5")).toMatchObject({
        earned: 0,
        balance: 7,
        remaining: 5,
      });
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_awards")).rows[0]
          .n,
      ).toBe(0);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_daily_usage"))
          .rows[0].n,
      ).toBe(0);
      expect(await s.leaderboard(c.team, period("all"))).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT kind,earned_delta,balance_delta FROM pizza_ledger ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { kind: "adjustment", earned_delta: 0, balance_delta: 12 },
        { kind: "adjustment", earned_delta: 0, balance_delta: -5 },
      ]);
      const audit = (
        await pool.query(
          "SELECT * FROM pizza_balance_adjustments WHERE job_id=$1",
          [first.id],
        )
      ).rows[0];
      expect(audit).toMatchObject({
        actor: "U9",
        recipient: "U5",
        delta: 12,
        before_balance: 0,
        after_balance: 12,
        reason: "Onboarding correction <@U999> *literal*",
      });
      const notifications = (
        await pool.query(
          "SELECT target,payload FROM pizza_outbox WHERE notification_key LIKE 'adjustment-%' AND notification_key LIKE $1",
          [`%${first.id}`],
        )
      ).rows;
      expect(notifications).toHaveLength(2);
      expect(notifications.every((n) => n.target.kind === "ephemeral")).toBe(
        true,
      );
      expect(JSON.stringify(notifications[0].payload.blocks)).toContain(
        '"type":"plain_text"',
      );
      expect(
        await s.adjustBalance(first, user("U9"), user("U5"), c).catch((e) => e),
      ).toBeInstanceOf(LostLease);
      expect((await s.balance(c.team, "U5")).balance).toBe(7);
    });
    it("adjustments reject insufficient funds/overflow and duplicate concurrent lease cannot debit twice", async () => {
      await adjust(3);
      await expect(adjust(-4)).rejects.toBeInstanceOf(Refusal);
      await pool.query(
        "UPDATE pizza_users SET balance=2147483647 WHERE team_id='T1' AND user_id='U2'",
      );
      await expect(adjust(1)).rejects.toBeInstanceOf(Refusal);
      await pool.query(
        "UPDATE pizza_users SET balance=3 WHERE team_id='T1' AND user_id='U2'",
      );
      const j = await job("adjustment", {
        user: "U9",
        recipient: "U2",
        delta: -2,
        reason: "Single debit",
      });
      const results = await Promise.allSettled([
        s.adjustBalance(j, user("U9"), user("U2"), c),
        s.adjustBalance(j, user("U9"), user("U2"), c),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await s.balance(c.team, "U2")).balance).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pizza_balance_adjustments",
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it("adjustment authority and freshly passed recipient identity reject spoof, foreign, bots, guests, deleted and allowlist exclusions", async () => {
      const j = await job("adjustment", {
        user: "U9",
        recipient: "U2",
        delta: 5,
        reason: "Correction",
      });
      for (const target of [
        user("U3"),
        user("U2", { is_bot: true }),
        user("U2", { is_restricted: true }),
        user("U2", { deleted: true }),
        user("U2", { team_id: "T2" }),
      ])
        await expect(
          s.adjustBalance(j, user("U9"), target, c),
        ).rejects.toBeInstanceOf(Refusal);
      for (const actor of [
        user("U2"),
        user("U9", { is_bot: true }),
        user("U9", { team_id: "T2" }),
      ])
        await expect(
          s.adjustBalance(j, actor, user("U2"), c),
        ).rejects.toBeInstanceOf(Refusal);
      await expect(
        s.adjustBalance({ ...j, team_id: "T2" }, user("U9"), user("U2"), c),
      ).rejects.toBeInstanceOf(Refusal);
      await expect(
        s.adjustBalance(j, user("U9"), user("U2"), {
          ...c,
          participants: ["U9"],
        }),
      ).rejects.toBeInstanceOf(Refusal);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_users")).rows[0].n,
      ).toBe(0);
    });
    it("forced notification failure rolls back correction account, ledger, audit and completion atomically", async () => {
      await pool.query(
        "ALTER TABLE pizza_outbox ADD CONSTRAINT fail_adjustment_notification CHECK(notification_key NOT LIKE 'adjustment-recipient:%')",
      );
      const j = await job("adjustment", {
        user: "U9",
        recipient: "U5",
        delta: 8,
        reason: "Atomic correction",
      });
      await expect(
        s.adjustBalance(j, user("U9"), user("U5"), c),
      ).rejects.toThrow();
      for (const table of [
        "pizza_users",
        "pizza_ledger",
        "pizza_balance_adjustments",
        "pizza_outbox",
      ])
        expect(
          (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        ).toBe(0);
      expect(
        (await pool.query("SELECT status FROM pizza_inbox WHERE id=$1", [j.id]))
          .rows[0].status,
      ).toBe("running");
      await pool.query(
        "ALTER TABLE pizza_outbox DROP CONSTRAINT fail_adjustment_notification",
      );
      await s.adjustBalance(j, user("U9"), user("U5"), c);
      expect((await s.balance(c.team, "U5")).balance).toBe(8);
    });
    it("concurrent correction with redemption and refund preserves earned, total balance and stock", async () => {
      await seed("U2", 10);
      const r = await reward(3, 1),
        i = await s.intent(c.team, "U2", r.id);
      const aj = await job("adjustment", {
          user: "U9",
          recipient: "U2",
          delta: -2,
          reason: "Reconcile",
        }),
        rj = await job("redeem", { intent: i.id, user: "U2", channel: "C1" });
      const [, rid] = await Promise.all([
        s.adjustBalance(aj, user("U9"), user("U2"), c),
        s.redeem(rj, user("U2"), c),
      ]);
      expect((await s.balance(c.team, "U2")).balance).toBe(5);
      const bj = await job("adjustment", {
          user: "U9",
          recipient: "U2",
          delta: 4,
          reason: "Reconcile again",
        }),
        cancel = await job("admin_action", {
          user: "U9",
          request: rid,
          action: "cancel",
        });
      await Promise.all([
        s.adjustBalance(bj, user("U9"), user("U2"), c),
        s.adminAction(cancel, user("U9"), c),
      ]);
      expect(await s.balance(c.team, "U2")).toMatchObject({
        earned: 10,
        balance: 12,
      });
      expect((await s.reward(c.team, r.id))!.stock).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT sum(balance_delta)::int balance,sum(earned_delta)::int earned FROM pizza_ledger WHERE user_id='U2'",
          )
        ).rows[0],
      ).toEqual({ balance: 12, earned: 10 });
    });
    it("history persists after inbox retention, paginates ten and isolates teams; new ledger retains append-only and delta guards", async () => {
      for (let n = 0; n < 12; n++) await adjust(1, "U2", `Reason ${n}`);
      await pool.query(
        "UPDATE pizza_inbox SET completed_at=now()-interval '31 days'",
      );
      await s.maintenance(c.team);
      expect(
        (await pool.query("SELECT payload FROM pizza_inbox")).rows.every(
          (r) => r.payload === null,
        ),
      ).toBe(true);
      expect(await s.adminHistory(c.team, 0)).toHaveLength(10);
      expect(await s.adminHistory(c.team, 1)).toHaveLength(2);
      expect(await s.adminHistory("T2", 0)).toEqual([]);
      expect((await s.adminHistory(c.team))[0]).toMatchObject({
        actor: "U9",
        recipient: "U2",
        reason: expect.any(String),
      });
      await expect(
        pool.query(
          "UPDATE pizza_ledger SET balance_delta=2 WHERE kind='adjustment'",
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM pizza_ledger WHERE kind='adjustment'"),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES('T1','U2','adjustment',gen_random_uuid(),'U9',1,1,'invalid-adjust')",
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "INSERT INTO pizza_ledger(team_id,user_id,kind,reference_id,actor,earned_delta,balance_delta,operation_key) VALUES('T1','U2','award',gen_random_uuid(),'U9',0,1,'invalid-award')",
        ),
      ).rejects.toThrow();
    });
    it("an actual concurrent settings save waits for an award's shared lock and applies only afterward", async () => {
      let unlock!: () => void, started!: () => void;
      const release = new Promise<void>((r) => {
          unlock = r;
        }),
        entered = new Promise<void>((r) => {
          started = r;
        });
      class HeldAwardStore extends PizzaStore {
        override async settings(...args: Parameters<PizzaStore["settings"]>) {
          const value = await super.settings(...args);
          if (args[2] === "shared") {
            started();
            await release;
          }
          return value;
        }
      }
      const a = award("U1", ["U2"], 5),
        aj = await job("award", a),
        { version, ...values } = DEFAULT_SETTINGS;
      const sj = await job("settings", {
        user: "U9",
        version,
        values: { ...values, dailyLimit: 2 },
      });
      const awardWork = new HeldAwardStore(pool).award(
        aj,
        a,
        [user("U1"), user("U2")],
        c,
      );
      await entered;
      let saved = false;
      const saveWork = s.saveSettings(sj, user("U9"), c).then(() => {
        saved = true;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(saved).toBe(false);
      unlock();
      expect(await awardWork).toBe("accepted");
      await saveWork;
      expect((await s.settings(c.team)).dailyLimit).toBe(2);
      expect(
        (await pool.query("SELECT used,daily_limit FROM pizza_daily_usage"))
          .rows[0],
      ).toEqual({ used: 5, daily_limit: 5 });
      expect((await s.balance(c.team, "U2")).earned).toBe(5);
    });
    it("settings audit/notification failure rolls back every setting change and can recover", async () => {
      const { version, ...values } = DEFAULT_SETTINGS,
        j = await job("settings", {
          user: "U9",
          version,
          values: { ...values, dailyLimit: 9 },
        });
      await pool.query(
        "ALTER TABLE pizza_outbox ADD CONSTRAINT fail_settings_notification CHECK(notification_key NOT LIKE 'settings:%')",
      );
      await expect(s.saveSettings(j, user("U9"), c)).rejects.toThrow();
      expect(await s.settings(c.team)).toEqual(DEFAULT_SETTINGS);
      expect(
        (await pool.query("SELECT count(*)::int n FROM pizza_settings_changes"))
          .rows[0].n,
      ).toBe(0);
      await pool.query(
        "ALTER TABLE pizza_outbox DROP CONSTRAINT fail_settings_notification",
      );
      await s.saveSettings(j, user("U9"), c);
      expect((await s.settings(c.team)).dailyLimit).toBe(9);
    });
    it("concurrent debit and redemption cannot overspend or lose slices", async () => {
      await adjust(8);
      const r = await reward(6),
        i = await s.intent(c.team, "U2", r.id);
      const aj = await job("adjustment", {
          user: "U9",
          recipient: "U2",
          delta: -6,
          reason: "Concurrent debit",
        }),
        rj = await job("redeem", { user: "U2", intent: i.id });
      const results = await Promise.allSettled([
        s.adjustBalance(aj, user("U9"), user("U2"), c),
        s.redeem(rj, user("U2"), c),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ).toBeInstanceOf(Refusal);
      expect(await s.balance(c.team, "U2")).toMatchObject({
        earned: 0,
        balance: 2,
      });
      expect(
        (
          await pool.query(
            "SELECT sum(balance_delta)::int balance FROM pizza_ledger",
          )
        ).rows[0].balance,
      ).toBe(2);
    });
  },
);
