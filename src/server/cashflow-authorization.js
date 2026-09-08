import { forbidden } from "./cashflow-user-utils.js";

export const CAPABILITIES = Object.freeze({
  SYSTEM_ADMIN: "system:admin",
  BUDGET_READ: "budget:read",
  PLANNER_WRITE: "planner:write",
  LEDGER_CONFIRM: "ledger:confirm",
  BUDGET_RENAME: "budget:rename",
  BUDGET_MEMBERS: "budget:members",
  BUDGET_VALIDATE: "budget:validate",
  BUDGET_EXPORT: "budget:export",
  BUDGET_SETTINGS: "budget:settings",
  BUDGET_MAINTAIN: "budget:maintain",
  BUDGET_IMPORT: "budget:import",
  BUDGET_RESTORE: "budget:restore",
  BUDGET_BACKUP: "budget:backup",
  BUDGET_ARCHIVE: "budget:archive",
  BUDGET_PURGE: "budget:purge",
  BUDGET_TRANSFER: "budget:transfer"
});

const ROLE_CAPABILITIES = Object.freeze({
  viewer: [
    CAPABILITIES.BUDGET_READ
  ],
  editor: [
    CAPABILITIES.BUDGET_READ,
    CAPABILITIES.PLANNER_WRITE,
    CAPABILITIES.LEDGER_CONFIRM
  ],
  manager: [
    CAPABILITIES.BUDGET_READ,
    CAPABILITIES.PLANNER_WRITE,
    CAPABILITIES.LEDGER_CONFIRM,
    CAPABILITIES.BUDGET_RENAME,
    CAPABILITIES.BUDGET_MEMBERS,
    CAPABILITIES.BUDGET_VALIDATE,
    CAPABILITIES.BUDGET_EXPORT
  ],
  owner: [
    ...Object.values(CAPABILITIES).filter(capability => capability !== CAPABILITIES.SYSTEM_ADMIN)
  ]
});

export function capabilitiesFor({
  budgetRole = "",
  globalRoles = []
} = {}) {
  const capabilities = new Set(ROLE_CAPABILITIES[budgetRole] || []);
  if (globalRoles.includes("system_admin")) {
    capabilities.add(CAPABILITIES.SYSTEM_ADMIN);
  }
  return [...capabilities].sort();
}

export function requireCapability(context, capability, message = "Permission required") {
  if (!Array.isArray(context?.capabilities) || !context.capabilities.includes(capability)) {
    throw forbidden(message);
  }
  return context;
}
