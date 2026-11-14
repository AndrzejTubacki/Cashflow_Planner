import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSnapshot } from './fixtures.js';
import { previewLocalCsv, exportLocalLedgerCsv, confirmedLedgerRowsToCsv, parseCsv } from '../../src/engine/local-csv.js';
import { refreshLocalSnapshot, confirmLocalOccurrence, correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
const header = 'name,type,amount,currency,date';
const csv = `${header}\n"New, ""quoted""",income,"12,34",pln,2026-06-02`;
function fixture() {
  const snapshot = completeSnapshot();
  snapshot.budgetId = 'local-csv';
  snapshot.request.openingBalance = 1000;
  snapshot.request.tables.one_off_transactions = [
    { id: 'paid', name: 'Payment', type: 'expense', amount: 20, currency: 'PLN', date: '2026-06-01' },
    { id: 'unpaid', name: 'Plan', type: 'expense', amount: 10, currency: 'PLN', date: '2026-06-03' }];
  return refreshLocalSnapshot({ snapshot, today: snapshot.request.today,
    generationTimestamp: snapshot.request.generationTimestamp, idSeed: 'fixture' });
}
const preview = (snapshot, text = `${header}\nNew,income,12.34,PLN,2026-06-02`, mode = 'append') =>
  previewLocalCsv({ snapshot, csv: text, mode, idSeed: 'review' });
function payment() {
  const snapshot = fixture();
  const row = calculateSnapshot(snapshot).plan.pendingRows.find(r => r.source_one_off_id === 'paid');
  return confirmLocalOccurrence({ snapshot, occurrenceKey: row.occurrence_key, today: snapshot.request.today,
    generationTimestamp: snapshot.request.generationTimestamp, idSeed: 'pay' });
}
test('CSV server dialect handles BOM CRLF quoted commas escaped quotes and decimal comma', () => {
  const p = preview(fixture(), '\uFEFF' + csv.replace('\n', '\r\n'));
  assert.deepEqual(p.errors, []); assert.equal(p.rows[0].name, 'New, "quoted"');
  assert.equal(p.rows[0].amount, 12.34); assert.equal(p.rows[0].currency, 'PLN');
});
test('append is pure and stable and advances revision once', () => {
  const base = fixture(), before = JSON.stringify(base), p = preview(base);
  assert.equal(JSON.stringify(base), before); assert.deepEqual(preview(base), p);
  assert.equal(p.snapshot.revision, base.revision + 1);
  assert.equal(p.snapshot.request.tables.one_off_transactions.length, 3);
  assert.deepEqual(p.deleteOneOffIds, []);
});
test('replace retains accepted history-bearing sources and other tables', () => {
  const base = payment(), p = preview(base, undefined, 'replace');
  assert.deepEqual(p.deleteOneOffIds, ['unpaid']); assert.equal(p.retained, 1);
  assert.deepEqual(p.snapshot.localAudit, base.localAudit); assert.deepEqual(p.snapshot.localHistory, base.localHistory);
  assert.deepEqual(p.snapshot.request.tables.recurring_incomes, base.request.tables.recurring_incomes);
  assert.equal(p.snapshot.request.tables.one_off_transactions.length, 2);
});
test('replace protects voided originals so corrections can restore them', () => {
  let base = payment(); const original = base.localHistory[0];
  base = correctLocalConfirmation({ snapshot: base, confirmationId: original.id, expectedCorrectionId: null,
    replacement: null, reason: 'Reviewed void', today: base.request.today,
    generationTimestamp: base.request.generationTimestamp, idSeed: 'void' });
  const p = preview(base, undefined, 'replace');
  assert.equal(p.snapshot.localHistory.length, 0); assert.deepEqual(p.deleteOneOffIds, ['unpaid']);
  const restored = correctLocalConfirmation({ snapshot: p.snapshot, confirmationId: original.id,
    expectedCorrectionId: base.localAudit.at(-1).id, replacement: { amount: 20, date: original.date },
    reason: 'Reviewed restoration', today: base.request.today, generationTimestamp: base.request.generationTimestamp, idSeed: 'restore' });
  assert.equal(restored.localHistory[0].amount, 20);
});
test('invalid rows report all field errors without a partial plan', () => {
  const p = preview(fixture(), `${header}\n,other,-1,XXX,2026-02-30\nBad,income,no,USD,no`);
  assert.equal(p.errors.length, 7); assert.equal(p.snapshot, undefined);
  assert.deepEqual([...new Set(p.errors.map(e => e.row))], [2, 3]);
});
test('empty reordered duplicate unknown columns malformed quotes and counts fail closed', () => {
  for (const text of ['', header, 'type,name,amount,currency,date\na,income,1,PLN,2026-06-02',
    'name,name,amount,currency,date', header + '\n"bad,income,1,PLN,2026-06-02',
    header + '\n"bad"x,income,1,PLN,2026-06-02', header + '\na,income,1,PLN']) {
    const p = preview(fixture(), text); assert.ok(p.errors.length); assert.equal(p.snapshot, undefined);
  }
});
test('native boundaries give row errors for zero huge amount long names and missing FX', () => {
  for (const row of ['Zero,income,0,PLN,2026-06-02', 'Huge,income,999999999999999999,PLN,2026-06-02',
    `${'n'.repeat(101)},income,1,PLN,2026-06-02`, 'FX,income,1,EUR,2026-06-02']) {
    assert.ok(preview(fixture(), header + '\n' + row).errors.length);
  }
});
test('unknown modes and malformed seeds are rejected', () => {
  assert.throws(() => preview(fixture(), csv, 'merge'));
  assert.throws(() => previewLocalCsv({ snapshot: fixture(), csv, mode: 'append', idSeed: '../unsafe' }));
});
test('export preserves actual original and ledger money dates FX and header order', () => {
  const base = fixture(); base.request.fxSnapshot = { 'eur/pln': { rate: 4, source: 'manual', effectiveDate: '2026-06-01' } };
  base.request.tables.one_off_transactions[0].currency = 'EUR';
  const pending = calculateSnapshot(base).plan.pendingRows.find(r => r.source_one_off_id === 'paid');
  const paid = confirmLocalOccurrence({ snapshot: base, occurrenceKey: pending.occurrence_key, amount: 20, fxRate: 4,
    today: base.request.today, generationTimestamp: base.request.generationTimestamp, idSeed: 'foreign' });
  const text = exportLocalLedgerCsv({ snapshot: paid });
  const [headers, values] = text.split('\n').map((line, i) => parseCsvLineForTest(line));
  const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  assert.equal(row.currency, 'EUR'); assert.equal(row.ledger_currency, 'PLN');
  assert.equal(row.amount, '20'); assert.equal(row.ledger_amount, '80');
  assert.equal(row.date, '2026-06-01'); assert.equal(row.confirmed_date, base.request.today);
  assert.equal(row.fx_rate, '4'); assert.equal(row.running_balance, '920');
  assert.equal(headers.length, 21);
});
// CSV output always quotes cells; this test helper only decodes that output dialect.
function parseCsvLineForTest(line) { return line.startsWith('"') ? line.slice(1, -1).split('","').map(s => s.replaceAll('""', '"')) : line.split(','); }
test('confirmed export excludes voids and spreadsheet formulas are escaped', () => {
  let base = payment();
  assert.equal(exportLocalLedgerCsv({ snapshot: base }).split('\n').length, 2);
  base = correctLocalConfirmation({ snapshot: base, confirmationId: base.localHistory[0].id, expectedCorrectionId: null,
    replacement: null, reason: 'Reviewed void', today: base.request.today, generationTimestamp: base.request.generationTimestamp, idSeed: 'void' });
  assert.equal(exportLocalLedgerCsv({ snapshot: base }).split('\n').length, 1);
  assert.match(confirmedLedgerRowsToCsv([{ name: '=HYPERLINK("bad")', ledger_currency: 'EUR' }]), /'=/);
});

test('export retains several ledger currencies across a confirmed currency transition', async () => {
  const { changeLocalLedgerCurrency } = await import('../../src/engine/local-ledger-currency.js');
  let base = payment();
  base.request.settings.manual_fx_rates = { 'PLN/EUR': 0.25 };
  base = changeLocalLedgerCurrency({ snapshot: base, newCurrency: 'EUR', today: base.request.today,
    generationTimestamp: base.request.generationTimestamp, idSeed: 'switch' });
  const conversion = base.request.tables.pending_transactions[0];
  base = confirmLocalOccurrence({ snapshot: base, occurrenceKey: conversion.occurrence_key, today: base.request.today,
    generationTimestamp: base.request.generationTimestamp, idSeed: 'conversion' });
  const lines = exportLocalLedgerCsv({ snapshot: base }).split('\n').map(parseCsvLineForTest);
  const header = lines.shift();
  const rows = lines.map(values => Object.fromEntries(header.map((key, i) => [key, values[i]])));
  assert.ok(rows.some(row => row.ledger_currency === 'PLN' && row.amount === '20'));
  assert.ok(rows.some(row => row.ledger_currency === 'EUR'));
  assert.ok(rows.every(row => /^2026-06-0[12]$/.test(row.date)));
});
