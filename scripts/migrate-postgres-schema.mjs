import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import { runPostgresMigrations } from "../src/server/cashflow-postgres-migrations.js";
import { redactDatabaseError } from "../src/server/cashflow-database-update-mode.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = String(process.env.CASHFLOW_DATABASE_URL || "").trim();
if (!databaseUrl) {
  console.error("CASHFLOW_DATABASE_URL is required");
  process.exitCode = 1;
} else {
  try {
    const result = await runPostgresMigrations({
      databaseUrl,
      migrationsDir: path.join(root, "scripts", "migrations"),
      logServerEvent: (kind, details) => console.log(`${kind}: ${details.migration || details.schemaName || details.removed?.join(", ") || "completed"}`)
    });
    if (!result.current) {
      console.error(`Database schema is still not current. Pending: ${result.pending.join(", ") || "no matching migration file"}`);
      process.exitCode = 1;
    } else {
      if (result.backupSchema) console.log(`Pre-migration backup: ${result.backupSchema}`);
      console.log(result.applied.length ? `Applied: ${result.applied.join(", ")}` : "Database schema is already current.");
    }
  } catch (error) {
    console.error(`Database migration failed: ${redactDatabaseError(error)}`);
    process.exitCode = 1;
  }
}
