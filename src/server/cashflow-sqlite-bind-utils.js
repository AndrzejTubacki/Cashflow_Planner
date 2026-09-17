// Postgres's driver returns richer native JS types for a row (Date objects
// for TIMESTAMPTZ, real booleans for BOOLEAN, parsed objects/arrays for
// JSONB) than better-sqlite3 can bind directly (only numbers, strings,
// bigints, buffers, and null). SQLite-sourced rows never need this — they
// already only ever contain primitives — so this only matters when a row
// originating from a Postgres store gets written into a SQLite store (e.g.
// migrating/restoring a Postgres snapshot back into SQLite).
export function normalizeSqliteBindValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
