/** Apply before parsers, limiters and update-mode middleware, including errors. */
export function deviceResponsePolicy(req, res, next) {
  // Express routes are case-insensitive by default. Match that behavior even
  // for failures before routing (parsing, rate limits, and update-needed mode).
  const pathname = (req.originalUrl || req.url || "").split("?")[0].toLowerCase();
  if (["/api/device", "/api/account/devices", "/api/account/device-pairings", "/api/app/snapshot"]
    .some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
    || /^\/api\/budgets\/[^/]+\/archive$/.test(pathname)) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
  }
  next();
}