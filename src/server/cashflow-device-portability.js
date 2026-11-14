import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CAPABILITIES } from './cashflow-authorization.js';

const AUTH_TABLES = /\b(app_device_tokens|app_devices|accounts|auth_config|auth_sessions|app_device_instance|budgets|budget_memberships)\b/g;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const refused = code => Object.assign(new Error(code), { status: 409, code, details: [{ code }] });

/** Preview and application share the financial writer's lock and transactional
 * grant checks. Backups commit first; a second CAS prevents using a backup of
 * different state. Tokens are stateless, process-local MACs; restart/rebalancing
 * safely requires another preview. No file contents are retained or logged. */
export function createDevicePortability({ budgetStore, deviceService, authorizationDbPath,
  makePortability, createBackup, project, recalculate, logServerEvent = () => {} }) {
  const key = randomBytes(32);
  const mac = value => createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex');
  async function within(token, budgetId, work, capability = CAPABILITIES.BUDGET_IMPORT) {
    const run = callback => budgetStore.backend === 'postgres' ? budgetStore.transaction(callback)
      : budgetStore.planningTransaction(budgetId, callback, { authorizationDbPath });
    return run(async (writer, connection) => {
      if (budgetStore.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
      const query = async (sql, values = []) => {
        if (budgetStore.backend === 'postgres') {
          let index = 0;
          return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
        }
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...values) : (statement.run(...values), []);
      };
      const authQuery = budgetStore.backend === 'postgres' ? query : (sql, values) => query(sql.replace(AUTH_TABLES, 'cashflow_authorization.$1'), values);
      const grant = await deviceService.authorizeFinancialWrite({ query: authQuery, backend: budgetStore.backend }, token, budgetId, capability);
      // All nested store transactions join the owning commit, including SQLite.
      const store = new Proxy(writer, { get(target, prop) {
        if (prop === 'transaction') return callback => callback(store, connection);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return work({ store, query, grant });
    });
  }
  async function checked(context, budgetId, body, kind) {
    const head = (await context.query('SELECT epoch, revision FROM cashflow_sync_heads WHERE budget_id = ?', [budgetId]))[0];
    if (!head || typeof body.expectedEpoch !== 'string' || !Number.isSafeInteger(body.expectedRevision)
      || body.expectedRevision < 0) throw refused('IMPORT_SYNC_STATE_REQUIRED');
    if (head.epoch !== body.expectedEpoch) throw refused('IMPORT_EPOCH_CONFLICT');
    if (Number(head.revision) !== body.expectedRevision) throw refused('IMPORT_REVISION_CONFLICT');
    const mode = body.mode || (kind === 'full' ? 'replace' : 'append');
    if (!(kind === 'full' ? ['replace', 'merge'] : ['replace', 'append']).includes(mode)) {
      throw Object.assign(new Error('Invalid import mode'), { status: 400 });
    }
    const input = kind === 'full' ? body.export : body.csv;
    const fileHash = hash({ kind, mode, input });
    let sequence = 0;
    const portability = makePortability(context.store, prefix => `${prefix}_${hash({ budgetId, epoch: head.epoch, revision: Number(head.revision), fileHash, sequence: sequence++ }).slice(0, 32)}`);
    const current = await portability.exportFullDataAsync(budgetId);
    // Backup discovery changes neither financial state nor the preview binding.
    delete current.planning.backup_metadata;
    const stateHash = hash({ planning: current.planning, ledgers: current.ledgers, ledgerAudit: current.ledgerAudit });
    const binding = { budgetId, deviceId: context.grant.deviceId, epoch: head.epoch, revision: Number(head.revision), fileHash, stateHash };
    return { portability, mode, input, previewToken: mac(binding), head: { epoch: head.epoch, revision: Number(head.revision) } };
  }
  return {
    // Restore and operational settings share this owning grant/write boundary.
    within: (token, budgetId, work, capability) => within(token, budgetId, context => work(context.store), capability),
    /** Only successful validation produces a confirmation token. CSV errors use
     * the existing structured row/field/reason validation response. */
    preview: (token, budgetId, body, kind) => within(token, budgetId, async context => {
      const plan = await checked(context, budgetId, body, kind);
      const result = kind === 'full'
        ? await plan.portability.previewFullImportAsync(budgetId, plan.input, plan.mode, { includeOperationalSettings: false })
        : await plan.portability.prepareOneOffCsvImportPlanAsync(budgetId, plan.input, plan.mode);
      return { ...result, validationErrors: [], previewToken: plan.previewToken, ...plan.head };
    }),
    apply: async (token, budgetId, body, kind) => {
      // Validate before allocating a durable recovery artifact, then repeat under
      // the owning financial transaction before touching any source rows.
      const verify = async context => {
        const plan = await checked(context, budgetId, body, kind);
        if (typeof body.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewToken)
          || !timingSafeEqual(Buffer.from(body.previewToken, 'hex'), Buffer.from(plan.previewToken, 'hex'))) throw refused('IMPORT_PREVIEW_MISMATCH');
        return plan;
      };
      const initial = await within(token, budgetId, verify);
      const backupPath = initial.mode === 'replace' ? await createBackup(budgetId) : null;
      const result = await within(token, budgetId, async context => {
        const plan = await verify(context);
        const backups = await context.store.listPlanningRows(budgetId, 'backup_metadata');
        const safetyBackupId = backupPath ? backups.find(row => row.backup_path === backupPath && row.success)?.id : null;
        if (backupPath && !safetyBackupId) throw new Error('Safety backup metadata is unavailable');
        let applied;
        if (kind === 'full') {
          const prepared = await plan.portability.prepareFullImportPlanAsync(budgetId, plan.input, plan.mode, { includeOperationalSettings: false });
          applied = await plan.portability.applyPreparedFullImportPlanAsync(prepared);
          await recalculate(budgetId, context.store);
        } else {
          const prepared = await plan.portability.prepareOneOffCsvImportPlanAsync(budgetId, plan.input, plan.mode);
          applied = await plan.portability.applyPreparedOneOffCsvImportPlanAsync(budgetId, prepared);
        }
        const projection = await project(budgetId, context.store);
        if (projection?.projection_ok === false) throw new Error('Projection regeneration failed after import');
        const head = (await context.query('SELECT epoch, revision FROM cashflow_sync_heads WHERE budget_id = ?', [budgetId]))[0];
        return { ok: true, mode: plan.mode, safetyBackupId, apply: applied,
          epoch: head.epoch, revision: Number(head.revision), rebootstrapRequired: true };
      });
      logServerEvent('cashflow_device_import_completed', { budgetId, kind, mode: result.mode, safetyBackupId: result.safetyBackupId });
      return result;
    },
    /** Resolve the existing restore service's private artifact reference to a
     * budget-scoped public ID without putting its path on the wire. */
    async backupIdForPath(budgetId, backupPath) {
      return (await budgetStore.listPlanningRows(budgetId, 'backup_metadata'))
        .find(row => row.success && row.backup_path === backupPath)?.id || null;
    },
    /** Expose recovery identifiers only, never filesystem paths or error text. */
    async listBackups(budgetId) {
      return (await budgetStore.listPlanningRows(budgetId, 'backup_metadata')).filter(row => row.success)
        .map(row => ({ id: row.id, createdAt: row.backup_timestamp, sizeBytes: Number(row.size_bytes) }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }
  };
}
