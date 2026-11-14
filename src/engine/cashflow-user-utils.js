export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createHttpError(message, status = 500, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details !== null && details !== undefined) {
    error.details = details;
  }
  return error;
}

export function badRequest(message, details = null) {
  return createHttpError(message, 400, details);
}

export function unauthorized(message = "Authentication required", details = null) {
  return createHttpError(message, 401, details);
}

export function forbidden(message = "Admin permission required", details = null) {
  return createHttpError(message, 403, details);
}

export function notFound(message, details = null) {
  return createHttpError(message, 404, details);
}

export function conflict(message, details = null) {
  return createHttpError(message, 409, details);
}

export function gatewayTimeout(message, details = null) {
  return createHttpError(message, 504, details);
}

export function normalizeUserId(value, { allowEmpty = false } = {}) {
  const userId = String(value || "").trim();

  if (!userId && allowEmpty) return "";

  if (!USER_ID_PATTERN.test(userId) || userId.startsWith("_")) {
    throw createHttpError("User ID must use 1-64 letters, numbers, underscores, or hyphens.", 400);
  }

  return userId;
}

export function userNotFoundError(userId) {
  return notFound(`User not found: ${userId}`);
}
