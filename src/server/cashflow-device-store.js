/** Transactions share global storage but not browser session credentials. */
export function createDeviceStore(globalStore) {
  let queue = Promise.resolve();
  /** Transfer reservations/publication request durable control-plane commits.
   * SQLite's connection is owned by withRepository and closed afterward; other
   * callers retain their configured durability policy. */
  function transaction(work, { durableWrites = false } = {}) {
    if (typeof durableWrites !== 'boolean') throw new Error('Invalid device transaction durability');
    const result = queue.then(() => globalStore.withRepository(async (repo, connection) => {
      const postgres = repo.backend === "postgres";
      const query = async (sql, values = []) => {
        if (postgres) {
          let index = 0;
          const result = await connection.query(sql.replace(/\?/g, () => `$${++index}`), values);
          return result.rows || [];
        }
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...values) : (statement.run(...values), []);
      };
      if (postgres) await connection.query("BEGIN");
      else {
        if (durableWrites) connection.pragma('synchronous = FULL');
        connection.exec("BEGIN IMMEDIATE");
      }
      try {
        if (postgres && durableWrites) await connection.query('SET LOCAL synchronous_commit = on');
        // One low-volume device transaction at a time across replicas; bounded
        // local queries only. No network or password hashing inside this lock.
        if (postgres) await connection.query("SELECT pg_advisory_xact_lock(73190231)");
        const result = await work({ query, repo, connection, backend: postgres ? "postgres" : "sqlite" });
        if (postgres) await connection.query("COMMIT");
        else connection.exec("COMMIT");
        return result;
      } catch (error) {
        if (postgres) await connection.query("ROLLBACK");
        else connection.exec("ROLLBACK");
        throw error;
      }
    }));
    queue = result.catch(() => {});
    return result;
  }
  return { transaction };
}
