import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { PizzaStore, Refusal, LostLease, type Job, type Outbox } from "./store";
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
      const migration = await readFile(
        new URL(
          "../../../db/migrations/2026-10-08_pizza_recognition.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration); // Exercise guards outside the history runner as well.
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE pizza_users,pizza_inbox,pizza_daily_usage,pizza_awards,pizza_award_recipients,pizza_rewards,pizza_redemption_intents,pizza_redemptions,pizza_ledger,pizza_outbox RESTART IDENTITY CASCADE",
      );
    });
    afterAll(async () => {
      if (pool) await pool.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
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
      expect(await s.leaderboard(c.team, true)).toEqual([
        { recipient_id: "U2", earned: 2 },
        { recipient_id: "U3", earned: 2 },
      ]);
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
  },
);
