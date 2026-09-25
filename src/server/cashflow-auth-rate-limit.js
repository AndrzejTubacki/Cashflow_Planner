// Keep the fail-closed handler identical in server startup and replica tests.
export function createInternalAuthLimiter({ rateLimit, globalStore, logError = () => {} }) {
  const limiter = rateLimit({
    legacyHeaders: false, limit: 20, standardHeaders: 'draft-8',
    windowMs: 15 * 60 * 1000,
    ...(globalStore?.backend === 'postgres'
      ? { store: globalStore.createAuthRateLimitStore() } : {})
  });
  return (req, res, next) => {
    limiter(req, res, error => {
      if (!error) return next();
      logError('cashflow_auth_rate_limit_unavailable', { code: error.code || 'store_error' });
      res.status(503).json({ error: 'Authentication temporarily unavailable' });
    });
  };
}
