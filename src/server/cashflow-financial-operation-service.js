import { normalizeLedgerAuditFact } from "../engine/ledger-audit-fact.js";
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from './cashflow-app-bootstrap-records.js';
export { BOOTSTRAP_SETTINGS } from './cashflow-app-bootstrap-records.js';
import { todayInTimezone } from './cashflow-date-utils.js';
import { DEFAULT_TIMEZONE } from './cashflow-constants.js';
import { createLedgerCorrectionService } from "./cashflow-ledger-correction-service.js";
import { createFinancialJournal } from "./cashflow-financial-journal.js";
import { normalizeAppOperation, normalizeAppChangesRequest, normalizeAppResultRequest, appOperationError } from "./cashflow-app-operation-contract.js";
import { assertAppSyncBinding, negotiateAppSync, normalizeSyncBootstrapPage, normalizeSyncBootstrapStart, normalizeSyncChanges,
  normalizeSyncNegotiation, normalizeSyncResultLookup, normalizeSyncSubmission } from "./cashflow-app-sync-contract.js";
import { createHash, randomUUID } from "node:crypto";
import { appSyncCapabilities } from "./cashflow-app-sync-contract.js";

/** The server's current negotiated selection; pages echo it. */
function currentCompatibility() {
  const { protocolVersion, stateVersion, financialModelVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
  return { protocolVersion, stateVersion, financialModelVersion, engineProtocolVersion, engineVersion };
}
import { validatePlanMutationInput } from "./cashflow-plan-input-validation.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";

const AUTHORIZATION_TABLES = /\b(app_device_tokens|app_devices|accounts|auth_config|auth_sessions|app_device_instance|budgets|budget_memberships)\b/g;
const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;

/** Restrict attached authorization to known tables and SELECTs. It must never
 * mutate a second WAL database as part of a planning-only financial commit. */
export function createFinancialGrantAuthorizer({ deviceService, token, backend }) {
  if (!deviceService || typeof token !== "string" || !["postgres", "sqlite"].includes(backend)) {
    throw new Error("Financial grants require a device service, token and backend");
  }
  return async context => {
    const query = backend === "postgres" ? context.query : (sql, values = []) => {
      if (!/^SELECT\b/.test(sql)) throw new Error("Attached authorization cannot write global storage");
      return context.query(sql.replace(AUTHORIZATION_TABLES, "cashflow_authorization.$1"), values);
    };
    // Same capability the web route requires: sync never exceeds the browser.
    const kind = context.operation?.kind;
    const capability = context.action === "read" ? "budget:read"
      : ["occurrence.confirm", "ledger.correct"].includes(kind) ? "ledger:confirm" : kind === "settings.update" ? "budget:settings" : "planner:write";
    return deviceService.authorizeFinancialWrite({ query, backend }, token, context.budgetId, capability);
  };
}


function canonical(value) {
  // Hash what JSON.stringify sends: Dates (and other toJSON values) as their JSON form.
  if (value && typeof value.toJSON === "function") return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const ENTITY_TABLES = { "one-off": "one_off_transactions", "recurring-income": "recurring_incomes",
  "recurring-expense": "recurring_expenses", goal: "goals", flex: "flex_transactions" };
const ENTITY_METHODS = { "one-off": "OneOffTransaction", "recurring-income": "RecurringIncome",
  "recurring-expense": "RecurringExpense", goal: "Goal", flex: "FlexTransaction" };
const HISTORICAL_SOURCE_FIELDS = ['source_one_off_id', 'source_recurring_income_id', 'source_recurring_expense_id',
  'source_goal_id', 'source_flex_id'];

/** Present the host's transaction writer to the server's store-based mutation
 * functions: their nested transaction joins this one, and their own revision
 * record is skipped because the journal records exactly one revision per op. */
export function hostPlanningStore(writer) {
  const store = new Proxy(writer, {
    get(target, key) {
      if (key === "backend") return "postgres";
      if (key === "transaction") return work => work(store);
      // Already inside the host transaction: never open (or recurse into) another.
      if (key === "transactionBound") return true;
      if (key === "recordFinancialChange") return async () => {};
      if (key === "lockBudgetLedger") return async budgetId => (target.backend === "postgres" ? target.lockBudgetLedger(budgetId) : undefined);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return store;
}

/** Internal integration host, deliberately not registered as an HTTP endpoint.
 * Schema migrations, every web/background revision path and transactional grants
 * must be integrated before exposing this service to a device. Authorization is
 * mandatory, including reads, and must use the supplied connection until commit. */
export function createFinancialOperationService({ budgetStore, authorize, project, afterRecord = null, authorizationDbPath = null,
  planMutations = null, ledgerActions = null, fxSnapshot = null,
  allowStandaloneOrigins = budgetStore?.supportsStandaloneOrigins === true }) {
  if (!budgetStore || typeof authorize !== "function" || typeof project !== "function") {
    throw new Error("Financial operations require storage, transactional authorization and projection");
  }
  async function within(budgetId, work, binding = null) {
    const transaction = budgetStore.backend === "postgres"
      ? callback => budgetStore.transaction(callback)
      : callback => budgetStore.planningTransaction(budgetId, callback, { authorizationDbPath });
    return transaction(async (writer, connection) => {
      if (!connection) throw new Error("Financial operations require an owning connection");
      if (budgetStore.backend === "postgres") await writer.lockBudgetLedger(budgetId);
      const query = async (sql, values = []) => {
        if (budgetStore.backend === "postgres") {
          let index = 0;
          return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
        }
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...values) : (statement.run(...values), []);
      };
      const context = { budgetId, writer, connection, query, allowStandaloneOrigins };
      // Protocol requests compare their immutable instance/account/budget binding
      // with the grant obtained on this transaction, before any receipt or write.
      const granted = async request => {
        const grant = await authorize(request);
        if (binding) assertAppSyncBinding(binding, grant);
        return grant;
      };
      const journal = createFinancialJournal({ query, afterRecord,
        authorize: async operation => {
          const grant = await granted({ ...context, action: "write", operation });
          // Only the transactionally checked grant supplies the capture actor.
          context.actorId = grant?.accountId;
          return grant;
        },
        authorizeRead: request => granted({ ...context, action: "read", request }),
        mutate: async operation => {
          if (operation.kind === "ledger.correct") return applyCorrection(operation, context);
          if (operation.kind === "occurrence.confirm") return applyConfirmation(operation, context);
          if (operation.kind === "settings.update") return applySettings(operation, context);
          if (operation.kind === "one-off.dismiss-remainder") return applyRemainderDismissal(operation, context);
          if (operation.kind !== "one-off.create") return applyPlanningOperation(operation, context);
          // Identity is protocol-owned, never accepted via the web create input.
          const { id, ...input } = operation.payload;
          const values = validatePlanMutationInput("one-off", input, { create: true });
          values.currency = requireSupportedCurrency(values.currency);
          await assertNewSourceIdentity(context, id);
          const timestamp = new Date().toISOString();
          await writer.insertPlanningRows(budgetId, "one_off_transactions", [{ ...values, id,
            created_at: timestamp, updated_at: timestamp }]);
          await project(context);
        } });
      return work(journal, context);
    });
  }
  /** A paid source ID remains historical identity after its planning row is
   * deleted. Reusing it for another source would inherit unrelated old progress
   * and forecasts. Read current sources and complete history under this lock. */
  async function assertNewSourceIdentity(context, id) {
    for (const table of Object.values(ENTITY_TABLES)) {
      if ((await context.writer.listPlanningRows(context.budgetId, table)).some(row => row.id === id)) {
        throw appOperationError('SOURCE_EXISTS');
      }
    }
    const history = await context.writer.listConfirmedTransactions(context.budgetId);
    if (history.some(row => HISTORICAL_SOURCE_FIELDS.some(field => row[field] === id))) throw appOperationError('SOURCE_EXISTS');
    // Voiding removes only the effective payment. Its immutable original still
    // owns that source identity, including while all its payments are voided.
    // Decode/hash-check the scoped originals before trusting their reservation.
    const retained = await createLedgerCorrectionService(context).audit.originals();
    if (retained.some(item => HISTORICAL_SOURCE_FIELDS.some(field => item.row[field] === id))) {
      throw appOperationError('SOURCE_EXISTS');
    }

  }
  /** Planning-source intents run the server's own validated create/update/delete
   * on this transaction (via hostPlanningStore), so sync matches the web app. */
  async function applyPlanningOperation(operation, context) {
    if (typeof planMutations !== "function") throw appOperationError("UNSUPPORTED_OPERATION");
    const [entity, action] = operation.kind.split(".");
    const { id, ...fields } = operation.payload;
    const mutations = planMutations({ ...context, store: hostPlanningStore(context.writer) });
    const name = ENTITY_METHODS[entity];
    if (action === "create") {
      await assertNewSourceIdentity(context, id);
      return mutations[`create${name}`](context.budgetId, fields, { entityId: id });
    }
    if (!(await context.writer.listPlanningRows(context.budgetId, ENTITY_TABLES[entity])).some(row => row.id === id)) {
      throw appOperationError("SOURCE_NOT_FOUND");
    }
    if (action === "update") return mutations[`update${name}`](context.budgetId, id, fields);
    return entity === "recurring-income" ? mutations.deleteRecurringIncome(context.budgetId, id, fields)
      : mutations[`delete${name}`](context.budgetId, id);
  }
  /** Server confirmation semantics on this transaction: an occurrence still in
   * the future list is first moved to pending (explicit early payment), then the
   * server's confirmPendingTransaction records the ledger row. A foreign row
   * must carry its actual rate; the host never fetches one inside the commit. */
  async function applyConfirmation(operation, context) {
    if (typeof ledgerActions !== "function") throw appOperationError("UNSUPPORTED_OPERATION");
    const { occurrenceKey, amount, confirmedDate, fxRate } = operation.payload;
    const actions = ledgerActions({ ...context, store: hostPlanningStore(context.writer) });
    const pendingFor = async () => (await context.writer.listPlanningRows(context.budgetId, "pending_transactions"))
      .find(row => row.occurrence_key === occurrenceKey);
    let pending = await pendingFor();
    if (!pending) {
      const future = (await context.writer.listPlanningRows(context.budgetId, "future_transactions")).find(row => row.occurrence_key === occurrenceKey);
      if (!future) throw appOperationError("OCCURRENCE_NOT_FOUND");
      await actions.moveFutureTransactionToPending(context.budgetId, future.id, { occurrenceKey, preservePending: true });
      pending = await pendingFor();
      if (!pending) throw appOperationError("OCCURRENCE_NOT_FOUND");
    }
    const ledger = ((await context.writer.listPlanningRows(context.budgetId, "settings"))[0] || {}).ledger_currency || "PLN";
    if (pending.currency !== ledger && fxRate === null) throw appOperationError("FX_RATE_REQUIRED");
    if (pending.currency === ledger && fxRate !== null && fxRate !== 1) throw appOperationError("FX_RATE_NOT_APPLICABLE");
    const confirmed = await actions.confirmPendingTransaction(context.budgetId, pending.id, { amount, confirmed_date: confirmedDate,
      ...(fxRate === null ? {} : { fx_rate: fxRate, buffered_fx_rate: fxRate }) }, { actorId: context.actorId });
    // Return the accepted financial fact, excluding transient projection status.
    return { confirmedTransaction: normalizeLedgerAuditFact(confirmed, context.budgetId) };
  }
  /** Persist blocked intentions as durable reviewed work too. Only a newly
   * accepted correction changes money/projection; journal and receipt commit
   * with the audit on the same authorized, locked connection. */
  async function applyCorrection(operation, context) {
    const service = createLedgerCorrectionService(context);
    const createdAt = new Date().toISOString();
    await service.audit.ensureLegacyBaseline({ capturedAt: createdAt });
    await service.audit.exportSnapshot();
    const settings = (await context.writer.listPlanningRows(context.budgetId, 'settings'))[0] || {};
    const result = await service.correct({ ...operation.payload, id: operation.operationId,
      actorId: context.actorId, createdAt, today: todayInTimezone(settings.timezone || DEFAULT_TIMEZONE) });
    if (!result.replayed && result.event.status === 'accepted') await project(context);
    return result;
  }

  /** Server settings service on this transaction; only the sync whitelist reaches it. */
  async function applySettings(operation, context) {
    if (typeof ledgerActions !== "function") throw appOperationError("UNSUPPORTED_OPERATION");
    const actions = ledgerActions({ ...context, store: hostPlanningStore(context.writer) });
    if (typeof actions.updateSettings !== "function") throw appOperationError("UNSUPPORTED_OPERATION");
    const previous = (await context.writer.listPlanningRows(context.budgetId, "settings"))[0];
    await actions.updateSettings(context.budgetId, operation.payload);
    if (operation.payload.ledger_currency && operation.payload.ledger_currency !== previous?.ledger_currency) {
      const pendingConversion = (await context.writer.listPlanningRows(context.budgetId, "pending_transactions"))
        .find(row => String(row.occurrence_key || "").startsWith("ledger_currency_conversion:"));
      return { pendingConversion };
    }
    return null;
  }

  /** Server remainder dismissal (caps the one-off at accepted installments). */
  async function applyRemainderDismissal(operation, context) {
    if (typeof planMutations !== "function") throw appOperationError("UNSUPPORTED_OPERATION");
    const pending = (await context.writer.listPlanningRows(context.budgetId, "pending_transactions"))
      .find(row => row.occurrence_key === operation.payload.occurrenceKey);
    if (!pending) throw appOperationError("OCCURRENCE_NOT_FOUND");
    return planMutations({ ...context, store: hostPlanningStore(context.writer) }).dismissPendingOneOffRemainder(context.budgetId, pending.id);
  }
  /** Actual sync and transfer resource checks share one transaction-bound
   * reader, so a checked transfer cannot silently use a smaller wire model. */
  const bootstrapRecords = (context, part) => readFinancialBootstrapPart(context, part, { fxSnapshot, allowStandaloneOrigins });
  /** Stateless page token (contract: 16–256 chars of [A-Za-z0-9_-]): bootstrap ID,
   * captured epoch/revision, position and expiry, packed with a checksum over
   * instance/account/budget. Integrity only; authority is the grant re-checked
   * on every page, and a forged position only re-reads data already granted. */
  const uuidBytes = value => Buffer.from(value.replace(/-/g, ""), "hex");
  const uuidText = bytes => bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  function encodeToken(state, request) {
    const packed = Buffer.alloc(57);
    uuidBytes(state.bootstrapId).copy(packed, 0); uuidBytes(state.epoch).copy(packed, 16);
    packed.writeBigUInt64BE(BigInt(state.revision), 32); packed.writeUInt8(state.part, 40);
    packed.writeUInt32BE(state.offset, 41); packed.writeUInt32BE(state.pageIndex, 45); packed.writeBigUInt64BE(BigInt(state.expiresAtMs), 49);
    const check = createHash("sha256").update(`${request.instanceId}|${request.accountId}|${request.budgetId}|`).update(packed).digest().subarray(0, 16);
    return Buffer.concat([packed, check]).toString("base64url");
  }
  function decodeToken(token, request) {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length !== 73) throw appOperationError("INVALID_BOOTSTRAP_TOKEN");
    const packed = bytes.subarray(0, 57);
    const check = createHash("sha256").update(`${request.instanceId}|${request.accountId}|${request.budgetId}|`).update(packed).digest().subarray(0, 16);
    if (!check.equals(bytes.subarray(57))) throw appOperationError("SYNC_BINDING_MISMATCH");
    return { bootstrapId: uuidText(packed.subarray(0, 16)), epoch: uuidText(packed.subarray(16, 32)), revision: Number(packed.readBigUInt64BE(32)),
      part: packed.readUInt8(40), offset: packed.readUInt32BE(41), pageIndex: packed.readUInt32BE(45), expiresAtMs: Number(packed.readBigUInt64BE(49)) };
  }
  /** Shape errors from the contract normalizers become one safe protocol code. */
  const normalized = (normalize, input) => {
    try { return normalize(input); } catch (error) { if (error?.code) throw error; throw appOperationError("INVALID_SYNC_REQUEST"); }
  };
  const envelope = request => ({ protocolVersion: 1, instanceId: request.instanceId, accountId: request.accountId, budgetId: request.budgetId });
  return {
    /** Protocol v1 negotiation: authorized, bound, and advertising only what this host applies. */
    async negotiate(input) {
      const request = normalized(normalizeSyncNegotiation, input);
      const compatibility = negotiateAppSync(request.offer);
      await within(request.budgetId, async (_journal, context) => {
        assertAppSyncBinding(request, await authorize({ ...context, action: "read", request }));
      }, request);
      const { implementedOperationKinds, maximumPageRecords } = appSyncCapabilities();
      return { ...envelope(request), compatibility, enabled: true, supportedOperationKinds: implementedOperationKinds, maximumPageRecords };
    },
    /** Protocol v1 bootstrap manifest at one accepted epoch/revision (initializing
     * the head if needed). Pages must later observe exactly that head. */
    async bootstrap(input, { now = Date.now() } = {}) {
      const request = normalized(normalizeSyncBootstrapStart, input);
      return within(request.budgetId, async (journal, context) => {
        await authorize({ ...context, action: "read", request }).then(grant => assertAppSyncBinding(request, grant));
        const head = await journal.head(request.budgetId).catch(() => null) ?? await journal.bootstrap(request.budgetId);
        const parts = [];
        for (const kind of BOOTSTRAP_PARTS) parts.push({ kind, recordCount: (await bootstrapRecords(context, kind)).length });
        const bootstrapId = randomUUID();
        const expiresAtMs = now + BOOTSTRAP_TTL_MS;
        const state = { bootstrapId, epoch: head.epoch, revision: head.revision, part: 0, offset: 0, pageIndex: 0, expiresAtMs };
        return { ...envelope(request), bootstrapId, epoch: head.epoch, revision: head.revision, compatibility: request.compatibility,
          expiresAtMs, parts, firstPageToken: encodeToken(state, request) };
      }, request);
    },
    /** One bounded page of a bootstrap. Any head change since the manifest makes
     * the whole bootstrap stale; pages from different revisions never mix. */
    async bootstrapPage(input, { now = Date.now() } = {}) {
      const request = normalized(normalizeSyncBootstrapPage, input);
      const state = decodeToken(request.pageToken, request);
      if (state.bootstrapId !== request.bootstrapId || state.part >= BOOTSTRAP_PARTS.length) throw appOperationError("SYNC_BINDING_MISMATCH");
      if (!(now < state.expiresAtMs)) throw appOperationError("BOOTSTRAP_EXPIRED");
      return within(request.budgetId, async (journal, context) => {
        await authorize({ ...context, action: "read", request }).then(grant => assertAppSyncBinding(request, grant));
        const head = await journal.head(request.budgetId);
        if (head.epoch !== state.epoch || head.revision !== state.revision) throw appOperationError("BOOTSTRAP_STALE");
        let { part, offset } = state;
        let records = await bootstrapRecords(context, BOOTSTRAP_PARTS[part]);
        // Empty parts are skipped so every returned page carries its part identity.
        while (offset >= records.length && part < BOOTSTRAP_PARTS.length - 1) {
          part += 1; offset = 0; records = await bootstrapRecords(context, BOOTSTRAP_PARTS[part]);
        }
        const page = records.slice(offset, offset + request.limit);
        let nextPart = part, nextOffset = offset + page.length;
        const done = nextOffset >= records.length && part === BOOTSTRAP_PARTS.length - 1;
        const nextPageToken = done ? null : encodeToken({ ...state, part: nextPart, offset: nextOffset, pageIndex: state.pageIndex + 1 }, request);
        const body = { bootstrapId: state.bootstrapId, epoch: state.epoch, revision: state.revision, compatibility: currentCompatibility(),
          pageIndex: state.pageIndex, part: BOOTSTRAP_PARTS[part], records: page, nextPageToken };
        return { ...envelope(request), ...body, pageHash: digest(body) };
      }, request);
    },
    /** Protocol v1 submission: binding + selected compatibility + one operation. */
    async submit(input) {
      const request = normalized(normalizeSyncSubmission, input);
      let result;
      try {
        result = await within(request.budgetId, journal => journal.apply(request.operation), request);
      } catch (error) {
        // Stale cached FX is a recoverable refresh request, not a permanent
        // rejection of the financial intent. Preserve its 409 and pair/age.
        if (error?.details?.code === "stale_fx_rate") throw error;
        // A server validation refusal (4xx) committed nothing. Devices must tell it
        // from transient failure without seeing server messages or details.
        // Authentication/permission failures (401/403) stay distinct: they are not
        // a verdict on the operation, and its unsent work must be kept.
        const status = Number(error?.status);
        if (!error?.code && Number.isInteger(status) && status >= 400 && status < 500 && status !== 401 && status !== 403) {
          throw appOperationError("OPERATION_REJECTED");
        }
        throw error;
      }
      const { replayed, ...receipt } = result;
      return { ...envelope(request), receipt, replayed };
    },
    /** Protocol v1 outcome lookup; `not-found` never authorizes a new operation ID. */
    async results(input) {
      const request = normalized(normalizeSyncResultLookup, input);
      const found = await within(request.budgetId, journal => journal.lookup({ budgetId: request.budgetId, epoch: request.epoch,
        operationId: request.operationId }), request);
      const receipt = found ? (({ replayed, ...value }) => value)(found) : null;
      return { ...envelope(request), epoch: request.epoch, operationId: request.operationId, status: found ? "accepted" : "not-found", receipt };
    },
    /** Protocol v1 incremental download after a durable revision. */
    async syncChanges(input) {
      const request = normalized(normalizeSyncChanges, input);
      const page = await within(request.budgetId, journal => journal.changes({ budgetId: request.budgetId, epoch: request.epoch,
        afterRevision: request.afterRevision, limit: request.limit }), request);
      return { ...envelope(request), epoch: page.epoch, headRevision: page.headRevision, nextRevision: page.nextRevision,
        hasMore: page.hasMore, changes: page.changes };
    },
    /** The host must have completed explicit journal migration/bootstrap first. */
    async apply(input) {
      const operation = normalizeAppOperation(input);
      return within(operation.budgetId, journal => journal.apply(operation));
    },
    async changes(input) {
      const request = normalizeAppChangesRequest(input);
      return within(request.budgetId, journal => journal.changes(request));
    },
    /** Authorized receipt retrieval resolves lost acknowledgements without
     * applying an operation or requiring its financial payload again. */
    async lookup(input) {
      const request = normalizeAppResultRequest(input);
      return within(request.budgetId, journal => journal.lookup(request));
    }
  };
}
