import { refreshLocalSnapshot } from './local-confirmation.js';
import { correctAuditedLocalConfirmation } from './local-audited-snapshot.js';
import { canonicalAuditValue } from './ledger-audit-json.js';

/** Review is a pure prediction bound to the complete snapshot revision and the
 * exact intention. It is never applied by refresh/replay of a blocked record. */
export function reviewLocalCorrection(command) {
  const snapshot = refreshLocalSnapshot(command);
  const predicted = correctAuditedLocalConfirmation({ ...command, snapshot, reviewConversions: true });
  const event = predicted.localAudit.at(-1);
  return canonicalAuditValue({ budgetId: snapshot.budgetId, revision: snapshot.revision,
    confirmationId: command.confirmationId, expectedCorrectionId: command.expectedCorrectionId,
    reason: command.reason, replacement: command.replacement, retryOf: command.retryOf ?? null,
    today: command.today, status: event.status, failureCode: event.failureCode,
    ...(event.conversionReview?.orderingResolution ? { orderingResolution: event.conversionReview.orderingResolution } : {}),
    ...(event.failureCode === 'currency_conversion_dependency' ? { orderingBlocked: 'accepted_ordering_evidence_unavailable' } : {}),
    changes: event.conversionReview?.changes || [],
    downstream: event.conversionReview?.downstream || predicted.localHistory.filter(row => row.id !== command.confirmationId) });
}

/** Recompute the entire review under the caller's atomic snapshot transaction.
 * Changed intent, accepted history or downstream effects require a new review. */
export function applyReviewedLocalCorrection(command) {
  const current = reviewLocalCorrection(command);
  if (JSON.stringify(canonicalAuditValue(command.review)) !== JSON.stringify(current)) throw new Error('Correction effects changed; review again');
  const snapshot = refreshLocalSnapshot(command);
  return correctAuditedLocalConfirmation({ ...command, snapshot, reviewConversions: true });
}

/** Native bridges return no partial snapshot when review or application fails. */
export function reviewLocalCorrectionJson(json) {
  try { return JSON.stringify({ ok: true, review: reviewLocalCorrection(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LOCAL_CORRECTION_REVIEW_REJECTED', message: error.message } }); }
}
export function applyReviewedLocalCorrectionJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: applyReviewedLocalCorrection(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LOCAL_CORRECTION_REVIEW_REJECTED', message: error.message } }); }
}
