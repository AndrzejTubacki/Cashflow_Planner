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

export async function postCashflowJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || formatMessage(null, "Request failed with status {status}", { status: response.status }));
  }

  return payload;
}

export async function runCashflowAction(button, url, eventName, body = {}) {
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = t(null, "Working...");

  try {
    const result = await postCashflowJson(url, body);

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

    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

export async function validateCashflowAction(button) {
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = t(null, "Validating...");

  try {
    const result = await postCashflowJson("/api/validate");

    window.dispatchEvent(new CustomEvent("cashflow-validated", {
      detail: result
    }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: error.message
      }
    }));

    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

export async function deleteCashflowEntity(button, entityType, id) {
  if (!window.confirm(t(null, "Delete this transaction?"))) return;

  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = t(null, "Working...");

  try {
    const response = await fetch(cashflowApiForEntity(entityType, id), {
      method: "DELETE"
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || formatMessage(null, "Request failed with status {status}", { status: response.status }));
    }

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

    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}
