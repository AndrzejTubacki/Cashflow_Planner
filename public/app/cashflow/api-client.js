export class CashflowApiError extends Error {
  constructor(message, { status = 500, details = null, conflicts = null, payload = null } = {}) {
    super(message);
    this.name = "CashflowApiError";
    this.status = status;
    this.details = details;
    this.conflicts = conflicts;
    this.payload = payload;
  }
}

export function createCashflowApiClient({
  getUserId = () => "",
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  async function raw(url, options = {}) {
    const {
      scoped = true,
      body,
      headers: providedHeaders = {},
      ...fetchOptions
    } = options;
    const headers = { ...providedHeaders };
    const userId = String(getUserId() || "").trim();
    let requestBody = body;

    if (scoped && userId) {
      headers["x-cashflow-user-id"] = userId;
    }

    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    const isArrayBuffer = typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer;

    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !isFormData &&
      !isBlob &&
      !isArrayBuffer
    ) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      requestBody = JSON.stringify(body);
    }

    const response = await fetchImpl(url, {
      ...fetchOptions,
      headers,
      body: requestBody
    });

    if (!response.ok) {
      const payload = await response.clone().json().catch(() => ({}));
      throw new CashflowApiError(
        payload.error || `Request failed with status ${response.status}`,
        {
          status: response.status,
          details: payload.details || null,
          conflicts: payload.conflicts || null,
          payload
        }
      );
    }

    return response;
  }

  async function json(url, options = {}) {
    const response = await raw(url, options);
    return response.json().catch(() => ({}));
  }

  return {
    json,
    raw
  };
}
