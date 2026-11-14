import { completeSnapshot } from '../engine/fixtures.js';
import { confirmLocalOccurrence, correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { changeLocalLedgerCurrency } from '../../src/engine/local-ledger-currency.js';
import { normalizeLedgerAuditFact } from '../../src/engine/ledger-audit-fact.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';
import { canonicalAuditValue } from '../../src/engine/ledger-audit-json.js';
import { planLedgerCorrection } from '../../src/engine/cashflow-ledger-correction-plan.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { encodeLedgerAuditRecords } from '../../src/engine/ledger-audit-transport.js';
import { auditSha256 } from '../../src/engine/audit-sha256.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { materializeLinkedStandalone } from '../../src/engine/linked-materialization.js';
export const nativeTiming = { today: '2026-10-28', generationTimestamp: '2026-10-28T12:00:00.000Z', idSeed: 'native-keep' };
const hash = value => auditSha256(JSON.stringify(canonicalAuditValue(value)));
const codec = createLedgerAuditReplay({ digestText: auditSha256, utf8ByteLength: text => Buffer.byteLength(text), allowStandaloneOrigins: true });
/** Synthetic native accepted facts are independently replayed as a server audit.
 * Currency switches are deliberately absent from its sequence; their durable
 * boundaries live in currency-event details, just like native server writes. */
export function nativeKeepFixture({ stage = 'confirmed', repeated = false, uploaded = false, signed = false, legacy = false } = {}) {
  const timing = nativeTiming;
  let source = completeSnapshot(); source.budgetId = 'local-source-h8'; source.name = 'Synthetic native history';
  Object.assign(source.request, timing); source.request.openingBalance = signed ? -100 : 0;
  source.request.tables.one_off_transactions = [];
  function pay(id, type, amount, currency) {
    source.request.tables.one_off_transactions.push({ id, name: id, type, amount, currency, date: timing.today });
    source = confirmLocalOccurrence({ snapshot: source, ...timing, idSeed: id, occurrenceKey: `one_off:${id}:${type}:${timing.today}` });
  }
  pay('income', 'income', signed === 'zero' ? 100 : 500, 'PLN');
  let prefix = uploaded || signed ? structuredClone(source) : null;
  if (signed !== 'zero') pay('old', 'expense', 100, 'PLN');
  function change(currency, rate, id) {
    source = changeLocalLedgerCurrency({ snapshot: source, ...timing, idSeed: id, newCurrency: currency,
      manualRates: { [`${source.request.settings.ledger_currency}/${currency}`]: rate } });
    if (stage !== 'pending' || repeated) source = confirmLocalOccurrence({ snapshot: source, ...timing, idSeed: id + '-paid', occurrenceKey: source.request.tables.pending_transactions[0].occurrence_key });
  }
  change('EUR', 0.25, 'euro');
  if (uploaded === 'currency') {
    prefix = structuredClone(source);
    if (!repeated) pay('addition-only', 'income', 20, 'EUR');
  }
  if (stage === 'voided') source = correctLocalConfirmation({ snapshot: source, ...timing, idSeed: 'void', confirmationId: 'confirmed-euro-paid', expectedCorrectionId: null, reason: 'Void conversion', replacement: null });
  if (stage === 'funding') pay('spend', 'expense', 95, 'EUR');
  if (repeated) { pay('addition', 'income', 20, 'EUR'); change('GBP', 2, 'pound'); change('PLN', 4, 'return'); }
  if (repeated === 'ambiguous') change('EUR', 0.25, 'again');
  const budgetId = 'native-server-h8';
  const audit = { version: prefix ? 2 : 1, budgetId, baselineComplete: true, lastSequence: prefix?.localAudit.length || 0,
    ...(prefix ? { origin: standaloneLedgerOrigin(prefix, timing.generationTimestamp) } : {}), originals: [], corrections: [] };
  const paymentIds = prefix ? prefix.localAudit.filter(value => value.kind === 'payment').map(value => value.id) : [];
  const currencyEvents = prefix ? structuredClone(prefix.request.tables.ledger_currency_events || []) : [];
  const receipts = [];
  const receipt = (kind, payload, extra = {}) => {
    const revision = receipts.length + 1, operationId = `operation-${revision}`, epoch = '11111111-1111-4111-8111-111111111111';
    receipts.push({ operation: { version: 1, budgetId, epoch, operationId, baseRevision: revision - 1, kind, payload },
      result: { version: 1, budgetId, epoch, operationId, revision, sourceId: null, replayed: false, ...extra } });
  };
  for (const event of source.localAudit.slice(prefix?.localAudit.length || 0)) {
    if (event.kind === 'payment') {
      const row = normalizeLedgerAuditFact(event.row, budgetId);
      row.budget_id = budgetId; delete row.running_balance_pln;
      const scope = value => value == null ? value : { ...value, ...(Object.hasOwn(value, 'budget_id') ? { budget_id: budgetId } : {}) };
      audit.originals.push({ version: 1, budgetId, sequence: ++audit.lastSequence, captureKind: 'payment', actorId: 'owner', capturedAt: timing.generationTimestamp,
        row, sourceAtAcceptance: event.source?.table === 'ledger_currency_events' ? null : { ...event.source, row: scope(event.source.row), plan: scope(event.source.plan) } });
      paymentIds.push(row.id); receipt('occurrence.confirm', { occurrenceKey: row.occurrence_key, amount: row.amount, confirmedDate: row.date, fxRate: null }, { confirmedTransaction: row });
    } else if (event.kind === 'ledger-currency') {
      const order = { version: 1, eventId: event.id, conversionId: event.pending.id, afterSequence: audit.lastSequence,
        paymentIds: [...paymentIds].sort(), previousEventIds: currencyEvents.map(value => value.id).sort() };
      currencyEvents.push({ ...event.event, ...(legacy ? {} : { details: JSON.stringify({ reason: 'settings-update', acceptanceOrder: order }) }) });
      receipt('settings.update', { ledger_currency: event.event.new_currency }, { pendingConversion: event.pending });
    } else if (event.kind === 'correction') {
      const replay = codec.replayLedgerAuditSnapshot(audit, budgetId), original = replay.originals.get(event.targetId);
      const expectedCorrectionId = replay.heads.get(event.targetId), actorId = 'owner', retryOf = null;
      const plan = planLedgerCorrection({ budgetId, rows: replay.rows, original: original.row, currentCorrectionId: expectedCorrectionId,
        expectedCorrectionId, replacement: event.requested, reason: event.reason, today: timing.today, createdAt: timing.generationTimestamp,
        sourceAtAcceptance: original.sourceAtAcceptance, policyVersion: 2 });
      audit.corrections.push({ version: 2, budgetId, id: event.id, targetId: event.targetId, actorId, sequence: ++audit.lastSequence,
        originalHash: hash(original), previousAcceptedId: expectedCorrectionId, retryOf,
        requestHash: hash({ targetId: event.targetId, expectedCorrectionId, replacement: event.requested, reason: event.reason, actorId, retryOf }),
        requested: event.requested, reason: event.reason, reviewDate: timing.today, createdAt: timing.generationTimestamp,
        ...Object.fromEntries(['status', 'failureCode', 'blockingIds', 'before', 'after'].map(key => [key, plan[key]])) });
      receipt('ledger.correct', { targetId: event.targetId });
    }
  }
  if (legacy) for (const event of currencyEvents) event.orderResolution = { version: 1, epoch: receipts[0].result.epoch, headRevision: receipts.length, records: receipts };
  const replay = codec.replayLedgerAuditSnapshot(audit, budgetId);
  const parts = { settings: [source.request.settings], planning: Object.entries(source.request.tables).filter(([table]) =>
    ['planned_transactions', 'one_off_transactions', 'recurring_incomes', 'recurring_expenses', 'goals', 'flex_transactions', 'pending_transactions'].includes(table))
    .flatMap(([table, rows]) => rows.map(row => ({ table, row }))),
    ledger: replay.rows, 'ledger-audit': encodeLedgerAuditRecords(audit, { allowStandaloneOrigins: true }),
    'currency-events': currencyEvents, fx: [], 'fx-snapshot': [{ snapshot: source.request.fxSnapshot }] };
  const input = { version: 1, identity: 'local-native-copy', name: 'Native KEEP', budgetId, epoch: 'epoch', revision: 5, parts, ...timing };
  input.auditHashes = prepareLinkedLedgerAuditHashes(input, { allowStandaloneOrigins: true }).texts.map(text => [text, auditSha256(text)]);
  return { input, copy: materializeLinkedStandalone(input), audit };
}
