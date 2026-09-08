import { formatMessage, t } from "./shared.js";

export function cashflowApiForEntity(entityType, id = null) {
  const routes = {
    "recurring-expense": "/api/recurring-expenses",
    "recurring-income": "/api/recurring-incomes",
    "one-off": "/api/one-off",
    "goal": "/api/goals",
    "flex": "/api/flex",
    "pending": "/api/pending"
  };

  const base = routes[entityType];

  if (!base) {
    throw new Error(formatMessage(null, "Unknown cashflow entity type: {entityType}", { entityType }));
  }

  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export async function postCashflowJson(apiClient, url, body = {}) {
  return apiClient.json(url, {
    method: "POST",
    body
  });
}

export async function runCashflowAction(apiClient, button, url, eventName, body = {}) {
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = t(null, "Working...");

  try {
    const result = await postCashflowJson(apiClient, url, body);

    window.dispatchEvent(new CustomEvent(eventName, {
      detail: result
    }));

    window.dispatchEvent(new CustomEvent("cashflow-refresh", {
      detail: result
    }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: error.message
      }
    }));

  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

export async function validateCashflowAction(apiClient, button) {
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = t(null, "Validating...");

  try {
    const result = await postCashflowJson(apiClient, "/api/validate");

    window.dispatchEvent(new CustomEvent("cashflow-validated", {
      detail: result
    }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: error.message
      }
    }));

  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

export async function deleteCashflowEntity(apiClient, button, entityType, id, confirmMessage = "") {
  if (!window.confirm(t(null, confirmMessage || "Delete this transaction?"))) return;

  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = t(null, "Working...");

  try {
    const payload = await apiClient.json(cashflowApiForEntity(entityType, id), {
      method: "DELETE"
    });

    window.dispatchEvent(new CustomEvent("cashflow-deleted", {
      detail: payload
    }));

    window.dispatchEvent(new CustomEvent("cashflow-refresh", {
      detail: payload
    }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: error.message
      }
    }));

  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}
