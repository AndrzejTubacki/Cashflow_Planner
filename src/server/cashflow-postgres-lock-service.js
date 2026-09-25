import crypto from "node:crypto";

function lockName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(name)) {
    throw new Error("Lock name must be 1-128 chars using letters, numbers, colon, underscore, or dash");
  }
  return name;
}

function ttl(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1000 || number > 3600000) {
    return fallback;
  }
  return Math.trunc(number);
}

function isoAfter(ms, now = new Date()) {
  return new Date(now.getTime() + ms).toISOString();
}

async function withClient(clientOrPool, fn) {
  if (!clientOrPool || typeof clientOrPool.query !== "function") {
    const client = await clientOrPool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  return await fn(clientOrPool);
}

export function createPostgresLockService({
  client,
  defaultTtlMs = 120000,
  logError = () => {},
  now = () => new Date(),
  ownerId = `cashflow_${crypto.randomUUID()}`
} = {}) {
  if (!client) {
    throw new Error("Postgres lock service requires a client or pool");
  }
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!normalizedOwnerId) {
    throw new Error("Postgres lock service requires ownerId");
  }

  async function tryAcquire(name, options = {}) {
    const normalizedName = lockName(name);
    const currentTime = now();
    const expiresAt = isoAfter(ttl(options.ttlMs, defaultTtlMs), currentTime);

    return withClient(client, async pgClient => {
      const result = await pgClient.query(`
        INSERT INTO cashflow_runtime_locks (
          name, owner_id, acquired_at, expires_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $3)
        ON CONFLICT (name) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          acquired_at = EXCLUDED.acquired_at,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
        WHERE cashflow_runtime_locks.expires_at <= $3
        RETURNING name, owner_id, expires_at
      `, [
        normalizedName,
        normalizedOwnerId,
        currentTime.toISOString(),
        expiresAt
      ]);

      const row = result?.rows?.[0] || null;
      return {
        acquired: Boolean(row),
        lock: row
      };
    });
  }

  async function renew(name, options = {}) {
    const normalizedName = lockName(name);
    const currentTime = now();
    const expiresAt = isoAfter(ttl(options.ttlMs, defaultTtlMs), currentTime);

    return withClient(client, async pgClient => {
      const result = await pgClient.query(`
        UPDATE cashflow_runtime_locks
        SET expires_at = $3,
            updated_at = $2
        WHERE name = $1
          AND owner_id = $4
          AND expires_at > $2
        RETURNING name, owner_id, expires_at
      `, [
        normalizedName,
        currentTime.toISOString(),
        expiresAt,
        normalizedOwnerId
      ]);

      return {
        renewed: Boolean(result?.rows?.[0]),
        lock: result?.rows?.[0] || null
      };
    });
  }

  async function release(name) {
    const normalizedName = lockName(name);
    return withClient(client, async pgClient => {
      const result = await pgClient.query(`
        DELETE FROM cashflow_runtime_locks
        WHERE name = $1
          AND owner_id = $2
      `, [
        normalizedName,
        normalizedOwnerId
      ]);
      return Number(result?.rowCount || 0);
    });
  }

  async function withLock(name, fn, options = {}) {
    const acquireResult = await tryAcquire(name, options);
    if (!acquireResult.acquired) {
      return {
        acquired: false,
        skipped: true
      };
    }

    // The lease is only as long as the acquire TTL, but the callback may
    // legitimately run longer than that. Renew it in the background at
    // roughly a third of the TTL so a transient renewal failure doesn't
    // immediately cost the lock, and abort the signal we hand to the
    // callback the moment a renewal is definitively rejected (owner_id no
    // longer matches, i.e. another replica has already taken over).
    const effectiveTtlMs = ttl(options.ttlMs, defaultTtlMs);
    const renewIntervalMs = Math.max(100, Math.floor(effectiveTtlMs / 3));
    const abortController = new AbortController();
    let lockLost = false;
    let stopped = false;
    let timer = null;

    function scheduleRenewal() {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          const renewResult = await renew(name, options);
          if (stopped) return;
          if (!renewResult.renewed) {
            logError("cashflow_runtime_lock_lost", { name, ownerId: normalizedOwnerId });
            lockLost = true;
            abortController.abort();
            return;
          }
        } catch (error) {
          logError("cashflow_runtime_lock_renewal_failed", { name, code: error.code || "renewal_error" });
          // Transient renewal failure (e.g. a brief DB blip): keep retrying
          // on the next tick rather than aborting immediately. If the
          // underlying row genuinely expired and was taken over, the next
          // successful renew() call will observe the ownership change and
          // set lockLost then.
        }
        scheduleRenewal();
      }, renewIntervalMs);
      timer.unref?.();
    }
    scheduleRenewal();

    try {
      const result = await fn(acquireResult.lock, { signal: abortController.signal });
      return {
        acquired: true,
        lockLost,
        result
      };
    } finally {
      stopped = true;
      clearTimeout(timer);
      await release(name);
    }
  }

  return {
    ownerId: normalizedOwnerId,
    release,
    renew,
    tryAcquire,
    withLock
  };
}
