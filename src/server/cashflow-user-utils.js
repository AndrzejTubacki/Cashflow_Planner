export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
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
  return createHttpError(`User not found: ${userId}`, 404);
}
