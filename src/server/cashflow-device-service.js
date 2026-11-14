import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeDeviceTokenPolicy, DEVICE_TOKEN_POLICY_FIELDS } from "./cashflow-device-token-policy.js";
import { forbidden, unauthorized } from "./cashflow-user-utils.js";
import { CAPABILITIES, capabilitiesFor } from "./cashflow-authorization.js";

const READ_SCOPE = "app:snapshot:read";
const SYNC_SCOPE = "app:financial:sync";
const WRITE_CAPABILITIES = new Set([CAPABILITIES.PLANNER_WRITE, CAPABILITIES.LEDGER_CONFIRM,
  CAPABILITIES.BUDGET_RENAME, CAPABILITIES.BUDGET_SETTINGS, CAPABILITIES.BUDGET_IMPORT, CAPABILITIES.BUDGET_RESTORE, CAPABILITIES.BUDGET_MEMBERS, CAPABILITIES.BUDGET_TRANSFER]);

const hash = value => createHash("sha256").update(value).digest("hex");
const secret = prefix => `${prefix}_${randomBytes(32).toString("base64url")}`;
const humanHash = value => hash(String(value || "").toUpperCase().replace(/[ -]/g, ""));
const parse = row => {
  if (!row) return null;
  try {
    const state = JSON.parse(row.state_json || "{}");
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    // SQL identity, status and expiry columns are authoritative, not JSON state.
    return { ...state, ...row };
  } catch { return null; }
};
const unexpired = (value, now) => value !== null && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) > now;
const DAY = 86400000;

export function createDeviceService({ store, now = () => Date.now(), archiveReceiptTimeoutMs = DAY }) {
  if (!Number.isSafeInteger(archiveReceiptTimeoutMs) || archiveReceiptTimeoutMs < 60000 || archiveReceiptTimeoutMs > 7 * DAY) {
    throw new Error('Invalid device archive receipt timeout');
  }
  /** Recovery accepts only the exact access credential that committed the archive.
   * Access expiry may pass during recovery; this capability can only inspect or
   * acknowledge this one immutable receipt, never renew or authorize a budget. */
  async function archiveCredential(transactionQuery, token, backend) {
    // Browser account/session/auth-mode changes must wait for this archive or
    // lookup transaction just as they wait for a financial grant check.
    const query = (sql, values = []) => transactionQuery(
      backend === 'postgres' && /^SELECT\b/.test(sql) ? `${sql} FOR SHARE` : sql, values);
    if (typeof token !== 'string' || !/^cfda1_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'access'", [hash(token)]))[0];
    if (!row) return null;
    const device = parse((await query('SELECT * FROM app_devices WHERE id = ?', [row.device_id]))[0]);
    if (!device) return null;
    const receipt = device.archiveReceipt;
    if (receipt && !unexpired(receipt.expiresMs, now())) {
      await query('UPDATE app_devices SET revoked_ms = COALESCE(revoked_ms, ?) WHERE id = ?', [now(), device.id]);
      if (device.revoked_ms == null) await audit(query, 'device.archive_timeout_revoked', device.account_id, device.id);
      return null;
    }
    if (!await active(query, { ...device, archiveReceipt: undefined })) return null;
    if (receipt && receipt.tokenHash !== hash(token)) return null;
    return { device, row, receipt };
  }
  const publicReceipt = receipt => ({ version: 1, id: receipt.id, budgetId: receipt.budgetId,
    idempotencyKey: receipt.idempotencyKey, status: 'archived', archivedAt: receipt.archivedAt, expiresMs: receipt.expiresMs });
  const archiveKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

  async function audit(query, action, accountId, deviceId) {
    await query("INSERT INTO security_audit_log (id, actor_account_id, action, target_type, target_id, outcome, details_json, created_at) VALUES (?, ?, ?, 'device', ?, 'success', '{}', ?)",
      [`audit_${randomUUID()}`, accountId, action, deviceId, new Date(now()).toISOString()]);
  }
  async function instance(query) {
    // Authorization on an attached SQLite global database must be read-only;
    // avoid even a no-op INSERT once the enrollment identity exists.
    const existing = (await query("SELECT instance_id FROM app_device_instance WHERE id = 1"))[0];
    if (existing) return existing.instance_id;
    await query("INSERT INTO app_device_instance (id, instance_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING", [randomUUID()]);
    return (await query("SELECT instance_id FROM app_device_instance WHERE id = 1"))[0].instance_id;
  }

  async function issue(query, device, policy) {
    // Keep consumed renewal hashes for reuse detection until family expiry.
    // Expired access tokens have no replay-detection role and can be bounded.
    await query("DELETE FROM app_device_tokens WHERE device_id = ? AND kind = 'access' AND expires_ms <= ?", [device.id, now()]);
    const accessToken = secret("cfda1");
    const renewalToken = secret("cfdr1");
    const accessExpiresMs = Math.min(now() + policy.device_access_minutes * 60000, device.absoluteExpiresMs);
    const renewalExpiresMs = Math.min(now() + policy.device_renewal_idle_days * DAY, device.absoluteExpiresMs);
    for (const [token, kind, expiry] of [[accessToken, "access", accessExpiresMs], [renewalToken, "renewal", renewalExpiresMs]]) {
      await query("INSERT INTO app_device_tokens (token_hash, device_id, kind, expires_ms) VALUES (?, ?, ?, ?)",
        [hash(token), device.id, kind, expiry]);
    }
    return { deviceId: device.id, instanceId: device.instanceId, scope: device.scope ?? READ_SCOPE,
      // Sync devices bind every request to their account; it is an opaque,
      // non-secret identity the server checks against the grant anyway.
      ...(device.scope === SYNC_SCOPE ? { accountId: device.account_id, writeBudgetIds: device.writeBudgetIds,
        mayCreateBudgets: device.mayCreateBudgets === true } : {}),
      budgetIds: device.budgetIds, accessToken, renewalToken, accessExpiresMs, renewalExpiresMs,
      absoluteExpiresMs: device.absoluteExpiresMs };
  }

  async function policy(query) {
    const current = (await query("SELECT * FROM global_options WHERE id = 1"))[0];
    normalizeDeviceTokenPolicy({}, current);
    return Object.fromEntries(Object.entries(DEVICE_TOKEN_POLICY_FIELDS).map(([key, rule]) => [key, Number(current?.[key] ?? rule.default)]));
  }

  async function active(query, device) {
    if (!device || device.archiveReceipt != null || device.revoked_ms != null || !unexpired(device.absoluteExpiresMs, now())
      || !Number.isSafeInteger(device.createdMs) || device.createdMs > now()
      || device.absoluteExpiresMs <= device.createdMs
      || typeof device.id !== "string" || !device.id.startsWith("device_")
      || typeof device.account_id !== "string" || !device.account_id
      || typeof device.approvalSessionId !== "string" || !device.approvalSessionId
      || !Array.isArray(device.budgetIds) || !device.budgetIds.length || device.budgetIds.length > 100
      || device.budgetIds.some(id => typeof id !== "string" || !id)
      || new Set(device.budgetIds).size !== device.budgetIds.length
      || ![undefined, READ_SCOPE, SYNC_SCOPE].includes(device.scope)
      || (device.writeBudgetIds !== undefined && !Array.isArray(device.writeBudgetIds))
      || (device.scope === SYNC_SCOPE && (!Array.isArray(device.writeBudgetIds) || !device.writeBudgetIds.length
        || new Set(device.writeBudgetIds).size !== device.writeBudgetIds.length
        || device.writeBudgetIds.some(id => !device.budgetIds.includes(id))))
      || (device.scope !== SYNC_SCOPE && device.writeBudgetIds?.length)
      // Budget creation is a separate, browser-approved permission of sync devices.
      || ![undefined, false, true].includes(device.mayCreateBudgets)
      || (device.mayCreateBudgets === true && device.scope !== SYNC_SCOPE)) return false;
    const account = (await query("SELECT status FROM accounts WHERE id = ?", [device.account_id]))[0];
    const config = (await query("SELECT active_mode FROM auth_config WHERE id = 1"))[0];
    const session = (await query("SELECT revoked_at FROM auth_sessions WHERE id = ?", [device.approvalSessionId]))[0];
    return account?.status === "active" && ["internal", "external"].includes(config?.active_mode) && session && !session.revoked_at
      && device.instanceId === await instance(query);
  }

  async function grantsActive(query, device) {
    const rows = await query("SELECT b.id FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE m.account_id = ? AND b.status = 'active'", [device.account_id]);
    const available = new Set(rows.map(row => row.id));
    return device.budgetIds.every(id => available.has(id));
  }

  /** Shared owning-transaction device check. Cancellation is a negative
   * capability: a still-active financial device can withdraw its own pending
   * job after creation permission is removed, without gaining any budget access. */
  async function authorizeTransferDevice({ query: transactionQuery, backend }, token, requireCreation, requireCapacity) {
    if (typeof transactionQuery !== "function" || !["sqlite", "postgres"].includes(backend)
      || typeof requireCapacity !== "boolean" || typeof token !== "string" || !/^cfda1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    if (backend === "postgres") await transactionQuery("SELECT pg_advisory_xact_lock(73190231)");
    const query = (sql, values = []) => transactionQuery(
      backend === "postgres" && /^SELECT\b/.test(sql) ? `${sql} FOR SHARE` : sql, values);
    // Authorization never invents an enrollment identity after metadata
    // restore. Check before active(), whose pairing path may initialize it.
    const instanceId = (await query("SELECT instance_id FROM app_device_instance WHERE id = 1"))[0]?.instance_id;
    if (!instanceId) throw unauthorized();
    const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'access'", [hash(token)]))[0];
    if (!row || !unexpired(row.expires_ms, now())) throw unauthorized();
    const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
    if (!await active(query, device) || device.scope !== SYNC_SCOPE || (requireCreation && device.mayCreateBudgets !== true)) throw unauthorized();
    if (requireCapacity && device.budgetIds.length >= 100) throw forbidden("Device budget limit reached");
    return { instanceId, accountId: device.account_id, deviceId: device.id };
  }

  return {
    /** Keep authorization and the metadata mutation on one owning connection. */
    async mutateBudget(token, budgetId, capability, work) {
      return store.transaction(async tx => {
        const grant = await this.authorizeFinancialWrite({ ...tx, requireWrite: true }, token, budgetId, capability);
        return work(tx, grant);
      });
    },
    /** Atomic metadata archive + durable restricted receipt. Existing browser
     * archival keeps its own revocation policy; a device archive changes only
     * its initiating device, and never clears any existing revocation. */
    async archiveBudget(token, budgetId, idempotencyKey) {
      if (!archiveKey(idempotencyKey) || typeof budgetId !== 'string') throw forbidden('Archive idempotency key required');
      const result = await store.transaction(async ({ query, backend }) => {
        const credential = await archiveCredential(query, token, backend);
        if (!credential) return null;
        const { device, row, receipt } = credential;
        if (receipt) {
          if (receipt.budgetId !== budgetId || receipt.idempotencyKey !== idempotencyKey) return null;
          return { budget: { id: budgetId, status: 'archived' }, receipt: publicReceipt(receipt) };
        }
        if (!unexpired(row.expires_ms, now()) || device.scope !== SYNC_SCOPE || !device.writeBudgetIds.includes(budgetId)) return null;
        const lock = backend === 'postgres' ? ' FOR UPDATE OF b, m' : '';
        const budget = (await query("SELECT b.id FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE b.id = ? AND m.account_id = ? AND m.role = 'owner' AND b.status = 'active'" + lock,
          [budgetId, device.account_id]))[0];
        if (!budget) throw forbidden('Current budget owner permission required');
        const archivedAt = new Date(now()).toISOString();
        const saved = { id: `archive_${randomUUID()}`, budgetId, idempotencyKey, archivedAt,
          expiresMs: Math.min(now() + archiveReceiptTimeoutMs, device.absoluteExpiresMs), tokenHash: hash(token) };
        await query("UPDATE budgets SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?", [archivedAt, archivedAt, budgetId]);
        const updated = { ...device, archiveReceipt: saved };
        delete updated.state_json; delete updated.revoked_ms;
        const serialized = JSON.stringify(updated);
        await query('UPDATE app_devices SET state_json = ? WHERE id = ? AND revoked_ms IS NULL', [serialized, device.id]);
        // A success response requires both sides to have persisted; ignored
        // writes must roll back archival rather than leave unrestricted access.
        const stored = (await query('SELECT state_json, revoked_ms FROM app_devices WHERE id = ?', [device.id]))[0];
        const archived = (await query('SELECT status FROM budgets WHERE id = ?', [budgetId]))[0];
        if (stored?.state_json !== serialized || stored.revoked_ms != null || archived?.status !== 'archived') {
          throw new Error('Archive receipt was not recorded atomically');
        }
        await audit(query, 'device.archive_receipt_pending', device.account_id, device.id);
        await query("INSERT INTO security_audit_log (id, actor_account_id, action, target_type, target_id, outcome, details_json, created_at) VALUES (?, ?, 'budget_archive', 'budget', ?, 'success', '{}', ?)",
          [`audit_${randomUUID()}`, device.account_id, budgetId, archivedAt]);
        return { budget: { id: budgetId, status: 'archived' }, receipt: publicReceipt(saved) };
      }, { durableWrites: true });
      if (!result) throw unauthorized();
      return result;
    },

    /** No ordinary authorization, membership lookup, financial rows or other
     * budgets are reachable here. Timeout revocation commits before the 401. */
    async archiveReceipt(token, budgetId, idempotencyKey, acknowledge = false) {
      if (!archiveKey(idempotencyKey) || typeof budgetId !== 'string' || typeof acknowledge !== 'boolean') throw unauthorized();
      const result = await store.transaction(async ({ query, backend }) => {
        const credential = await archiveCredential(query, token, backend);
        if (!credential) return null;
        const { device, receipt, row } = credential;
        if (!receipt) {
          // A live device may discover that an archive was never committed.
          if (!unexpired(row.expires_ms, now()) || !device.budgetIds.includes(budgetId)) return null;
          return { state: 'not-found' };
        }
        if (receipt.budgetId !== budgetId || receipt.idempotencyKey !== idempotencyKey) return null;
        if (acknowledge) {
          await query('UPDATE app_devices SET revoked_ms = COALESCE(revoked_ms, ?) WHERE id = ?', [now(), device.id]);
          if ((await query('SELECT revoked_ms FROM app_devices WHERE id = ?', [device.id]))[0]?.revoked_ms == null) {
            throw new Error('Archive acknowledgement revocation was not recorded');
          }
          await audit(query, 'device.archive_acknowledged_revoked', device.account_id, device.id);
        }
        return { state: 'archived', receipt: publicReceipt(receipt), ...(acknowledge ? { revoked: true } : {}) };
      }, { durableWrites: true });
      if (!result) throw unauthorized();
      return result;
    },

    async inspectPairing(verificationCode) {
      return store.transaction(async ({ query }) => {
        const pairing = parse((await query("SELECT * FROM app_device_pairings WHERE human_hash = ?", [humanHash(verificationCode)]))[0]);
        if (!pairing || pairing.status !== "pending" || !unexpired(pairing.expires_ms, now())) throw forbidden("Invalid or expired pairing");
        return { label: pairing.label, scope: pairing.requestedScope ?? READ_SCOPE, expiresMs: Number(pairing.expires_ms) };
      });
    },
    async createPairing(label, requestedScope = READ_SCOPE) {
      if (![READ_SCOPE, SYNC_SCOPE].includes(requestedScope)) throw forbidden("Unsupported device scope");
      if (typeof label !== "string" || !label.trim() || label.length > 80 || /[\x00-\x1f]/.test(label)) throw forbidden("Invalid device label");
      return store.transaction(async ({ query }) => {
        await query("DELETE FROM app_device_pairings WHERE expires_ms <= ?", [now()]);
        const count = Number((await query("SELECT count(*) AS n FROM app_device_pairings"))[0].n);
        if (count >= 100) throw forbidden("Too many pending pairings");
        const deviceCode = secret("cfdp1");
        const verificationCode = randomBytes(5).toString("hex").toUpperCase();
        const expiresMs = now() + 600000;
        await query("INSERT INTO app_device_pairings (code_hash, human_hash, state_json, expires_ms, status) VALUES (?, ?, ?, ?, 'pending')",
          [hash(deviceCode), humanHash(verificationCode), JSON.stringify({ label: label.trim(), requestedScope }), expiresMs]);
        return { deviceCode, verificationCode, expiresMs, pollIntervalSeconds: 5 };
      });
    },

    async approve({ verificationCode, accountId, sessionId, budgetIds, writeBudgetIds = [], mayCreateBudgets = false }) {
      if (typeof mayCreateBudgets !== "boolean") throw forbidden("Invalid budget creation permission");
      if (mayCreateBudgets && !writeBudgetIds?.length) throw forbidden("Budget creation requires financial synchronization");
      if (!Array.isArray(budgetIds) || !budgetIds.length || budgetIds.length > 100 || budgetIds.some(id => typeof id !== "string")) throw forbidden("Select authorized budgets");
      if (!Array.isArray(writeBudgetIds) || writeBudgetIds.length > 100
        || writeBudgetIds.some(id => typeof id !== "string" || !budgetIds.includes(id))
        || new Set(writeBudgetIds).size !== writeBudgetIds.length) throw forbidden("Select explicit write budgets");
      return store.transaction(async ({ query }) => {
        const session = (await query("SELECT * FROM auth_sessions WHERE id = ? AND account_id = ?", [sessionId, accountId]))[0];
        const age = now() - Date.parse(session?.created_at);
        const idleExpiry = Date.parse(session?.idle_expires_at);
        const absoluteExpiry = Date.parse(session?.absolute_expires_at);
        if (!session || session.revoked_at || !["internal", "external"].includes(session.auth_method) || !Number.isFinite(age) || age < 0 || age > 300000
          || !Number.isFinite(idleExpiry) || !Number.isFinite(absoluteExpiry)
          || idleExpiry <= now() || absoluteExpiry <= now()) throw forbidden("Recent verified sign-in required");
        const pairing = parse((await query("SELECT * FROM app_device_pairings WHERE human_hash = ?", [humanHash(verificationCode)]))[0]);
        if (!pairing || pairing.status !== "pending" || !unexpired(pairing.expires_ms, now())) throw forbidden("Invalid or expired pairing");
        if (writeBudgetIds.length && pairing.requestedScope !== SYNC_SCOPE) throw forbidden("Device did not request financial synchronization");
        for (const id of new Set(budgetIds)) {
          const rows = await query("SELECT b.id, m.role FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE b.id = ? AND m.account_id = ? AND b.status = 'active'", [id, accountId]);
          if (!rows.length) throw forbidden("Budget access denied");
          if (writeBudgetIds.includes(id) && !capabilitiesFor({ budgetRole: rows[0].role }).includes(CAPABILITIES.PLANNER_WRITE)) {
            throw forbidden("Budget write permission required");
          }
        }
        const account = (await query("SELECT status FROM accounts WHERE id = ?", [accountId]))[0];
        const config = (await query("SELECT active_mode FROM auth_config WHERE id = 1"))[0];
        if (account?.status !== "active" || !["internal", "external"].includes(config?.active_mode)) throw forbidden("Verified authentication required");
        const enrolled = Number((await query("SELECT count(*) AS n FROM app_devices WHERE account_id = ? AND revoked_ms IS NULL", [accountId]))[0].n);
        if (enrolled >= 20) throw forbidden("Device limit reached; revoke an unused device");
        await query("UPDATE app_device_pairings SET status = 'approved', state_json = ? WHERE code_hash = ?",
          [JSON.stringify({ label: pairing.label, accountId, approvalSessionId: sessionId, budgetIds: [...new Set(budgetIds)],
            scope: writeBudgetIds.length ? SYNC_SCOPE : READ_SCOPE, writeBudgetIds, mayCreateBudgets }), pairing.code_hash]);
        return { approved: true, label: pairing.label };
      });
    },

    async poll(deviceCode) {
      if (typeof deviceCode !== "string" || !/^cfdp1_[A-Za-z0-9_-]{43}$/.test(deviceCode)) return { status: "expired" };
      return store.transaction(async ({ query }) => {
        const pairing = parse((await query("SELECT * FROM app_device_pairings WHERE code_hash = ?", [hash(deviceCode)]))[0]);
        if (!pairing || !unexpired(pairing.expires_ms, now()) || pairing.status === "consumed") return { status: "expired" };
        if (now() - Number(pairing.last_poll_ms) < 5000) return { status: "slow_down" };
        await query("UPDATE app_device_pairings SET last_poll_ms = ? WHERE code_hash = ?", [now(), pairing.code_hash]);
        if (pairing.status !== "approved") return { status: pairing.status };
        const options = await policy(query);
        const device = { id: `device_${randomUUID()}`, account_id: pairing.accountId, label: pairing.label,
          budgetIds: pairing.budgetIds, approvalSessionId: pairing.approvalSessionId,
          scope: pairing.scope ?? READ_SCOPE, writeBudgetIds: pairing.writeBudgetIds ?? [],
          mayCreateBudgets: pairing.mayCreateBudgets === true,
          createdMs: now(), absoluteExpiresMs: now() + options.device_absolute_days * DAY,
          instanceId: await instance(query) };
        if (!await active(query, device) || !await grantsActive(query, device)) {
          await query("UPDATE app_device_pairings SET status = 'denied' WHERE code_hash = ?", [pairing.code_hash]);
          return { status: "denied" };
        }
        const deviceCount = Number((await query("SELECT count(*) AS n FROM app_devices WHERE account_id = ? AND revoked_ms IS NULL", [device.account_id]))[0].n);
        if (deviceCount >= 20) {
          await query("UPDATE app_device_pairings SET status = 'denied' WHERE code_hash = ?", [pairing.code_hash]);
          return { status: "denied" };
        }
        await query("INSERT INTO app_devices (id, account_id, state_json) VALUES (?, ?, ?)", [device.id, device.account_id, JSON.stringify(device)]);
        await audit(query, "device.enrolled", device.account_id, device.id);
        await query("UPDATE app_device_pairings SET status = 'consumed' WHERE code_hash = ?", [pairing.code_hash]);
        return { status: "approved", ...await issue(query, device, options) };
      });
    },

    async renew(token) {
      if (typeof token !== "string" || !/^cfdr1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
      const result = await store.transaction(async ({ query }) => {
        const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'renewal'", [hash(token)]))[0];
        if (!row) return null;
        const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
        if (row.consumed_ms != null) {
          // Commit reuse revocation before returning the generic failure.
          await query("UPDATE app_devices SET revoked_ms = ? WHERE id = ?", [now(), row.device_id]);
          if (device) await audit(query, "device.renewal_reuse_revoked", device.account_id, device.id);
          return null;
        }
        if (!unexpired(row.expires_ms, now()) || !await active(query, device)) return null;
        if (!await grantsActive(query, device)) {
          await query("UPDATE app_devices SET revoked_ms = ? WHERE id = ?", [now(), device.id]);
          await audit(query, "device.membership_lost_revoked", device.account_id, device.id);
          return null;
        }
        await query("UPDATE app_device_tokens SET consumed_ms = ? WHERE token_hash = ?", [now(), hash(token)]);
        await audit(query, "device.renewed", device.account_id, device.id);
        return issue(query, device, await policy(query));
      });
      if (!result) throw unauthorized();
      return result;
    },

    /** Human-readable labels for current sync grants, bound to this instance
     * and account. Never enumerate ungranted or no-longer-accessible budgets. */
    async listBudgetNames(token) {
      if (typeof token !== "string" || !/^cfda1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
      const result = await store.transaction(async ({ query }) => {
        const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'access'", [hash(token)]))[0];
        if (!row || !unexpired(row.expires_ms, now())) return null;
        const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
        if (!await active(query, device) || device.scope !== SYNC_SCOPE) return null;
        const placeholders = device.budgetIds.map(() => "?").join(",");
        const budgets = await query(`SELECT b.id, b.display_name AS name, b.revision FROM budgets b
          JOIN budget_memberships m ON b.id = m.budget_id
          WHERE m.account_id = ? AND b.status = 'active' AND b.id IN (${placeholders}) ORDER BY b.id`,
        [device.account_id, ...device.budgetIds]);
        return { instanceId: device.instanceId, accountId: device.account_id, budgets };
      });
      if (!result) throw unauthorized();
      return result;
    },

    async authorize(token, budgetId) {
      if (typeof token !== "string" || !/^cfda1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
      const result = await store.transaction(async ({ query }) => {
        const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'access'", [hash(token)]))[0];
        if (!row || !unexpired(row.expires_ms, now())) return null;
        const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
        if (!await active(query, device) || !device.budgetIds.includes(budgetId)) return null;
        const membership = await query("SELECT b.id FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE b.id = ? AND m.account_id = ? AND b.status = 'active'", [budgetId, device.account_id]);
        if (!membership.length) {
          // A previously granted budget disappearing must not silently resurrect
          // access after rejoining/unarchiving. Re-pair explicitly instead.
          await query("UPDATE app_devices SET revoked_ms = ? WHERE id = ?", [now(), device.id]);
          await audit(query, "device.membership_lost_revoked", device.account_id, device.id);
        }
        return membership.length ? { accountId: device.account_id, deviceId: device.id, budgetId } : null;
      });
      if (!result) throw unauthorized();
      return result;
    },

    /** A paired phone acting in a granted budget with the account's own role:
     * reading needs the budget grant, changing it the per-budget write
     * grant of a sync device. Missing write permission is 403, matching the transactional
     * financial checker; invalid credentials or ungranted budgets remain 401.
     * Role checks stay with each route, as for a browser session. */
    async authorizeBudgetAccess(token, budgetId, write) {
      const grant = await this.authorize(token, budgetId);
      if (!write) return grant;
      const device = await store.transaction(async ({ query }) => parse((await query("SELECT * FROM app_devices WHERE id = ?", [grant.deviceId]))[0]));
      if (device?.scope !== SYNC_SCOPE || !device.writeBudgetIds.includes(budgetId)) throw forbidden("Write access to this budget is not granted");
      return grant;
    },

    /** Caller must hold the financial transaction and its authorization locks until commit.
     * Never use this as a preflight check followed by an independently committed write. */
    async authorizeFinancialWrite({ query: transactionQuery, backend, requireWrite = false }, token, budgetId, capability) {
      const reading = capability === CAPABILITIES.BUDGET_READ && !requireWrite;
      if ((capability !== CAPABILITIES.BUDGET_READ && !WRITE_CAPABILITIES.has(capability)) || typeof token !== "string" || !/^cfda1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
      // Device rotation/revocation shares this advisory lock. Row SHARE locks
      // also fence browser membership/account/session/auth-mode changes until
      // the financial host commits. SQLite hosts hold the attached global write
      // lock; callers must never pass an unrelated preflight connection.
      if (backend === "postgres") await transactionQuery("SELECT pg_advisory_xact_lock(73190231)");
      const query = (sql, values = []) => transactionQuery(
        backend === "postgres" && /^SELECT\b/.test(sql) ? `${sql} FOR SHARE` : sql, values);
      const row = (await query("SELECT * FROM app_device_tokens WHERE token_hash = ? AND kind = 'access'", [hash(token)]))[0];
      if (!row || !unexpired(row.expires_ms, now())) throw unauthorized();
      const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
      // Downloads need the browser-approved budget grant; writes the per-budget write grant.
      if (!await active(query, device) || device.scope !== SYNC_SCOPE || !device.budgetIds.includes(budgetId)) throw unauthorized();
      // A valid device that may read this budget but whose write grant was withdrawn
      // is refused as forbidden (403), not unauthenticated, so the phone holds its
      // work for review instead of retrying as if its token had expired.
      if (!reading && !device.writeBudgetIds.includes(budgetId)) throw forbidden("Write access to this budget is not granted");
      const membership = (await query("SELECT m.role FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE b.id = ? AND m.account_id = ? AND b.status = 'active'", [budgetId, device.account_id]))[0];
      if (!membership || !capabilitiesFor({ budgetRole: membership.role }).includes(capability)) throw forbidden("Current budget permission required");
      // Server identity for the protocol binding; SELECT only, as the SQLite
      // authorization attachment is read-only inside the financial commit.
      const instanceId = (await query("SELECT instance_id FROM app_device_instance WHERE id = 1"))[0]?.instance_id;
      if (!instanceId) throw unauthorized();
      return { accountId: device.account_id, deviceId: device.id, budgetId, capability, instanceId };
    },

    /** Step one of device budget creation: a live sync device with the browser-approved
     * permission. Re-checked in grantCreatedBudget after the budget exists. */
    async authorizeBudgetCreation(token) {
      const result = await store.transaction(tx => this.authorizeBudgetCreationInTransaction(tx, token, { requireCapacity: true }));
      return { accountId: result.accountId, deviceId: result.deviceId };
    },

    /** Internal transfer hosts must retain this owning transaction through
     * reservation/publication/lookup. No nested store transaction or cached grant
     * may authorize a later commit. PostgreSQL fences revocation/rotation with
     * the shared device lock and browser account/session/mode changes with row
     * locks; SQLite callers own the global BEGIN IMMEDIATE transaction.
     *
     * Existing outcomes remain readable at the 100-budget limit. A host must
     * separately request requireCapacity before allocating/granting a new
     * budget, after determining this is not an accepted replay. This does not
     * create a reservation, budget, membership or grant. */
    async authorizeBudgetCreationInTransaction(tx, token, { requireCapacity = false } = {}) {
      return authorizeTransferDevice(tx, token, true, requireCapacity);
    },

    /** Recovery/cancellation can inspect this device's immutable outcomes or
     * withdraw its pending job after creation permission is removed. They grant
     * no budget access; revoked/expired devices and foreign scopes are refused. */
    async authorizeTransferRecoveryInTransaction(tx, token) {
      return authorizeTransferDevice(tx, token, false, false);
    },

    /** Ordinary creation owns a global transaction; transfer publication uses
     * the same grant writer on its existing metadata/financial connection. */
    async grantCreatedBudget(token, budgetId) {
      return store.transaction(tx => this.grantCreatedBudgetInTransaction(tx, token, budgetId));
    },

    /** Only a trusted creation host may supply this owning transaction and the
     * freshly created budget. No HTTP request may choose an arbitrary target.
     * Permission, ownership, capacity, grant and audit remain on this connection;
     * any later publication failure must roll back this grant as well. */
    async grantCreatedBudgetInTransaction(tx, token, budgetId) {
      const binding = await this.authorizeBudgetCreationInTransaction(tx, token);
      if (typeof budgetId !== "string") throw unauthorized();
      const { query, backend } = tx;
      const ownerSql = "SELECT b.id FROM budgets b JOIN budget_memberships m ON b.id = m.budget_id WHERE b.id = ? AND m.account_id = ? AND m.role = 'owner' AND b.status = 'active'";
      const owner = await query(backend === "postgres" ? `${ownerSql} FOR SHARE` : ownerSql,
        [budgetId, binding.accountId]);
      if (!owner.length) throw unauthorized();
      const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [binding.deviceId]))[0]);
      // Capacity is checked after authorization: immutable outcome lookup and
      // replays of an existing grant remain possible when all slots are filled.
      if (!device.budgetIds.includes(budgetId) && device.budgetIds.length >= 100) throw forbidden("Device budget limit reached");
      const updated = { ...device, budgetIds: [...new Set([...device.budgetIds, budgetId])],
        writeBudgetIds: [...new Set([...device.writeBudgetIds, budgetId])] };
      delete updated.revoked_ms; delete updated.state_json;
      const serialized = JSON.stringify(updated);
      await query("UPDATE app_devices SET state_json = ? WHERE id = ?", [serialized, device.id]);
      // A trigger/rule may ignore an otherwise successful SQL call. A receipt
      // must never claim publication when the destination is not really granted.
      const persisted = (await query("SELECT state_json FROM app_devices WHERE id = ?", [device.id]))[0];
      if (persisted?.state_json !== serialized) throw new Error("Created budget device grant was not recorded");
      await audit(query, "device.budget_created", device.account_id, device.id);
      return { budgetId, budgetIds: updated.budgetIds, writeBudgetIds: updated.writeBudgetIds };
    },

    async revokeWithRenewal(token) {
      if (typeof token !== "string" || !/^cfdr1_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
      // Possession can only destroy this token's own grant, never enumerate it.
      // Accept expired/consumed renewal hashes so ambiguous renewal recovery
      // still offers a safe, idempotent disconnect operation.
      const result = await store.transaction(async ({ query }) => {
        const row = (await query("SELECT device_id FROM app_device_tokens WHERE token_hash = ? AND kind = 'renewal'", [hash(token)]))[0];
        if (row) {
          const device = parse((await query("SELECT * FROM app_devices WHERE id = ?", [row.device_id]))[0]);
          if (device?.archiveReceipt) return null;
          if (device && device.revoked_ms == null) {
            await query("UPDATE app_devices SET revoked_ms = ? WHERE id = ?", [now(), device.id]);
            await audit(query, "device.self_revoked", device.account_id, device.id);
          }
        }
        return { revoked: true };
      });
      if (!result) throw unauthorized();
      return result;
    },

    async list(accountId) {
      return store.transaction(async ({ query }) => (await query("SELECT * FROM app_devices WHERE account_id = ?", [accountId])).map(parse).filter(Boolean).map(device => {
        return { id: device.id, label: device.label, budgetIds: device.budgetIds, scope: device.scope ?? READ_SCOPE,
          writeBudgetIds: device.writeBudgetIds ?? [], mayCreateBudgets: device.mayCreateBudgets === true,
          createdMs: device.createdMs, absoluteExpiresMs: device.absoluteExpiresMs, revoked: device.revoked_ms != null || (device.archiveReceipt != null && !unexpired(device.archiveReceipt.expiresMs, now())) };
      }));
    },

    async revoke(accountId, deviceId) {
      return store.transaction(async ({ query }) => {
        const owned = (await query("SELECT id FROM app_devices WHERE account_id = ? AND id = ?", [accountId, deviceId]))[0];
        await query("UPDATE app_devices SET revoked_ms = ? WHERE account_id = ? AND id = ?", [now(), accountId, deviceId]);
        if (owned) await audit(query, "device.revoked", accountId, deviceId);
        return { revoked: true };
      });
    }
  };
}
