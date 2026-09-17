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
          OR cashflow_runtime_locks.owner_id = EXCLUDED.owner_id
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

    try {
      const result = await fn(acquireResult.lock);
      return {
        acquired: true,
        result
      };
    } finally {
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
