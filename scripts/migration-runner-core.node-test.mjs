import assert from "node:assert/strict";
import test from "node:test";
import { loadMigrationFiles, migrationChecksum, runMigrationSet } from "./migration-runner-core.mjs";

class Mutex {
  #tail = Promise.resolve();
  async acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const previous = this.#tail;
    this.#tail = next;
    await previous;
    return release;
  }
}

function fakeDatabase() {
  const state = {
    ledger: new Map(),
    executed: [],
    lock: new Mutex(),
    unlocks: 0,
    releases: 0,
  };
  const connect = async () => {
    let releaseLock = null;
    let transaction = null;
    return {
      async query(sql, params = []) {
        const normalized = sql.trim().toLowerCase();
        if (normalized.startsWith("select pg_advisory_lock")) {
          releaseLock = await state.lock.acquire();
          return { rows: [] };
        }
        if (normalized.startsWith("select pg_advisory_unlock")) {
          state.unlocks += 1;
          releaseLock?.();
          releaseLock = null;
          return { rows: [] };
        }
        if (normalized.startsWith("create table if not exists schema_migrations")) return { rows: [] };
        if (normalized.startsWith("select filename, checksum")) {
          return { rows: [...state.ledger].map(([filename, checksum]) => ({ filename, checksum })) };
        }
        if (normalized === "begin") {
          transaction = { ledger: new Map(state.ledger), executedLength: state.executed.length };
          return { rows: [] };
        }
        if (normalized === "commit") {
          transaction = null;
          return { rows: [] };
        }
        if (normalized === "rollback") {
          state.ledger = new Map(transaction.ledger);
          state.executed.length = transaction.executedLength;
          transaction = null;
          return { rows: [] };
        }
        if (normalized.startsWith("insert into schema_migrations")) {
          state.ledger.set(params[0], params[1]);
          return { rows: [] };
        }
        if (sql.includes("FAIL")) throw new Error("simulated SQL failure");
        state.executed.push(sql);
        return { rows: [] };
      },
      async release() { state.releases += 1; },
    };
  };
  return { state, connect };
}

const migration = (filename, sql) => ({ filename, sql, checksum: migrationChecksum(sql) });

test("loads migration files in lexical order with stable checksums", async () => {
  const files = {
    "/migrations/002.sql": "select 2;",
    "/migrations/001.sql": "select 1;",
  };
  const migrations = await loadMigrationFiles({
    directory: "/migrations",
    readdir: async () => ["002.sql", "notes.txt", "001.sql"],
    readFile: async (path) => files[path],
  });
  assert.deepEqual(migrations.map((item) => item.filename), ["001.sql", "002.sql"]);
  assert.equal(migrations[0].checksum, migrationChecksum("select 1;"));
});

test("every repository migration uses repeatable PostgreSQL guards", async () => {
  const migrations = await loadMigrationFiles();
  assert.ok(migrations.length > 0);
  assert.deepEqual(migrations.map((item) => item.filename), [...migrations.map((item) => item.filename)].sort());
  for (const item of migrations) {
    assert.match(item.sql, /if not exists/i, `${item.filename} needs an idempotency guard`);
    assert.match(item.checksum, /^[a-f0-9]{64}$/);
  }
});

test("applies pending migrations once and repeats with zero SQL changes", async () => {
  const db = fakeDatabase();
  const migrations = [migration("002.sql", "select 2;"), migration("001.sql", "select 1;")];
  const first = await runMigrationSet({ migrations, connect: db.connect });
  const second = await runMigrationSet({ migrations, connect: db.connect });
  assert.deepEqual(first.map((item) => item.filename), ["001.sql", "002.sql"]);
  assert.deepEqual(second.map((item) => item.state), ["applied", "applied"]);
  assert.deepEqual(db.state.executed, ["select 1;", "select 2;"]);
});

test("reports pending migrations without applying them", async () => {
  const db = fakeDatabase();
  const results = await runMigrationSet({
    migrations: [migration("001.sql", "select 1;")],
    mode: "status",
    connect: db.connect,
  });
  assert.deepEqual(results, [{ filename: "001.sql", state: "pending" }]);
  assert.equal(db.state.executed.length, 0);
});

test("refuses checksum drift for a recorded filename", async () => {
  const db = fakeDatabase();
  db.state.ledger.set("001.sql", migrationChecksum("old"));
  await assert.rejects(
    runMigrationSet({ migrations: [migration("001.sql", "new")], connect: db.connect }),
    /checksum mismatch/
  );
  assert.equal(db.state.unlocks, 1);
});

test("rolls back SQL and ledger changes after a migration failure", async () => {
  const db = fakeDatabase();
  await assert.rejects(
    runMigrationSet({ migrations: [migration("001.sql", "FAIL")], connect: db.connect }),
    /rolled back: 001\.sql: simulated SQL failure/
  );
  assert.equal(db.state.ledger.size, 0);
  assert.equal(db.state.executed.length, 0);
  assert.equal(db.state.unlocks, 1);
  assert.equal(db.state.releases, 1);
});

test("serializes concurrent runners so only one executes a migration", async () => {
  const db = fakeDatabase();
  const migrations = [migration("001.sql", "select pg_sleep(0);")];
  await Promise.all([
    runMigrationSet({ migrations, connect: db.connect }),
    runMigrationSet({ migrations, connect: db.connect }),
  ]);
  assert.deepEqual(db.state.executed, ["select pg_sleep(0);"]);
  assert.equal(db.state.unlocks, 2);
});
