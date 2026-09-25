import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createPostgresGlobalDbService } from "../../src/server/cashflow-postgres-global-db-service.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import {
  postgresRuntimeTestsEnabled,
  withDisposablePostgresDb
} from "../helpers/postgres-test-db.js";

const SKIP_REASON = "set CASHFLOW_ENABLE_POSTGRES_TESTS=1 and CASHFLOW_DATABASE_URL to run disposable Postgres tests";
// Keep the original TTL while diagnosing latency; callback barriers below
// remove startup/release races without increasing the renewal margin.
const TEST_TTL_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Record only lock-query timing and ownership, never connection configuration.
function tracedPgModule(replica, trace) {
  const wrapped = new WeakSet();
  return { Pool: class extends pg.Pool {
    async connect() {
      const client = await super.connect();
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const query = client.query.bind(client);
        client.query = async (sql, ...args) => {
          if (!String(sql).includes("cashflow_runtime_locks")) return query(sql, ...args);
          const event = { replica, operation: String(sql).trim().split(/\s/)[0], startedMs: performance.now() };
          trace.push(event);
          try {
            const result = await query(sql, ...args);
            event.rowCount = result.rowCount;
            event.lock = result.rows[0] || null;
            return result;
          } catch (error) {
            event.errorCode = error.code;
            throw error;
          } finally {
            event.finishedMs = performance.now();
          }
        };
      }
      return client;
    }
  } };
}

test(
  "a lock lease is renewed while its callback keeps running, so a second replica cannot acquire it before the callback finishes",
  { skip: postgresRuntimeTestsEnabled() ? false : SKIP_REASON },
  async t => {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const trace = [];
      const globalDb = await createPostgresGlobalDbService({ databaseUrl });
      const storeA = await createPostgresGlobalStore({ databaseUrl, pgModule: tracedPgModule("A", trace) });
      const storeB = await createPostgresGlobalStore({ databaseUrl, pgModule: tracedPgModule("B", trace) });
      try {
        await globalDb.initializeGlobalSchema();
        const replicaA = storeA.createLockService({ ownerId: "replica_a" });
        const replicaB = storeB.createLockService({ ownerId: "replica_b" });
        const lockName = "test:long-running-job";

        // A's callback is the acquisition barrier. Await all B queries inside
        // it, so no contender can spill across A's legitimate final release.
        // Separate stores model independent replica connections, not one pool.
        const withLockResult = await replicaA.withLock(lockName, async () => {
          const startedMs = performance.now();
          trace.push({ event: "callback_started", atMs: startedMs });
          try {
            do {
              const attempt = await replicaB.tryAcquire(lockName, { ttlMs: TEST_TTL_MS });
              assert.equal(attempt.acquired, false, "B acquired during A's callback");
              await sleep(150);
            } while (performance.now() - startedMs < TEST_TTL_MS * 3);
            return "work-completed";
          } finally {
            trace.push({ event: "callback_finished", atMs: performance.now() });
          }
        }, { ttlMs: TEST_TTL_MS });

        assert.equal(withLockResult.acquired, true);
        assert.equal(withLockResult.result, "work-completed");
        assert.equal(withLockResult.lockLost, false);
        const postWorkAcquire = await replicaB.tryAcquire(lockName, { ttlMs: TEST_TTL_MS });
        assert.equal(postWorkAcquire.acquired, true, "the lock must be released once the callback finishes");
        await replicaB.release(lockName);
      } catch (error) {
        // A failed run now distinguishes a real mid-callback takeover from
        // slow acquire/renew round trips; preserve the exact timeline.
        t.diagnostic(JSON.stringify(trace));
        throw error;
      } finally {
        await storeB.close();
        await storeA.close();
        await globalDb.close();
      }
    });
  }
);

test(
  "when another replica has genuinely taken over the lock row, renewal is rejected and the callback's abort signal fires",
  { skip: postgresRuntimeTestsEnabled() ? false : SKIP_REASON },
  async () => {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const globalDb = await createPostgresGlobalDbService({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        await globalDb.initializeGlobalSchema();

        const replicaA = globalStore.createLockService({ ownerId: "replica_a" });
        const lockName = "test:intruder-takeover";

        const withLockResult = await replicaA.withLock(lockName, async (_lock, { signal }) => {
          // Simulate a second replica having legitimately taken over the row
          // (e.g. after replica A stalled past its TTL on a previous, unrenewed
          // lease) by writing a fresh, non-expired row under a different owner.
          await globalDb.withClient(client => client.query(
            `
              UPDATE cashflow_runtime_locks
              SET owner_id = 'intruder', expires_at = now() + interval '1 hour'
              WHERE name = $1
            `,
            [lockName]
          ));

          const deadline = Date.now() + 5000;
          while (!signal.aborted && Date.now() < deadline) {
            await sleep(50);
          }
          return { aborted: signal.aborted };
        }, { ttlMs: TEST_TTL_MS });

        assert.equal(withLockResult.acquired, true);
        assert.equal(withLockResult.lockLost, true, "withLock must report the lease was lost mid-callback");
        assert.equal(withLockResult.result.aborted, true, "the callback's abort signal must fire once renewal is rejected");

        const row = await globalDb.withClient(async client => {
          const result = await client.query(
            "SELECT owner_id FROM cashflow_runtime_locks WHERE name = $1",
            [lockName]
          );
          return result.rows[0];
        });
        assert.equal(row.owner_id, "intruder", "release() must never delete a row now owned by someone else");
      } finally {
        await globalStore.close();
        await globalDb.close();
      }
    });
  }
);

// Reproduce the historical test's false-positive boundary against a real DB:
// release can commit before its response arrives and before withLock resolves.
test('acquisition after callback completion but before withLock returns is legitimate, not lease theft',
  { skip: postgresRuntimeTestsEnabled() ? false : SKIP_REASON }, async () => {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      let releaseDeleted;
      let resumeRelease;
      const deleted = new Promise(resolve => { releaseDeleted = resolve; });
      const resumed = new Promise(resolve => { resumeRelease = resolve; });
      const wrapped = new WeakSet();
      class DelayedReleasePool extends pg.Pool {
        async connect() {
          const client = await super.connect();
          if (!wrapped.has(client)) {
            wrapped.add(client);
            const query = client.query.bind(client);
            client.query = async (sql, ...args) => {
              const result = await query(sql, ...args);
              if (String(sql).includes('DELETE FROM cashflow_runtime_locks')) {
                releaseDeleted();
                await resumed;
              }
              return result;
            };
          }
          return client;
        }
      }
      const a = await createPostgresGlobalStore({ databaseUrl, pgModule: { Pool: DelayedReleasePool } });
      const b = await createPostgresGlobalStore({ databaseUrl });
      try {
        await a.initialize();
        let callbackFinished = false;
        let withLockSettled = false;
        const work = a.createLockService({ ownerId: 'boundary-a' }).withLock('test:release-boundary', async () => {
          callbackFinished = true;
        }, { ttlMs: TEST_TTL_MS }).finally(() => { withLockSettled = true; });
        await deleted;
        const contender = b.createLockService({ ownerId: 'boundary-b' });
        assert.equal((await contender.tryAcquire('test:release-boundary')).acquired, true);
        assert.equal(callbackFinished, true);
        assert.equal(withLockSettled, false, 'the original done flag would still be false here');
        resumeRelease();
        await work;
        await contender.release('test:release-boundary');
      } finally {
        resumeRelease();
        await a.close(); await b.close();
      }
    });
  });
