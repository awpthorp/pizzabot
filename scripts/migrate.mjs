import pg from "pg";
import { loadMigrationFiles, runMigrationSet } from "./migration-runner-core.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required for migration status or apply");
  process.exit(1);
}

const { Client } = pg;
const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
const client = new Client({
  connectionString: databaseUrl,
  ssl: local ? undefined : { rejectUnauthorized: false },
});

try {
  const migrations = await loadMigrationFiles();
  const results = await runMigrationSet({
    migrations,
    mode: process.argv.includes("--status") ? "status" : "apply",
    connect: async () => {
      await client.connect();
      return {
        query: (text, params) => client.query(text, params),
        release: () => client.end(),
      };
    },
  });
  for (const result of results) console.log(`${result.state} ${result.filename}`);
  const pending = results.filter((result) => result.state === "pending").length;
  console.log(`${results.length} migrations checked, ${pending} pending`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration command failed");
  process.exitCode = 1;
}
