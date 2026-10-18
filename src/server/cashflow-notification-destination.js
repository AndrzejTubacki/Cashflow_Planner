import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { normalizeNtfyHost, ntfyHostIsAllowed } from "./cashflow-ntfy-private-hosts.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16]
]) blocked.addSubnet(address, prefix, "ipv6");

// BlockList also matches IPv4 rules against IPv4-mapped IPv6 addresses.
// Invalid DNS results fail closed rather than becoming unchecked destinations.
export function isPrivateIp(value) {
  const address = normalizeNtfyHost(value);
  const family = isIP(address);
  return !family || blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Validate every answer, not only the first. The exact host exception applies
// only to ntfy; callers never pass it for Discord. No URL/credentials in errors.
export async function resolveNotificationDestination(url, {
  lookupHost = lookup,
  allowedPrivateHosts = []
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error("Notification destination must be an HTTP(S) URL");
  }
  const host = normalizeNtfyHost(parsed.hostname);
  const allowed = ntfyHostIsAllowed(host, allowedPrivateHosts);
  if (!allowed && (host === "localhost" || (isIP(host) && isPrivateIp(host)))) {
    throw new Error("Notification destination is not a public IP address");
  }
  let addresses;
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookupHost(host, { all: true });
  } catch {
    throw new Error("Notification destination hostname could not be resolved");
  }
  if (!Array.isArray(addresses) || !addresses.length
    || addresses.some(row => !isIP(row?.address)
      || (!allowed && isPrivateIp(row.address)))) {
    throw new Error("Notification destination resolves to a non-public or invalid IP address");
  }
  return addresses.map(row => ({ address: row.address, family: isIP(row.address) }));
}

// A fresh non-pooled request uses ONLY the validated answers. Keep the original
// URL hostname for Host/SNI/certificate verification. Core HTTP never follows
// redirects, and agent:false prevents reuse of a connection validated earlier.
export function pinnedNotificationRequest(url, options) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      lookup: options.lookup,
      agent: false
    }, response => {
      const status = response.statusCode;
      // Delivery only needs the status; don't buffer an unbounded response body.
      response.destroy();
      resolve({ ok: status >= 200 && status < 300, status, statusText: "" });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

// DNS validation is inside the caller's timeout, including a resolver that
// stalls. The injected transport is a test seam, never native fetch: fetch does
// not honor Node's lookup option and would silently reintroduce DNS rebinding.
export async function sendToNotificationDestination(url, options, {
  lookupHost = lookup,
  allowedPrivateHosts = [],
  requestImpl = pinnedNotificationRequest
} = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("Notification request aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const addresses = await Promise.race([
      resolveNotificationDestination(url, { lookupHost, allowedPrivateHosts }), aborted
    ]);
    const lookupPinned = (_host, opts, callback) => {
      const matches = addresses.filter(row => !opts.family || row.family === opts.family);
      if (!matches.length) return callback(new Error("No validated address for requested family"));
      if (opts.all) callback(null, matches);
      else callback(null, matches[0].address, matches[0].family);
    };
    const response = await Promise.race([
      requestImpl(url, { ...options, redirect: "error", lookup: lookupPinned }), aborted
    ]);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Notification redirects are not allowed");
    }
    return response;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}