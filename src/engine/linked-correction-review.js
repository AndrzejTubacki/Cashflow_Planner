import { ENGINE_AUDIT_HOST_OPTIONS } from './engine-host-capabilities.js';
import { normalizeLedgerCorrectionPayload } from './ledger-correction-intent.js';
import { verifyLinkedLedgerAudit } from './linked-ledger-audit.js';
import { normalizeLedgerAuditFact } from './ledger-audit-fact.js';
import { planLedgerCorrection, validateLedgerCorrectionFact } from './cashflow-ledger-correction-plan.js';

/** Read-only review against complete accepted server facts. It predicts the
 * shared financial decision without appending evidence, applying provisional
 * money or granting permission. The server independently decides on submission. */
export function reviewLinkedCorrection({ budgetId, parts, auditHashes, payload, today, generationTimestamp }, hostOptions = {}) {
  const request = normalizeLedgerCorrectionPayload(payload);
  const retained = verifyLinkedLedgerAudit({ budgetId, parts, auditHashes }, hostOptions);
  const rows = parts.ledger.map(row => validateLedgerCorrectionFact(normalizeLedgerAuditFact(row, budgetId), budgetId));
  const original = retained?.replay.originals.find(item => item.row.id === request.targetId);
  const originalRow = original?.row ?? (retained === null ? rows.find(row => row.id === request.targetId) : null);
  if (!originalRow) throw new Error('Recorded payment has no original audit evidence');
  const head = retained ? new Map(retained.replay.heads).get(request.targetId) : null;
  if (request.retryOf !== null) {
    const corrections = retained?.replay.corrections || [];
    if (!corrections.some(event => event.id === request.retryOf && event.targetId === request.targetId && event.status === 'blocked')
      || corrections.some(event => event.retryOf === request.retryOf)) throw new Error('Retained intention is missing, foreign or already reviewed');
  }
  const plan = planLedgerCorrection({ budgetId, rows, original: originalRow, currentCorrectionId: head,
    expectedCorrectionId: request.expectedCorrectionId, replacement: request.replacement, reason: request.reason,
    openingBalance: retained?.replay.opening?.ledgerCurrency === originalRow.ledger_currency ? retained.replay.opening.amount : 0,
    today, createdAt: generationTimestamp, sourceAtAcceptance: original?.sourceAtAcceptance ?? null });
  return { budgetId, targetId: request.targetId, expectedCorrectionId: request.expectedCorrectionId, intent: request,
    status: plan.status, failureCode: plan.failureCode, blockingIds: plan.blockingIds,
    before: plan.before, after: plan.after };
}

/** JSON sandbox adapter returns review only; no applicable ledger or receipt. */
export function reviewLinkedCorrectionJson(json) {
  try { return JSON.stringify({ ok: true, review: reviewLinkedCorrection(JSON.parse(json), ENGINE_AUDIT_HOST_OPTIONS) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LINKED_CORRECTION_REVIEW_REJECTED', message: error.message } }); }
}
