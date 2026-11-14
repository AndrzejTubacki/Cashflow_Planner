import { createHash } from "node:crypto";
import { normalizeAppOperation } from "./cashflow-app-operation-contract.js";

/** Experimental deletion envelope. Journal hosts must explicitly opt in. */
export function normalizeAppDeletion(input) {
  if (!input || input.kind !== "one-off.delete") throw new Error("Unsupported deletion kind");
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.getPrototypeOf(payload) !== Object.prototype
    || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "id")) {
    throw new Error("Deletion requires only the source identity");
  }
  // Reuse strict envelope and UUID validation without allowing financial fields
  // in the actual deletion payload. No adapter or mutable state is consulted.
  const normalized = normalizeAppOperation({ ...input, kind: "one-off.create", payload: {
    id: payload.id, name: "Deletion validation", currency: "PLN", amount: 1,
    type: "expense", date: "2000-01-01"
  } });
  return { ...normalized, kind: "one-off.delete", payload: { id: normalized.payload.id } };
}

export function appDeletionFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(normalizeAppDeletion(input))).digest("hex");
}