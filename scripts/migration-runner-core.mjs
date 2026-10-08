import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MIGRATION_LOCK_ID = "477241746369001";

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function loadMigrationFiles(input = {}) {
  const directory = input.directory ?? resolve(process.cwd(), "db/migrations");
  const readDirectory = input.readdir ?? readdir;
  const read = input.readFile ?? readFile;
  const filenames = (await readDirectory(directory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  const migrations = [];
  for (const filename of filenames) {
    const sql = await read(resolve(directory, filename), "utf8");
    migrations.push({ filename, sql, checksum: migrationChecksum(sql) });
  }
  return migrations;
}

function validateMigrations(migrations) {
  const filenames = migrations.map((migration) => migration.filename);
  if (new Set(filenames).size !== filenames.length) throw new Error("Migration filenames must be unique");
  for (const migration of migrations) {
    if (!migration.filename.endsWith(".sql") || !migration.sql.trim()) {
      throw new Error(`Invalid migration file: ${migration.filename}`);
    }
    if (migration.checksum !== migrationChecksum(migration.sql)) {
      throw new Error(`Migration checksum was not computed from file contents: ${migration.filename}`);
    }
  }
  return [...migrations].sort((a, b) => a.filename.localeCompare(b.filename));
}

function safeDatabaseErrorMessage(error) {
  const message = error instanceof Error ? error.message : "unknown database error";
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url-redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function runMigrationSet(input) {
  const migrations = validateMigrations(input.migrations);
  const mode = input.mode ?? "apply";
  if (mode !== "apply" && mode !== "status") throw new Error(`Unknown migration mode: ${mode}`);
  const client = await input.connect();
  let primaryError = null;
  let lockAcquired = false;
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )`);
    const appliedRows = await client.query("select filename, checksum from schema_migrations order by filename");
    const applied = new Map(appliedRows.rows.map((row) => [String(row.filename), String(row.checksum).trim()]));
    const results = [];

    for (const migration of migrations) {
      const recorded = applied.get(migration.filename);
      if (recorded && recorded !== migration.checksum) {
        throw new Error(`Recorded migration checksum mismatch: ${migration.filename}`);
      }
      if (recorded) {
        results.push({ filename: migration.filename, state: "applied" });
        continue;
      }
      if (mode === "status") {
        results.push({ filename: migration.filename, state: "pending" });
        continue;
      }

      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (filename, checksum) values ($1, $2)",
          [migration.filename, migration.checksum]
        );
        await client.query("commit");
        results.push({ filename: migration.filename, state: "applied" });
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Migration failed and was rolled back: ${migration.filename}: ${safeDatabaseErrorMessage(error)}`
        );
      }
    }
    return results;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (lockAcquired) await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    } catch {
      if (!primaryError) throw new Error("Migration advisory lock could not be released");
    } finally {
      await client.release?.();
    }
  }
}
