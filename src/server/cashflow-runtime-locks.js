const SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const GLOBAL_BACKGROUND_TICK_LOCK = "background:tick";

export const BUDGET_RUNTIME_LOCK_JOBS = Object.freeze({
  automaticBackup: "automatic-backup",
  fxRefresh: "fx-refresh",
  ledgerCheck: "ledger-check",
  notifications: "notifications",
  projection: "projection",
  retention: "retention"
});

function lockSegment(value, field = "lock segment") {
  const segment = String(value || "").trim();
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(`${field} must be 1-64 chars using letters, numbers, underscore, or dash`);
  }
  return segment;
}

export function runtimeLockName(...segments) {
  const name = segments.map((segment, index) => lockSegment(segment, `lock segment ${index + 1}`)).join(":");
  if (name.length > 128) {
    throw new Error("Runtime lock name must be 128 chars or fewer");
  }
  return name;
}

export function budgetRuntimeLockName(budgetId, jobName) {
  return runtimeLockName(
    "budget",
    lockSegment(budgetId, "budgetId"),
    lockSegment(jobName, "jobName")
  );
}
