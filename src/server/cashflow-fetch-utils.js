import { gatewayTimeout } from "./cashflow-user-utils.js";

export const DEFAULT_FX_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_NOTIFICATION_FETCH_TIMEOUT_MS = 5_000;

export function normalizeTimeoutMs(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function fxFetchTimeoutMs() {
  return normalizeTimeoutMs(process.env.CASHFLOW_FX_FETCH_TIMEOUT_MS, DEFAULT_FX_FETCH_TIMEOUT_MS);
}

export function notificationFetchTimeoutMs() {
  return normalizeTimeoutMs(
    process.env.CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS,
    DEFAULT_NOTIFICATION_FETCH_TIMEOUT_MS
  );
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FX_FETCH_TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeTimeoutMs(timeoutMs, DEFAULT_FX_FETCH_TIMEOUT_MS));

  try {
    return await fetchImpl(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw gatewayTimeout("External request timed out");
    }
    throw gatewayTimeout(error?.message
      ? `External request failed: ${error.message}`
      : "External request failed");
  } finally {
    clearTimeout(timeout);
  }
}
