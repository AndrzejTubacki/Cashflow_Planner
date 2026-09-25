import crypto from 'node:crypto';

// Atomic DB-time windows make the same IP budget apply across all replicas.
// Only hashed keys are persisted; a store error propagates to fail-closed HTTP.
export function createPostgresAuthRateLimitStore({ withClient }) {
  let windowMs = 15 * 60 * 1000;
  let nextCleanup = 0;
  const digest = key => crypto.createHash('sha256').update(String(key)).digest('hex');
  return {
    localKeys: false,
    prefix: 'cashflow-internal-auth',
    init(options) { windowMs = options.windowMs; },
    async increment(key) {
      return withClient(async client => {
        if (Date.now() >= nextCleanup) {
          await client.query(`DELETE FROM cashflow_auth_rate_limits WHERE key IN (
            SELECT key FROM cashflow_auth_rate_limits WHERE reset_at <= now() LIMIT 1000
          )`);
          nextCleanup = Date.now() + 60_000;
        }
        const result = await client.query(`
          INSERT INTO cashflow_auth_rate_limits (key, total_hits, reset_at)
          VALUES ($1, 1, now() + $2 * interval '1 millisecond')
          ON CONFLICT (key) DO UPDATE SET
            total_hits = CASE WHEN cashflow_auth_rate_limits.reset_at <= now()
              THEN 1 ELSE cashflow_auth_rate_limits.total_hits + 1 END,
            reset_at = CASE WHEN cashflow_auth_rate_limits.reset_at <= now()
              THEN EXCLUDED.reset_at ELSE cashflow_auth_rate_limits.reset_at END
          RETURNING total_hits, reset_at
        `, [digest(key), windowMs]);
        return { totalHits: Number(result.rows[0].total_hits), resetTime: new Date(result.rows[0].reset_at) };
      });
    },
    async decrement(key) {
      await withClient(client => client.query(
        'UPDATE cashflow_auth_rate_limits SET total_hits = GREATEST(0, total_hits - 1) WHERE key = $1', [digest(key)]
      ));
    },
    async resetKey(key) {
      await withClient(client => client.query('DELETE FROM cashflow_auth_rate_limits WHERE key = $1', [digest(key)]));
    }
  };
}
