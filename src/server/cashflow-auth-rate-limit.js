// Express accepts mixed-case routes and a trailing slash by default. Polling
// must never also consume the smaller enrollment budget for those aliases.
export function isDevicePairingPoll(req) {
  const pathname = (req.originalUrl || req.url || "").split("?")[0];
  return /^\/api\/device\/pairings\/poll\/?$/i.test(pathname);
}

// Keep the fail-closed handler identical in server startup and replica tests.
export function createInternalAuthLimiter({ rateLimit, globalStore, logError = () => {}, limit = 20, windowMs = 15 * 60 * 1000, namespace = "internal-auth" }) {
  const limiter = rateLimit({
    legacyHeaders: false, limit, standardHeaders: 'draft-8',
    windowMs,
    ...(globalStore?.backend === 'postgres'
      ? { store: globalStore.createAuthRateLimitStore(namespace) } : {})
  });
  return (req, res, next) => {
    limiter(req, res, error => {
      if (!error) return next();
      logError('cashflow_auth_rate_limit_unavailable', { code: error.code || 'store_error' });
      res.status(503).json({ error: 'Authentication temporarily unavailable' });
    });
  };
}
