import crypto from 'node:crypto';

export function generateId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
