export const DEVICE_TOKEN_POLICY_FIELDS = Object.freeze({
  device_access_minutes: { default: 15, min: 1, max: 1440 },
  device_renewal_idle_days: { default: 90, min: 1, max: 3650 },
  device_absolute_days: { default: 365, min: 1, max: 3650 }
});

/** Validate partial Admin updates against the complete effective issuance policy. */
export function normalizeDeviceTokenPolicy(updates, current, invalid = message => new Error(message)) {
  const result = {};
  const effective = {};
  for (const [key, rule] of Object.entries(DEVICE_TOKEN_POLICY_FIELDS)) {
    const provided = Object.prototype.hasOwnProperty.call(updates, key);
    const raw = provided ? updates[key] : current?.[key] ?? rule.default;
    if (provided && (typeof raw !== "number" && typeof raw !== "string" || String(raw).trim() === "")) {
      throw invalid(`${key} must be an integer from ${rule.min} to ${rule.max}`, key);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
      throw invalid(`${key} must be an integer from ${rule.min} to ${rule.max}`, key);
    }
    effective[key] = value;
    if (provided) result[key] = value;
  }
  if (effective.device_renewal_idle_days > effective.device_absolute_days) {
    throw invalid("Device renewal inactivity must not exceed the absolute device lifetime", "device_renewal_idle_days");
  }
  if (effective.device_access_minutes > effective.device_renewal_idle_days * 1440) {
    throw invalid("Device access lifetime must not exceed renewal inactivity", "device_access_minutes");
  }
  return result;
}