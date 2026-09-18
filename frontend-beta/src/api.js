export class CashflowApiError extends Error {
  constructor(message, { status = 500, details = null, payload = null } = {}) {
    super(message);
    this.name = "CashflowApiError";
    this.status = status;
    this.details = details;
    this.payload = payload;
  }
}

let csrfToken = "";

export function setCsrfToken(token) {
  csrfToken = String(token || "");
}

function budgetId() {
  return localStorage.getItem("cashflow_budget_id") || localStorage.getItem("cashflow_user_id") || "";
}

function buildRequest(url, options = {}) {
  const { scoped = true, body, headers: providedHeaders = {}, ...rest } = options;
  const headers = { ...providedHeaders };
  const id = budgetId();

  if (scoped && id) headers["x-cashflow-budget-id"] = id;

  const method = String(rest.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers["x-cashflow-csrf-token"] = csrfToken;
  }

  let requestBody = body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    requestBody = JSON.stringify(body);
  }

  return { url, init: { credentials: "same-origin", ...rest, headers, body: requestBody } };
}

let sessionRecoveryPromise = null;

// Routes gated by requireActor() (budgets/accounts/admin) need a real cookie-backed
// session, not just the x-cashflow-budget-id header the rest of the app runs on. If
// legacy never established one for this browser (e.g. jumping straight to /beta on an
// account that predates the account/session system), those routes 401 with
// "Authentication required" while everything else keeps working fine — confusing,
// since only some tabs look broken. Recover once by establishing a real session for
// the budget we already know about, then let the caller retry.
async function recoverSession() {
  const id = budgetId();
  if (!id) return false;

  if (!sessionRecoveryPromise) {
    sessionRecoveryPromise = fetch("/api/session/select", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budgetId: id })
    })
      .then(response => response.ok)
      .catch(() => false)
      .finally(() => {
        sessionRecoveryPromise = null;
      });
  }

  return sessionRecoveryPromise;
}

export async function apiFetch(url, options = {}) {
  const { url: finalUrl, init } = buildRequest(url, options);
  const response = await fetch(finalUrl, init);
  const payload = await response.clone().json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && !options._retriedAfterRecovery && url !== "/api/session/select") {
      const recovered = await recoverSession();
      if (recovered) return apiFetch(url, { ...options, _retriedAfterRecovery: true });
    }

    throw new CashflowApiError(payload.error || `Request failed with status ${response.status}`, {
      status: response.status,
      details: payload.details || null,
      payload
    });
  }

  return payload;
}

// For file downloads: returns the raw Response instead of parsing JSON, so callers can read a blob.
export async function apiFetchRaw(url, options = {}) {
  const { url: finalUrl, init } = buildRequest(url, options);
  const response = await fetch(finalUrl, init);

  if (!response.ok) {
    const payload = await response.clone().json().catch(() => ({}));
    throw new CashflowApiError(payload.error || `Request failed with status ${response.status}`, {
      status: response.status,
      details: payload.details || null,
      payload
    });
  }

  return response;
}

export async function downloadFile(url, fallbackName) {
  const response = await apiFetchRaw(url);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const disposition = response.headers.get("content-disposition") || "";
  const fileNameMatch = disposition.match(/filename="([^"]+)"/);

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileNameMatch?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function fetchSession() {
  return apiFetch("/api/session", { cache: "no-store", scoped: false });
}

export async function fetchSnapshot() {
  return apiFetch("/api", { cache: "no-store" });
}

export async function confirmPending(id, body = {}) {
  return apiFetch(`/api/pending/${encodeURIComponent(id)}/confirm`, { method: "POST", body });
}
