import { addMoneyAmounts } from './cashflow-money-utils.js';
import { badRequest } from './cashflow-user-utils.js';

/** Count validated original installment identities, including voided payments
 * and legacy history gaps. The highest retained ordinal is a reservation floor,
 * not a claim that missing payments or their amounts can be reconstructed. */
export function originalOneOffCountsFromEvidence(originals) {
  const counts = new Map();
  const largest = new Map();
  for (const item of originals) {
    const id = item.row.source_one_off_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
    const prefix = `one_off_remainder:${id}:`;
    if (typeof item.row.occurrence_key === 'string' && item.row.occurrence_key.startsWith(prefix)) {
      const suffix = item.row.occurrence_key.slice(prefix.length);
      const ordinal = Number(suffix);
      if (/^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(ordinal) && ordinal >= 2) {
        largest.set(id, Math.max(largest.get(id) || 0, ordinal));
      }
    }
  }
  for (const [id, ordinal] of largest) counts.set(id, Math.max(counts.get(id), ordinal));
  return counts;
}

/** Paid money comes from effective rows; original ordinals remain reserved.
 * A linked provisional view may also include new, unaccepted payment IDs. Each
 * advances its source beyond the retained floor without altering server audit. */
export function oneOffProgressWithOriginals(rows, originals = []) {
  const progress = new Map();
  const reserved = originalOneOffCountsFromEvidence(originals);
  const retainedIds = new Set(originals.map(original => original.row.id));
  const newCounts = new Map();
  for (const row of rows) {
    const sourceId = row.source_one_off_id;
    if (!sourceId) continue;
    const currency = String(row.currency || '').toUpperCase();
    const key = `${sourceId}:${row.type}:${currency}`;
    const current = progress.get(key) || { sourceId, type: row.type, currency, confirmedAmount: 0, confirmedCount: 0 };
    current.confirmedAmount = addMoneyAmounts(current.confirmedAmount, row.amount);
    current.confirmedCount++;
    progress.set(key, current);
    if (!retainedIds.has(row.id)) newCounts.set(sourceId, (newCounts.get(sourceId) || 0) + 1);
  }
  for (const original of originals) {
    const row = original.row;
    const sourceId = row.source_one_off_id;
    if (!sourceId) continue;
    const currency = row.currency.toUpperCase();
    const key = `${sourceId}:${row.type}:${currency}`;
    const current = progress.get(key) || { sourceId, type: row.type, currency, confirmedAmount: 0, confirmedCount: 0 };
    current.confirmedCount = Math.max(current.confirmedCount, reserved.get(sourceId) + (newCounts.get(sourceId) || 0));
    if (!Number.isSafeInteger(current.confirmedCount + 1)) throw badRequest('Installment identity exceeds safe sequence precision');
    progress.set(key, current);
  }
  return progress;
}

