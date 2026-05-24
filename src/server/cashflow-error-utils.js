export function cashflowErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function cashflowErrorStack(error) {
  return error instanceof Error ? error.stack : null;
}

export function createCashflowErrorLogger(logError) {
  return function logCashflowError(kind, error, context = null) {
    const normalized =
      error instanceof Error
        ? error
        : new Error(cashflowErrorMessage(error));

    if (context) {
      normalized.context = context;
    }

    logError(kind, normalized);
  };
}
