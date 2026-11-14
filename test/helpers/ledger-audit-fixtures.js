import { createHash } from 'node:crypto';
import { planLedgerCorrection, validateLedgerCorrectionFact } from '../../src/engine/cashflow-ledger-correction-plan.js';
import { canonicalAuditValue } from '../../src/engine/ledger-audit-json.js';
import { normalizeLedgerAuditFact } from '../../src/engine/ledger-audit-fact.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';

const hash = value => createHash('sha256').update(JSON.stringify(canonicalAuditValue(value))).digest('hex');
const codec = createLedgerAuditReplay({ digestText: text => createHash('sha256').update(text).digest('hex'),
  utf8ByteLength: text => Buffer.byteLength(text) });

/** Synthetic cross-host evidence predates review by years, includes a blocked
 * historical reduction and an accepted explicit retry. No runtime/user data. */
export function portableLedgerAuditFixture() {
  const budgetId = 'portable-audit';
  const stamp = '2026-10-24T12:00:00.000Z';
  const fact = (id, type, amount, date) => validateLedgerCorrectionFact(normalizeLedgerAuditFact({ id, name: id, budget_id: budgetId, amount, type,
    currency: 'PLN', ledger_currency: 'PLN', date, confirmed_date: date, ledger_year: Number(date.slice(0, 4)),
    created_at: `${date}T12:00:00.000Z`, updated_at: `${date}T12:00:00.000Z`,
    fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount, occurrence_key: `manual:${id}` }, budgetId), budgetId);
  const rows = [fact('income', 'income', 500, '2018-01-01'), fact('expense', 'expense', 400, '2019-01-01')];
  const originals = rows.map((row, index) => ({ version: 1, budgetId, sequence: index + 1,
    captureKind: 'legacy', actorId: null, capturedAt: stamp, row, sourceAtAcceptance: null }));
  const corrections = [200, 450].map((amount, index) => {
    const requested = { amount, date: '2018-01-01' };
    const retryOf = index ? 'blocked' : null;
    const reason = 'Reviewed historical income — korekta: zażółć 🪙';
    const plan = planLedgerCorrection({ budgetId, rows, original: rows[0], currentCorrectionId: null,
      expectedCorrectionId: null, replacement: requested, reason, today: '2026-10-24', createdAt: stamp });
    return { version: 1, budgetId, id: index ? 'retry' : 'blocked', targetId: 'income', actorId: 'reviewer',
      sequence: index + 3, originalHash: hash(originals[0]), previousAcceptedId: null, retryOf,
      requestHash: hash({ targetId: 'income', expectedCorrectionId: null, replacement: requested, reason, actorId: 'reviewer', retryOf }),
      requested, reason, reviewDate: '2026-10-24', createdAt: stamp,
      ...Object.fromEntries(['status', 'failureCode', 'blockingIds', 'before', 'after'].map(key => [key, plan[key]])) };
  });
  return { version: 1, budgetId, baselineComplete: true, lastSequence: 4, originals, corrections };
}

/** Voiding the only surviving legacy installment must reserve ordinal 7 even
 * though its effective payment disappears. Missing older facts stay unknown. */
export function portableVoidedInstallmentFixture(sourceId = 'desk') {
  const audit = portableLedgerAuditFixture();
  const original = audit.originals[1];
  original.row.source_one_off_id = sourceId;
  original.row.occurrence_key = `one_off_remainder:${sourceId}:7`;
  const effective = codec.replayLedgerAuditSnapshot(audit, audit.budgetId).rows;
  const reason = 'Voided historical installment';
  const actorId = 'reviewer';
  const requested = null;
  const stamp = '2026-10-24T12:00:00.000Z';
  const plan = planLedgerCorrection({ budgetId: audit.budgetId, rows: effective, original: original.row,
    currentCorrectionId: null, expectedCorrectionId: null, replacement: requested, reason, today: '2026-10-24', createdAt: stamp });
  audit.corrections.push({ version: 1, budgetId: audit.budgetId, id: 'void-expense', targetId: original.row.id,
    actorId, sequence: 5, originalHash: hash(original), previousAcceptedId: null, retryOf: null,
    requestHash: hash({ targetId: original.row.id, expectedCorrectionId: null, replacement: requested, reason, actorId, retryOf: null }),
    requested, reason, reviewDate: '2026-10-24', createdAt: stamp,
    ...Object.fromEntries(['status', 'failureCode', 'blockingIds', 'before', 'after'].map(key => [key, plan[key]])) });
  audit.lastSequence = 5;
  return audit;
}

/** Complete state-v2 linked replica with a voided historical installment and
 * its current server-prepared remainder. It contains no hash receipts. */
export function portableLinkedInstallmentCommand(sourceId = 'desk') {
  const audit = portableVoidedInstallmentFixture(sourceId);
  const replay = codec.replayLedgerAuditSnapshot(audit, audit.budgetId);
  const { originals, corrections, ...state } = audit;
  const stamp = '2026-10-24T12:00:00.000Z';
  const source = { id: sourceId, name: 'Old installment', type: 'expense', currency: 'PLN', amount: 400,
    date: '2019-01-01', created_at: stamp, updated_at: stamp };
  const pending = { id: 'next-installment', name: source.name, type: 'expense', currency: 'PLN', amount: 400,
    requested_amount: 400, funded_amount: 400, ledger_amount: 400, ledger_currency: 'PLN', fx_rate: 1,
    buffered_fx_rate: 1, date: source.date, period: '2026-10', status: 'pending', source_one_off_id: source.id,
    occurrence_key: `one_off_remainder:${sourceId}:8`, created_at: stamp, updated_at: stamp };
  return { budgetId: audit.budgetId, epoch: '11111111-1111-4111-8111-111111111111', revision: 4,
    today: '2026-10-24', generationTimestamp: stamp, idSeed: 'audited-linked', pending: [], parts: {
      settings: [{ ledger_currency: 'PLN', timezone: 'Europe/Warsaw', holiday_country: 'PL', future_periods: 3,
        minimum_reserve_enabled: 0, minimum_reserve_amount: 0, budget_period_income_id: null, fx_buffer_percent: 0,
        manual_fx_rates: '{}', necessary_underfunded_repeat_days: 1 }],
      planning: [{ table: 'one_off_transactions', row: source }, { table: 'pending_transactions', row: pending }],
      ledger: replay.rows.map(row => ({ ...row, running_balance_pln: 450 })), 'currency-events': [], fx: [],
      'ledger-audit': [{ kind: 'state', value: state }, ...originals.map(value => ({ kind: 'original', value })),
        ...corrections.map(value => ({ kind: 'correction', value }))], 'fx-snapshot': [{ snapshot: null }]
    } };
}


/** Mixed policy history: a recorded deadline rejection, explicit modern retry,
 * void and restoration. Version 1 must remain blocked on every host. */
export function portableGoalPolicyFixture() {
  const audit = portableLedgerAuditFixture();
  audit.corrections = []; audit.lastSequence = 2;
  const original = audit.originals[1];
  Object.assign(original, { captureKind: 'payment', actorId: 'reviewer', sourceAtAcceptance: {
    table: 'goals', row: { id: 'goal', currency: 'PLN', due_date: '2018-12-31' }
  } });
  original.row.source_goal_id = 'goal';
  for (const [id, version, requested, retryOf] of [
    ['old-rejection', 1, { amount: 300, date: '2019-01-02' }, null],
    ['new-review', 2, { amount: 300, date: '2019-01-02' }, 'old-rejection'],
    ['void', 2, null, null], ['restore', 2, { amount: 250, date: '2020-01-02' }, null]
  ]) {
    const state = codec.replayLedgerAuditSnapshot(audit, audit.budgetId);
    const expectedCorrectionId = state.heads.get(original.row.id);
    const actorId = 'reviewer', reason = 'Review actual late payment';
    const plan = planLedgerCorrection({ budgetId: audit.budgetId, rows: state.rows, original: original.row,
      currentCorrectionId: expectedCorrectionId, expectedCorrectionId, replacement: requested, reason,
      today: '2026-10-24', createdAt: original.capturedAt, sourceAtAcceptance: original.sourceAtAcceptance, policyVersion: version });
    audit.corrections.push({ version, budgetId: audit.budgetId, id, targetId: original.row.id, actorId,
      sequence: ++audit.lastSequence, originalHash: hash(original), previousAcceptedId: expectedCorrectionId, retryOf,
      requestHash: hash({ targetId: original.row.id, expectedCorrectionId, replacement: requested, reason, actorId, retryOf }),
      requested, reason, reviewDate: '2026-10-24', createdAt: original.capturedAt,
      ...Object.fromEntries(['status', 'failureCode', 'blockingIds', 'before', 'after'].map(key => [key, plan[key]])) });
  }
  return audit;
}
