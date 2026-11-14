import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';

/** Real historical confirmations make source progress part of the invariant,
 * rather than testing a net-balance-only replacement that loses paid history. */
async function verifyPreservedHistory(databaseConfig, budgetStore = null) {
  const userId = 'history-preservation';
  const h = await createCashflowTestHarness({ userId, initializeUser: false, databaseConfig, today: '2026-05-20' });
  try {
    await h.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId, displayName: 'Synthetic history owner', email: 'history@example.test' } });
    const setup = await h.api('/api/setup', { method: 'POST', useSession: true,
      body: { currency: 'PLN', opening_balance: 1000, income_enabled: false } });
    await h.api(`/api/pending/${encodeURIComponent(setup.setup.created.openingBalanceId)}/confirm`, {
      method: 'POST', useSession: true, body: { confirmed_date: '2024-01-10' } });
    const planned = await h.api('/api/one-off', { method: 'POST', useSession: true,
      body: { name: 'Old paid purchase', currency: 'PLN', amount: 250, type: 'expense', date: '2024-02-10' } });
    const state = await h.api('/api', { useSession: true });
    const due = state.pendingTransactions.find(row => row.source_one_off_id === planned.id);
    assert.ok(due);
    await h.api(`/api/pending/${encodeURIComponent(due.id)}/confirm`, { method: 'POST', useSession: true,
      body: { confirmed_date: '2024-02-10' } });
    const snapshot = () => h.api('/api/app/snapshot', { useSession: true });
    const before = await snapshot();
    assert.equal(before.request.predictionRows.length, 2);
    assert.equal(before.request.openingBalance, 750);
    // Public orchestration must not regenerate projections or rotate accepted history.
    const readHead = async (seed = false) => {
      if (budgetStore) return budgetStore.transaction(async (_writer, client) => {
        if (seed) await client.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, 'retained-history-epoch', 0) ON CONFLICT (budget_id) DO NOTHING", [userId]);
        return (await client.query("SELECT epoch, revision FROM cashflow_sync_heads WHERE budget_id = $1", [userId])).rows[0];
      });
      const db = h.openPlanningDb();
      try {
        if (seed) db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, 'retained-history-epoch', 0) ON CONFLICT (budget_id) DO NOTHING").run(userId);
        return db.prepare("SELECT epoch, revision FROM cashflow_sync_heads WHERE budget_id = ?").get(userId);
      } finally { db.close(); }
    };
    const headBefore = await readHead(true);
    const result = await h.cashflow.compactLedgerHistory(userId, { months: 12 });
    assert.deepEqual(await readHead(), headBefore, "Summaries must preserve outstanding device cursors");
    const after = await snapshot();
    assert.deepEqual({ history: after.request.predictionRows, progress: after.request.oneOffProgress,
      handled: after.request.handledOccurrenceKeys, balance: after.request.openingBalance },
    { history: before.request.predictionRows, progress: before.request.oneOffProgress,
      handled: before.request.handledOccurrenceKeys, balance: before.request.openingBalance },
    'Historical summaries must retain individual facts, paid progress and occurrence identities');
    assert.equal(result.detailsRetained, true);
    assert.equal(result.retainedRows, 2);
    assert.equal(result.createdRows, 1);
    assert.equal(result.summaries[0].netAmount, 750);
    const again = await h.cashflow.compactLedgerHistory(userId, { months: 12, today: '2026-05-21' });
    assert.equal(again.needsCompaction, false);
    assert.equal(again.createdRows, 0);
    const exported = await h.api('/api/export/full', { useSession: true });
    assert.equal(Object.values(exported.ledgers).flat().length, 2);
  } finally { await h.cleanup(); }
}

test('history summarization retains old accepted payments, paid progress and correction identities', () => verifyPreservedHistory());
test('PostgreSQL history summarization preserves the same complete financial facts', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try {
    await global.initialize(); await budget.initialize();
    await verifyPreservedHistory({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true }, budget);
  } finally { await global.close(); await budget.close(); }
}));

/** Source deletion changes planning. It cannot erase attribution, timestamps,
 * occurrences or amounts from accepted payments, including earlier years. */
async function verifySourceDeletion(databaseConfig) {
  const userId = 'source-deletion-history';
  const h = await createCashflowTestHarness({ userId, initializeUser: false, databaseConfig, today: '2026-05-20' });
  try {
    await h.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId, displayName: 'Synthetic history owner', email: 'source-history@example.test' } });
    const setup = await h.api('/api/setup', { method: 'POST', useSession: true,
      body: { currency: 'PLN', opening_balance: 1000, income_enabled: false } });
    await h.api(`/api/pending/${encodeURIComponent(setup.setup.created.openingBalanceId)}/confirm`, {
      method: 'POST', useSession: true, body: { confirmed_date: '2018-01-10' } });
    const oneOff = await h.api('/api/one-off', { method: 'POST', useSession: true,
      body: { name: 'Old paid source', amount: 50, currency: 'PLN', type: 'expense', date: '2019-02-10' } });
    const dueOneOff = (await h.api('/api', { useSession: true })).pendingTransactions.find(row => row.source_one_off_id === oneOff.id);
    assert.ok(dueOneOff);
    await h.api(`/api/pending/${encodeURIComponent(dueOneOff.id)}/confirm`, { method: 'POST', useSession: true,
      body: { confirmed_date: '2019-02-10' } });
    const goal = await h.api('/api/goals', { method: 'POST', useSession: true,
      body: { name: 'Completed goal', amount: 60, currency: 'PLN', due_date: '2026-05-25', priority: 1, active: 1 } });
    let goalView = await h.api('/api', { useSession: true });
    if (!goalView.pendingTransactions.some(row => row.source_goal_id === goal.id)) {
      const scheduled = goalView.futureTransactions.find(row => row.source_goal_id === goal.id);
      assert.ok(scheduled, 'Goal should have a generated allocation');
      await h.api(`/api/future/${encodeURIComponent(scheduled.id)}/move-to-pending`, { method: 'POST', useSession: true });
      goalView = await h.api('/api', { useSession: true });
    }
    const dueGoal = goalView.pendingTransactions.find(row => row.source_goal_id === goal.id);
    assert.ok(dueGoal);
    await h.api(`/api/pending/${encodeURIComponent(dueGoal.id)}/confirm`, { method: 'POST', useSession: true,
      body: { amount: 60, confirmed_date: '2020-03-10' } });
    const before = await h.api('/api/export/full', { useSession: true });
    const engineBefore = await h.api('/api/app/snapshot', { useSession: true });
    await h.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: 'DELETE', useSession: true });
    await h.api(`/api/goals/${encodeURIComponent(goal.id)}`, { method: 'DELETE', useSession: true });
    const after = await h.api('/api/export/full', { useSession: true });
    assert.deepEqual(after.ledgers, before.ledgers, 'Deleting a source must not rewrite any accepted fact');
    const engineAfter = await h.api('/api/app/snapshot', { useSession: true });
    assert.deepEqual(engineAfter.request.predictionRows, engineBefore.request.predictionRows);
    assert.deepEqual(engineAfter.request.handledOccurrenceKeys, engineBefore.request.handledOccurrenceKeys);
    assert.equal(engineAfter.request.openingBalance, engineBefore.request.openingBalance);
    const planning = await h.api('/api', { useSession: true });
    assert.ok(!planning.oneOffs.some(row => row.id === oneOff.id));
    assert.ok(!planning.goals.some(row => row.id === goal.id));
    assert.ok(!planning.pendingTransactions.some(row => row.source_one_off_id === oneOff.id || row.source_goal_id === goal.id));
    assert.ok(!planning.futureTransactions.some(row => row.source_one_off_id === oneOff.id || row.source_goal_id === goal.id));
    await h.api('/api/import/full', { method: 'POST', useSession: true, body: { mode: 'replace', export: after } });
    const restored = await h.api('/api/export/full', { useSession: true });
    assert.deepEqual(restored.ledgers, before.ledgers, 'Historical references must survive a full backup round trip');
    assert.equal(h.errors.length, 0, 'Successful source deletion should not log an operational failure');
  } finally { await h.cleanup(); }
}

test('deleting paid one-offs and completed goals preserves every original payment fact', () => verifySourceDeletion());
test('PostgreSQL source deletion retains the same old attribution and financial facts', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try {
    await global.initialize(); await budget.initialize();
    await verifySourceDeletion({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
  } finally { await global.close(); await budget.close(); }
}));
