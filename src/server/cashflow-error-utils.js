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

export async function sendApiError({
  req,
  res,
  error,
  fallback,
  logKind,
  logError,
  resolveLocale = () => "en",
  translateLocale = async (_locale, key) => key
}) {
  if (typeof logError === "function" && logKind) {
    logError(logKind, error);
  }

  const status = Number(error?.status) || 500;
  const message = cashflowErrorMessage(error) || fallback;
  const locale = await resolveLocale(req);
  const localized = await translateLocale(locale, message || fallback);
  res.status(status).json({
    error: localized,
    ...(error?.conflicts ? { conflicts: error.conflicts } : {}),
    ...(error?.details ? { details: error.details } : {})
  });
}
