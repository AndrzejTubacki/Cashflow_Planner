// Express trusts no proxy by default (req.ip is the direct socket peer),
// which is the only safe default: blindly trusting X-Forwarded-For lets any
// client spoof its own IP and defeat anything keyed on it (e.g. the login
// rate limiter). Behind a real reverse proxy, an operator opts in with the
// exact form Express's own "trust proxy" setting expects - a hop count, a
// comma-separated list of proxy IPs/CIDRs, or named ranges like "loopback" -
// never a bare boolean, so there is no accidental "trust everything" value.

// This only parses the two *shapes* Express accepts (a bare hop count, or a
// comma-separated list of entries) - it deliberately does not try to
// validate individual entries (IPs, CIDRs, named ranges) itself. An earlier
// version used a hand-rolled regex for that and got it wrong in both
// directions (e.g. "abc" and "999.1.1.1" matched it, "::1" did not), so
// entries are instead validated by actually handing them to Express in
// configureTrustProxy, which uses its own "proxy-addr" dependency - the
// exact logic that will run in production either way.
export function resolveTrustProxySetting(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return { value: undefined, source: "default" };
  if (/^\d+$/.test(raw)) return { value: Number(raw), source: "hop-count" };
  const entries = raw.split(",").map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) return { value: undefined, source: "invalid" };
  return { value: entries.length === 1 ? entries[0] : entries, source: "list" };
}

export function configureTrustProxy(app, rawValue, { logError = () => {}, logServerEvent = () => {} } = {}) {
  const resolved = resolveTrustProxySetting(rawValue);
  const trimmedRawValue = String(rawValue || "").trim();
  if (resolved.source === "invalid") {
    logError("cashflow_trust_proxy_invalid", { value: trimmedRawValue });
    return resolved;
  }
  if (resolved.value === undefined) {
    return resolved;
  }
  try {
    // Express only actually validates entries (parsing IPs/CIDRs, rejecting
    // an out-of-range prefix, etc.) when it compiles this setting, and
    // throws synchronously if any entry is malformed. Catching that here,
    // rather than letting it propagate, is what keeps a typo from crashing
    // startup - the setting is left at its default (no proxy trusted; the
    // failed app.set call never replaces Express's own "trust nothing"
    // compiled function, confirmed directly against a live Express app).
    app.set("trust proxy", resolved.value);
  } catch (error) {
    logError("cashflow_trust_proxy_invalid", { value: trimmedRawValue, reason: error.message });
    return { value: undefined, source: "invalid" };
  }
  logServerEvent("cashflow_trust_proxy_configured", { value: resolved.value });
  return resolved;
}
