import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../../src/engine/index.js";
import { LINKED_PARTS, prepareLinkedSnapshot } from "../../src/engine/linked-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";

import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';

/** Mirror native host hashing; downloaded evidence cannot supply receipts. */
function prepareVerifiedLinkedSnapshot(command) {
  const { texts } = prepareLinkedLedgerAuditHashes(command);
  const auditHashes = texts.map(text => [text, createHash('sha256').update(text).digest('hex')]);
  return prepareLinkedSnapshot({ ...command, auditHashes });
}

const offer = { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1],
  engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] };
const today = "2026-05-20";
const GENERATED = new Set(["id", "created_at", "updated_at", "generation_timestamp", "snapshot_timestamp", "calculation_id"]);

/** Plan rows without identifiers and timestamps that each calculation generates afresh. */
function comparable(plan) {
  const strip = value => Array.isArray(value) ? value.map(strip)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(key => !GENERATED.has(key)).map(key => [key, strip(value[key])]))
      : value;
  return { futureRows: strip(plan.futureRows), projectionSnapshotRows: strip(plan.projectionSnapshotRows).map(row => {
    // Embedded JSON summaries carry the calculation timestamp too.
    const parsed = Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (typeof value !== "string" || !value.startsWith("{") && !value.startsWith("[")) return [key, value];
      try { return [key, strip(JSON.parse(value))]; } catch { return [key, value]; }
    }));
    return parsed;
  }) };
}

async function linkedParity(databaseConfig) {
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig, today });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "parity-owner", displayName: "Owner", email: "parity@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true, body: { newPassword: "parity owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "parity@example.test", password: "parity owner correct horse" } });
    const pairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Parity phone", scope: "app:financial:sync" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: pairing.verificationCode, budgetIds: ["parity-owner"], writeBudgetIds: ["parity-owner"] } });
    const tokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
    const binding = { protocolVersion: 1, instanceId: tokens.instanceId, accountId: tokens.accountId, budgetId: "parity-owner" };
    const post = async (path, body) => {
      const { response, body: json } = await harness.request(`/api/app/sync/v1/${path}`, { method: "POST", skipUserHeader: true,
        headers: { authorization: `Bearer ${tokens.accessToken}` }, body });
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(json)}`);
      return json;
    };
    const { compatibility } = await post("negotiate", { ...binding, offer });
    const bootstrap = async () => {
      const manifest = await post("bootstrap", { ...binding, compatibility });
      const parts = Object.fromEntries(LINKED_PARTS.map(kind => [kind, []]));
      for (let token = manifest.firstPageToken; token;) {
        const page = await post("bootstrap/page", { ...binding, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 100 });
        parts[page.part].push(...page.records);
        token = page.nextPageToken;
      }
      return { epoch: manifest.epoch, revision: manifest.revision, parts };
    };
    let state = await bootstrap();
    const submit = async (kind, payload) => {
      const operation = { version: 1, operationId: randomUUID(), budgetId: binding.budgetId, epoch: state.epoch,
        baseRevision: state.revision, kind, payload };
      const { receipt } = await post("operations", { ...binding, compatibility, operation });
      state = { ...state, revision: receipt.revision };
      return operation;
    };
    // Accepted baseline: an income, a necessary bill, and a one-off already due.
    const salary = randomUUID(), rent = randomUUID(), desk = randomUUID();
    await submit("recurring-income.create", { id: salary, name: "Salary", currency: "PLN", amount: 5000, anchor_type: "day_of_month", anchor_day_of_month: 10 });
    await submit("recurring-expense.create", { id: rent, name: "Rent", currency: "PLN", amount: 1500, necessary: true, anchor_type: "day_of_month", anchor_day_of_month: 12 });
    await submit("one-off.create", { id: desk, name: "Desk", currency: "PLN", amount: 300, type: "income", date: "2026-05-18" });
    state = await bootstrap();
    const pendingDesk = state.parts.planning.find(record => record.table === "pending_transactions" && record.row.source_one_off_id === desk);
    assert.ok(pendingDesk, "the due one-off is pending on the server");

    // Queued device intents, previewed provisionally on the accepted replica.
    const goal = randomUUID(), flex = randomUUID();
    const queued = [
      ["goal.create", { id: goal, name: "Holiday", currency: "PLN", amount: 2400, due_date: "2026-12-01" }],
      ["flex.create", { id: flex, name: "Leisure", currency: "PLN", amount: 400, allow_split: true, min_amount: 50, max_amount: null }],
      ["recurring-expense.update", { id: rent, amount: 1600 }],
      ["settings.update", { future_periods: 6 }],
      ["occurrence.confirm", { occurrenceKey: pendingDesk.row.occurrence_key, amount: 300, confirmedDate: "2026-05-19", fxRate: null }]
    ].map(([kind, payload]) => ({ operationId: randomUUID(), kind, payload }));
    const base = state;
    const provisional = prepareVerifiedLinkedSnapshot({ budgetId: binding.budgetId, epoch: base.epoch, revision: base.revision, parts: base.parts,
      pending: queued, today, generationTimestamp: "2026-05-20T08:00:00.000Z", idSeed: "parity-provisional" });
    assert.deepEqual(provisional.linked.unapplied, []);
    assert.deepEqual(provisional.linked.provisionalOperationIds, queued.map(op => op.operationId));

    // The server decides the same intents; its next verified state is authoritative.
    for (const { kind, payload } of queued) await submit(kind, payload);
    const accepted = await bootstrap();
    const authoritative = prepareVerifiedLinkedSnapshot({ budgetId: binding.budgetId, epoch: accepted.epoch, revision: accepted.revision,
      parts: accepted.parts, today, generationTimestamp: "2026-05-20T08:00:00.000Z", idSeed: "parity-accepted" });
    assert.equal(provisional.request.openingBalance, authoritative.request.openingBalance);
    assert.deepEqual(comparable(calculateSnapshot(provisional).plan), comparable(calculateSnapshot(authoritative).plan));
  } finally { await harness.cleanup(); }
}

test("a provisional linked view matches the server's accepted state on SQLite", () => linkedParity());

test("a provisional linked view matches the server's accepted state on PostgreSQL", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); } finally { await global.close(); await budget.close(); }
  await linkedParity({ backend: "postgres", supported: true, external: true, databaseUrlConfigured: true });
}));
