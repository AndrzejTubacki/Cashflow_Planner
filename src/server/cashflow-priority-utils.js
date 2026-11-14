import { notFound } from "./cashflow-user-utils.js";

import { normalizePriority } from "../engine/cashflow-priority.js";
export { normalizePriority };

export function priorityColumnForDomain(domain) {
  return domain === "goal" ? "goal_priority" : "operating_priority";
}

export function priorityTypesForDomain(domain) {
  return domain === "goal"
    ? ["goal"]
    : ["recurring_expense", "flex"];
}

export function reorderPriorityDomain(db, domain, plannedTransactionId, requestedPriority) {
  const priority = normalizePriority(requestedPriority);
  const column = priorityColumnForDomain(domain);
  const types = priorityTypesForDomain(domain);
  const placeholders = types.map(() => "?").join(", ");

  const rows = db.prepare(`
    SELECT id
    FROM planned_transactions
    WHERE type IN (${placeholders})
    ORDER BY
      CASE WHEN ${column} IS NULL THEN 999999 ELSE ${column} END ASC,
      created_at ASC,
      id ASC
  `).all(...types);

  const orderedIds = rows
    .map(row => row.id)
    .filter(id => id !== plannedTransactionId);

  const targetIndex = Math.max(0, Math.min(priority - 1, orderedIds.length));
  orderedIds.splice(targetIndex, 0, plannedTransactionId);

  const update = db.prepare(`
    UPDATE planned_transactions
    SET ${column} = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  orderedIds.forEach((id, index) => {
    update.run(index + 1, id);
  });
}

export function updatePlannedPriority(db, plannedTransactionId, domain, requestedPriority) {
  const existing = db.prepare(`
    SELECT id
    FROM planned_transactions
    WHERE id = ?
  `).get(plannedTransactionId);

  if (!existing) throw notFound("Planned transaction not found");

  reorderPriorityDomain(db, domain, plannedTransactionId, requestedPriority);
}
