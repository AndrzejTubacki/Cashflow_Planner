import { isIP } from "node:net";

const MAX_ALLOWED_PRIVATE_HOSTS = 50;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeNtfyHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function isValidNtfyHost(value) {
  const host = normalizeNtfyHost(value);
  if (!host || host.length > 253) return false;
  if (isIP(host)) return true;
  return host.split(".").every(label => label.length <= 63 && HOST_LABEL.test(label));
}

export function normalizeNtfyAllowedPrivateHosts(value, {
  invalid = message => new Error(message)
} = {}) {
  let entries;
  if (Array.isArray(value)) {
    entries = value;
  } else if (typeof value === "string") {
    entries = value.split(/[\n,]/);
  } else if (value === undefined || value === null) {
    entries = [];
  } else {
    throw invalid("ntfy_allowed_private_hosts must be a list of hostnames or IP addresses");
  }

  const normalized = [];
  const seen = new Set();
  for (const rawEntry of entries) {
    if (typeof rawEntry !== "string") {
      throw invalid(`Invalid private ntfy host: ${String(rawEntry)}`);
    }
    const host = normalizeNtfyHost(rawEntry);
    if (!host) continue;
    if (!isValidNtfyHost(host)) {
      throw invalid(`Invalid private ntfy host: ${rawEntry.trim()}`);
    }
    if (!seen.has(host)) {
      seen.add(host);
      normalized.push(host);
    }
  }
  if (normalized.length > MAX_ALLOWED_PRIVATE_HOSTS) {
    throw invalid(`ntfy_allowed_private_hosts must contain at most ${MAX_ALLOWED_PRIVATE_HOSTS} entries`);
  }
  return normalized;
}

export function ntfyHostIsAllowed(host, allowedHosts = []) {
  const normalizedHost = normalizeNtfyHost(host);
  return normalizeNtfyAllowedPrivateHosts(allowedHosts).includes(normalizedHost);
}
