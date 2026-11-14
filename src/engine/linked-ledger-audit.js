import { materializationCheck } from './materialization-rejection.js';
import { ENGINE_AUDIT_HOST_OPTIONS } from './engine-host-capabilities.js';
import { decodeLedgerAuditRecords } from './ledger-audit-transport.js';
import { prepareLedgerAuditHashes, replayLedgerAuditFromHost } from './ledger-audit-host.js';
import { canonicalAuditValue } from './ledger-audit-json.js';
import { normalizeLedgerAuditFact } from './ledger-audit-fact.js';
import { validateLedgerCorrectionFact } from './cashflow-ledger-correction-plan.js';

/** A paged part contains one namespace header plus lossless original/event
 * records. Reconstruct only the known versioned shape; no unknown data is lost. */
export function linkedLedgerAudit(records, budgetId, hostOptions = {}) {
  return decodeLedgerAuditRecords(records, budgetId, hostOptions);
}

/** Hash preparation is read-only and returns no accepted/provisional ledger. */
export function prepareLinkedLedgerAuditHashes({ budgetId, parts }, hostOptions = {}) {
  const audit = linkedLedgerAudit(parts?.['ledger-audit'], budgetId, hostOptions);
  return audit === null ? { budgetId, texts: [] } : prepareLedgerAuditHashes({ audit, budgetId }, hostOptions);
}

/** Replayed evidence must match the complete accepted ledger, before queued
 * intents are previewed. An audit from another financial head is insufficient. */
export function verifyLinkedLedgerAudit({ budgetId, parts, auditHashes }, hostOptions = {}) {
  const audit = linkedLedgerAudit(parts['ledger-audit'], budgetId, hostOptions);
  if (audit === null) return null;
  const replay = replayLedgerAuditFromHost({ audit, budgetId, hashes: auditHashes }, hostOptions);
  const actual = parts.ledger.map(row => materializationCheck('VERIFY_ACCEPTED_LEDGER', 'ledger',
    () => validateLedgerCorrectionFact(normalizeLedgerAuditFact(row, budgetId), budgetId)));
  const normalized = rows => JSON.stringify(canonicalAuditValue([...rows].sort((a, b) => a.id.localeCompare(b.id))));
  if (normalized(actual) !== normalized(replay.rows)) throw new Error('Linked ledger differs from retained audit evidence');
  return { audit, replay };
}

export function prepareLinkedLedgerAuditHashesJson(json) {
  try { return JSON.stringify({ ok: true, ...prepareLinkedLedgerAuditHashes(JSON.parse(json), ENGINE_AUDIT_HOST_OPTIONS) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LEDGER_AUDIT_REPLAY_REJECTED', message: error.message } }); }
}

/** Download commit gate returns only a scope receipt, never provisional rows. */
export function verifyLinkedLedgerAuditJson(json) {
  try {
    const input = JSON.parse(json);
    const retained = verifyLinkedLedgerAudit(input, ENGINE_AUDIT_HOST_OPTIONS);
    return JSON.stringify({ ok: true, budgetId: input.budgetId, retained: retained !== null });
  } catch (error) { return JSON.stringify({ ok: false, error: { code: 'LEDGER_AUDIT_REPLAY_REJECTED', message: error.message } }); }
}
