import { retainedLocalPaymentCount } from '../../src/engine/local-linked-origin.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { materializeLinkedStandalone, materializeLinkedStandaloneJson } from '../../src/engine/linked-materialization.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { encodeLedgerAuditRecords } from '../../src/engine/ledger-audit-transport.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';
import { refreshLocalSnapshot, confirmLocalOccurrence, correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { currencyTransferFixture, currencyTiming } from '../helpers/currency-transfer-fixture.js';
import { portableLinkedInstallmentCommand } from '../helpers/ledger-audit-fixtures.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { validateStandaloneTransferSource } from '../../src/server/cashflow-standalone-transfer-source.js';
import { auditSha256 } from '../../src/engine/audit-sha256.js';
const options = { allowStandaloneOrigins: true };
const codec = createLedgerAuditReplay({ ...options, digestText: auditSha256, utf8ByteLength: s => Buffer.byteLength(s) });
/** Genuine linked DTOs encode original proof and replay accepted server facts.
 * Planning is intentionally independent from immutable historical sources. */
function linked(snapshot) {
  const audit = { version: 2, budgetId: 'linked-server', baselineComplete: true, lastSequence: snapshot.localAudit.length,
    origin: standaloneLedgerOrigin(snapshot, currencyTiming.generationTimestamp), originals: [], corrections: [] };
  const replay = codec.replayLedgerAuditSnapshot(audit, audit.budgetId);
  return { budgetId: audit.budgetId, epoch: 'epoch', revision: 8, ...currencyTiming, parts: {
    settings: [snapshot.request.settings], ledger: replay.rows,
    planning: Object.entries(snapshot.request.tables).filter(([table]) => !['future_transactions', 'projection_snapshots', 'ledger_currency_events'].includes(table))
      .flatMap(([table, rows]) => rows.map(row => ({ table, row }))),
    'currency-events': snapshot.request.tables.ledger_currency_events || [], fx: [],
    'fx-snapshot': [{ snapshot: snapshot.request.fxSnapshot }], 'ledger-audit': encodeLedgerAuditRecords(audit, options) } };
}
function keep(command, extra = {}) {
  const input = { ...command, version: 1, identity: 'local-kept', name: 'Retained history', ...extra };
  input.auditHashes = prepareLinkedLedgerAuditHashes(input, options).texts.map(text => [text, auditSha256(text)]);
  return materializeLinkedStandalone(input);
}
test('KEEP reports missing replica settings precisely without substituting projection defaults', () => {
  const base = { ...portableLinkedInstallmentCommand(), version: 1, identity: 'local-kept', name: 'Retained history' };
  base.auditHashes = prepareLinkedLedgerAuditHashes(base, options).texts.map(text => [text, auditSha256(text)]);
  const incomplete = field => {
    const settings = structuredClone(base.parts.settings);
    delete settings[0][field];
    return settings;
  };
  for (const [settings, reason] of [
    [undefined, 'REPLICA_SETTINGS_REQUIRED'], [[], 'REPLICA_SETTINGS_REQUIRED'],
    [[{}], 'REPLICA_SETTINGS_REQUIRED'], [[null], 'REPLICA_SETTINGS_REQUIRED'],
    [incomplete('future_periods'), 'REPLICA_FUTURE_PERIODS_REQUIRED'],
    [incomplete('ledger_currency'), 'REPLICA_LEDGER_CURRENCY_REQUIRED']
  ]) {
    const input = { ...base, parts: { ...base.parts, settings } };
    const before = JSON.stringify(input);
    assert.throws(() => materializeLinkedStandalone(input), error => error.reason === reason
      && error.recordKind === 'settings' && error.check === 'PREPARE_REPLICA');
    assert.deepEqual(JSON.parse(materializeLinkedStandaloneJson(before)), { ok: false, error: {
      code: 'LINKED_MATERIALIZATION_REJECTED', message: 'Linked materialization rejected',
      reason, recordKind: 'settings', check: 'PREPARE_REPLICA'
    } });
    assert.equal(JSON.stringify(input), before);
  }
  const invalid = structuredClone(base);
  invalid.parts.settings[0].future_periods = 0;
  assert.throws(() => materializeLinkedStandalone(invalid), error => error.reason === 'INVALID_STANDALONE_PROJECTION_SETTINGS');
});
test('portable SHA-256 matches native UTF-8 including blocks, surrogates and Unicode', () => {
  for (const text of ['', 'abc', 'Zażółć 🌍', '\ud800', 'x'.repeat(10000)]) assert.equal(auditSha256(text), createHash('sha256').update(text).digest('hex'));
});
test('genuine partial/voided/deleted-source linked history keeps original corrections and pending decisions', () => {
  const command = portableLinkedInstallmentCommand();
  command.parts.planning = command.parts.planning.filter(record => record.table !== 'one_off_transactions');
  const before = JSON.stringify(command);
  const copy = keep(command);
  assert.equal(JSON.stringify(command), before);
  assert.equal(copy.budgetId, 'local-kept');
  assert.equal(copy.revision, 0);
  assert.equal(copy.request.openingBalance, 450);
  assert.equal(copy.localHistory.length, 1);
  assert.equal(copy.localAudit[0].audit.originals.length, 2);
  assert.equal(retainedLocalPaymentCount(copy.localAudit), 2);
  assert.equal(copy.localAudit[0].audit.corrections.length, 3);
  assert.equal(copy.request.tables.pending_transactions[0].occurrence_key, 'one_off_remainder:desk:8');
  assert.equal(refreshLocalSnapshot({ snapshot: copy, ...command }).request.openingBalance, 450);
  assert.equal(copy.linked, undefined);
});
for (const stage of ['pending', 'confirmed', 'voided', 'returned']) for (const reviewed of [false, true]) {
  test(`currency ${stage}, H5 reviewed=${reviewed}: KEEP preserves origin balances, history and upload proof`, () => {
    const source = currencyTransferFixture(stage, reviewed);
    const command = linked(source);
    const copy = keep(command);
    assert.equal(copy.request.openingBalance, source.request.openingBalance);
    assert.equal(copy.localHistory.length, source.localHistory.length);
    assert.deepEqual(copy.request.tables.ledger_currency_events, source.request.tables.ledger_currency_events);
    assert.equal(copy.request.tables.pending_transactions.length, source.request.tables.pending_transactions.length);
    const refreshed = refreshLocalSnapshot({ snapshot: copy, ...currencyTiming });
    assert.equal(refreshed.request.openingBalance, source.request.openingBalance);
    const origin = standaloneLedgerOrigin(copy, currencyTiming.generationTimestamp);
    const replay = replayStandaloneLedgerOrigin({ origin, budgetId: 'uploaded-again', utf8ByteLength: text => Buffer.byteLength(text) });
    assert.equal(replay.rows.length, copy.localHistory.length);
    assert.deepEqual([...replay.heads], [...codec.replayLedgerAuditSnapshot(copy.localAudit[0].audit, 'linked-server').heads]);
    copy.transferVersion = 3;
    assert.equal(validateStandaloneTransferSource(JSON.stringify(copy), currencyTiming).confirmedBalance, source.request.openingBalance);
  });
}
test('FX and corrected/deleted source do not manufacture a same-currency legacy baseline', () => {
  const { snapshot } = standaloneOriginAuditFixture({ currency: 'EUR', amount: 20 });
  snapshot.request.tables.one_off_transactions = [];
  const copy = keep(linked(snapshot));
  assert.equal(copy.localHistory[0].currency, 'EUR');
  assert.equal(copy.localHistory[0].fx_rate, 4.2);
  assert.equal(copy.request.openingBalance, 416);
});
test('unknown, blocked and correction intentions remain separate; no automatic money or operation replay', () => {
  const intentions = ['sent', 'accepted', 'queued', 'blocked', 'rejected'].map((state, index) => ({ operationId: String(index),
    kind: 'ledger.correct', state, payload: { targetId: 'income', replacement: null } }));
  const copy = keep(portableLinkedInstallmentCommand(), { intentions });
  assert.equal(copy.request.openingBalance, 450);
  assert.equal(copy.localIntentions.length, 5);
  assert.equal(copy.localIntentions[0].outcome, 'unknown-in-replica');
  assert.ok(copy.localIntentions.every(op => op.reviewRequired));
  assert.deepEqual(refreshLocalSnapshot({ snapshot: copy, ...currencyTiming }).localIntentions, copy.localIntentions);
});
test('pending conversion can be confirmed on the independent copy and refreshed', () => {
  const copy = keep(linked(currencyTransferFixture('pending')));
  const occurrenceKey = copy.request.tables.pending_transactions[0].occurrence_key;
  const paid = confirmLocalOccurrence({ snapshot: copy, ...currencyTiming, idSeed: 'kept-confirm', occurrenceKey });
  assert.equal(paid.request.openingBalance, 100);
  assert.equal(paid.request.tables.pending_transactions.length, 0);
  assert.equal(refreshLocalSnapshot({ snapshot: paid, ...currencyTiming }).request.openingBalance, 100);
});
test('new local correction preserves legacy server original and historical head', () => {
  const copy = keep(portableLinkedInstallmentCommand());
  const next = correctLocalConfirmation({ snapshot: copy, today: '2026-10-24', generationTimestamp: '2026-10-24T12:00:00.000Z',
    idSeed: 'new-review', confirmationId: 'income', expectedCorrectionId: 'retry', reason: 'Independent review', replacement: { amount: 460, date: '2018-01-01' } });
  assert.equal(next.request.openingBalance, 460);
  assert.deepEqual(next.localAudit[0], copy.localAudit[0]);
});
test('altered retained correction outcome and copy mirrors reject without changing input', () => {
  const copy = keep(portableLinkedInstallmentCommand());
  copy.localAudit[0].audit.corrections[0].status = 'accepted';
  assert.throws(() => refreshLocalSnapshot({ snapshot: copy, ...currencyTiming }));
  const other = keep(portableLinkedInstallmentCommand());
  other.localHistory[0].amount++;
  assert.throws(() => refreshLocalSnapshot({ snapshot: other, ...currencyTiming }), /altered/);
});
test('unsent planning edits are materialized locally while blocked followers remain recoverable', () => {
  const command = portableLinkedInstallmentCommand();
  const intentions = [
    { operationId: 'new-source', state: 'queued', kind: 'one-off.create', payload: { id: 'created', name: 'Local retained bill', currency: 'PLN', amount: 10, type: 'expense', date: '2026-10-24' } },
    { operationId: 'correction', state: 'queued', kind: 'ledger.correct', payload: { targetId: 'income' } },
    { operationId: 'follower', state: 'queued', kind: 'one-off.delete', payload: { id: 'created' } }
  ];
  const copy = keep(command, { intentions });
  assert.ok(copy.request.tables.one_off_transactions.some(row => row.id === 'created'));
  assert.equal(copy.localIntentions[0].outcome, 'applied-locally');
  assert.equal(copy.localIntentions[1].reviewRequired, true);
  assert.equal(copy.localIntentions[2].reason, 'EARLIER_INTENTION_NEEDS_REVIEW');
  assert.equal(copy.request.openingBalance, 450);
});
test('voided legacy installment ordinals remain reserved for fresh local payments', () => {
  const copy = keep(portableLinkedInstallmentCommand());
  const progress = copy.request.oneOffProgress.find(([, row]) => row.sourceId === 'desk')[1];
  assert.equal(progress.confirmedCount, 7);
  const paid = confirmLocalOccurrence({ snapshot: copy, today: '2026-10-24', generationTimestamp: '2026-10-24T12:00:00.000Z',
    idSeed: 'new-partial', occurrenceKey: 'one_off_remainder:desk:8', amount: 10 });
  assert.equal(paid.localHistory.find(row => row.id === 'confirmed-new-partial').occurrence_key, 'one_off_remainder:desk:8');
  assert.equal(paid.request.openingBalance, 440);
});
import { reviewLocalCorrection, applyReviewedLocalCorrection } from '../../src/engine/local-correction-review.js';
test('H5 explicit conversion review remains usable on a KEEP copy with captured origin order', () => {
  const copy = keep(linked(currencyTransferFixture('confirmed')));
  const input = { snapshot: copy, ...currencyTiming, idSeed: 'kept-h5', confirmationId: 'confirmed-old', expectedCorrectionId: null,
    reason: 'Review retained conversion', replacement: { amount: 80, date: currencyTiming.today } };
  const review = reviewLocalCorrection(input);
  assert.equal(review.status, 'accepted');
  assert.equal(review.changes.length, 1);
  const revised = applyReviewedLocalCorrection({ ...input, review });
  assert.equal(revised.request.openingBalance, 105);
  assert.deepEqual(revised.localAudit[0], copy.localAudit[0]);
  assert.equal(refreshLocalSnapshot({ snapshot: revised, ...currencyTiming }).request.openingBalance, 105);
});
test('a second upload/KEEP cycle retains the initial currency and signed opening', () => {
  const source = currencyTransferFixture('confirmed');
  const copy = keep(linked(source));
  const second = keep(linked(copy), { identity: 'local-second' });
  assert.equal(second.request.openingBalance, copy.request.openingBalance);
  assert.deepEqual(second.localHistory.map(row => [row.id, row.ledger_currency, row.running_balance_pln]), copy.localHistory.map(row => [row.id, row.ledger_currency, row.running_balance_pln]));
});
test('ordinary server conversion confirmed later retains evidence without inventing an event/payment link', () => {
  const command = portableLinkedInstallmentCommand();
  const audit = command.parts['ledger-audit'];
  const original = audit.find(record => record.kind === 'original' && record.value.row.id === 'expense').value;
  original.row.type = 'income'; original.row.amount = 400; original.row.ledger_amount = 400;
  original.row.source_one_off_id = null;
  original.row.occurrence_key = 'ledger_currency_conversion:server-conversion';
  original.row.date = '2026-10-24'; original.row.confirmed_date = '2026-10-24'; original.row.ledger_year = 2026;
  original.row.created_at = '2026-10-24T12:00:00.000Z'; original.row.updated_at = original.row.created_at;
  const retained = { version: 1, budgetId: command.budgetId, baselineComplete: true, lastSequence: 2,
    originals: audit.filter(record => record.kind === 'original').map(record => record.value), corrections: [] };
  command.parts['ledger-audit'] = encodeLedgerAuditRecords(retained);
  command.parts.ledger = codec.replayLedgerAuditSnapshot(retained, command.budgetId).rows;
  command.parts['currency-events'] = [{ id: 'server-switch', old_currency: 'EUR', new_currency: 'PLN', old_balance: 100,
    converted_opening_balance: 400, fx_rate: 4, rate_date: '2026-10-23', source: 'manual', details: '{"reason":"settings-update"}', created_at: '2026-10-23 12:00:00' }];
  const copy = keep(command);
  assert.equal(copy.request.openingBalance, 900);
  assert.deepEqual(copy.request.tables.ledger_currency_events, command.parts['currency-events']);
  assert.equal(refreshLocalSnapshot({ snapshot: copy, today: '2026-10-24', generationTimestamp: command.generationTimestamp, idSeed: 'reopen' }).request.openingBalance, 900);
});
test('genuine SQL budget scopes and UTC timestamp representations preserve H3 origin currency evidence', () => {
  const command = linked(currencyTransferFixture('pending'));
  command.parts['currency-events'] = command.parts['currency-events'].map(event => ({ ...event, budget_id: command.budgetId,
    created_at: event.created_at.replace('T', ' ').replace('.000Z', '') }));
  for (const record of command.parts.planning) record.row = { ...record.row, budget_id: command.budgetId };
  const copy = keep(command);
  assert.equal(copy.request.openingBalance, 0);
  assert.equal(copy.request.tables.ledger_currency_events[0].budget_id, copy.budgetId);
  const pending = copy.request.tables.pending_transactions[0];
  const paid = confirmLocalOccurrence({ snapshot: copy, ...currencyTiming, idSeed: 'sql-kept', occurrenceKey: pending.occurrence_key });
  assert.equal(paid.request.openingBalance, 100);
});
test('source-less first-run decisions remain pending and visible for fresh local review', () => {
  const command = portableLinkedInstallmentCommand();
  command.parts.planning.push({ table: 'pending_transactions', row: { id: 'opening-decision', name: 'Opening', amount: 10,
    type: 'income', currency: 'PLN', ledger_currency: 'PLN', date: '2026-10-24', status: 'pending',
    occurrence_key: 'first_run_opening_balance:opening-decision', fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 10,
    funded_amount: 10, requested_amount: 10, pending_origin: 'system', period: '2026-10', created_at: command.generationTimestamp, updated_at: command.generationTimestamp } });
  const copy = keep(command);
  assert.equal(copy.request.openingBalance, 450);
  assert.ok(copy.request.tables.pending_transactions.some(row => row.id === 'opening-decision'));
  assert.ok(copy.localIntentions.some(intention => intention.kind === 'pending-decision' && intention.reviewRequired));
});

test('PostgreSQL JSONB currency details match retained H3/H5 origin JSON text', () => {
  const source = currencyTransferFixture('pending', true);
  const command = linked(source);
  command.parts['currency-events'] = command.parts['currency-events'].map(row => ({ ...row, details: JSON.parse(row.details) }));
  const altered = JSON.parse(JSON.stringify(command));
  altered.parts['currency-events'][0].details.reason = 'changed';
  assert.throws(() => keep(altered), /Altered captured currency event/);
  const copy = keep(command);
  assert.equal(copy.request.openingBalance, source.request.openingBalance);
  assert.equal(refreshLocalSnapshot({ snapshot: copy, ...currencyTiming }).request.openingBalance, source.request.openingBalance);
  const origin = standaloneLedgerOrigin(copy, currencyTiming.generationTimestamp);
  assert.equal(replayStandaloneLedgerOrigin({ origin, budgetId: 'jsonb-uploaded', utf8ByteLength: text => Buffer.byteLength(text) }).rows.length, copy.localHistory.length);
});
