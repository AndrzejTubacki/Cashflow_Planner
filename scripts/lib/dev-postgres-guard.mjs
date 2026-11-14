/** Refuse instance-level connection options and any target other than the approved dev database. */
export function assertDevDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid dev database configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.pathname) !== "/cashflow_dev" || url.search) {
    throw new Error("Refusing PostgreSQL target: only cashflow_dev without URL query options is allowed");
  }
  return value;
}

export async function assertDevDatabaseIdentity(client) {
  const result = await client.query("SELECT current_database() AS database");
  if (result.rows[0]?.database !== "cashflow_dev") throw new Error("Connected database identity mismatch");
}