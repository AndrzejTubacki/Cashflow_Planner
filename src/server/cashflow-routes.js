import { sendApiError } from "./cashflow-error-utils.js";
import {
  CAPABILITIES,
  requireCapability as assertCapability
} from "./cashflow-authorization.js";
import {
  SESSION_COOKIE_NAME,
  sessionTokenFromRequest
} from "./cashflow-session-service.js";
import {
  BUDGET_RUNTIME_LOCK_JOBS,
  budgetRuntimeLockName
} from "./cashflow-runtime-locks.js";
import { conflict, forbidden, unauthorized } from "./cashflow-user-utils.js";

export function registerCashflowRoutes(app, {
  acceptInvitation = null,
  acceptInvitationAsync = null,
  activateAdminAuthDraft = null,
  activateAdminAuthDraftAsync = null,
  authenticateExternalLogin = null,
  authenticateInternalLogin = null,
  appVersion = "0.0.0",
  archiveBudget = null,
  archiveBudgetAsync = null,
  collectCurrenciesForFxSnapshot,
  collectCurrenciesForFxSnapshotAsync = null,
  compactLedgerHistory = null,
  confirmPendingTransaction,
  completeSetup = null,
  createNoneSession = null,
  createBackup,
  createBackupAsync = null,
  createBudget = null,
  createBudgetAsync = null,
  completeAuthProviderCallback = null,
  completeInternalPasswordSetup = null,
  createInvitation = null,
  createInvitationAsync = null,
  createAdminPasswordResetToken = null,
  createExternalAccountSession = null,
  createInternalAccountSession = null,
  createInternalSession = null,
  createNoneAccountSession = null,
  createFlexTransaction,
  createGoal,
  createOneOffTransaction,
  createRecurringExpense,
  createRecurringIncome,
  clearPendingTransactions = null,
  createUser = null,
  createUserAsync = null,
  deleteAdminAccount = null,
  deleteAdminAccountAsync = null,
  deleteAdminAuthProvider = null,
  deleteAdminAuthProviderAsync = null,
  deleteFlexTransaction,
  deleteGoal,
  deleteOneOffTransaction,
  deleteRecurringExpense,
  deleteRecurringIncome,
  dismissPendingOneOffRemainder,
  ensureFxCacheForMutation,
  exportConfirmedLedgerCsv,
  exportConfirmedLedgerCsvAsync = null,
  exportFullData,
  exportFullDataAsync = null,
  exportSampleData,
  fetchNbpFxSnapshot,
  fetchNbpRate,
  getAdminAuthConfig = null,
  getAdminAuthConfigAsync = null,
  getCachedFxSnapshot,
  getCachedFxSnapshotAsync = null,
  getGlobalOptions = null,
  getGlobalOptionsAsync = null,
  getProviderPairRate,
  getSettingsAsync = null,
  getSnapshot,
  getSnapshotAsync = null,
  countPendingTransactions = null,
  listAvailableLocales = () => [{ id: "en", label: "English" }],
  listAdminAccounts = null,
  listAdminAccountsAsync = null,
  listAuthProviders = null,
  listAuthProvidersAsync = null,
  listAccounts = null,
  listAccountsAsync = null,
  listBudgetsForAccount = null,
  listBudgetsForAccountAsync = null,
  listConfirmedTransactionsPage = null,
  listConfirmedTransactionsPageAsync = null,
  listInvitations = null,
  listInvitationsAsync = null,
  listMembers = null,
  listMembersAsync = null,
  listUsers = null,
  listUsersAsync = null,
  lockService = null,
  logCashflowError,
  logError,
  moveFutureTransactionToPending,
  openPlanningDb,
  recordProjectionFailure,
  recordProjectionFailureAsync = null,
  refreshNbpFxCacheForAllUsers,
  regenerateProjectionsWithFxRefresh,
  removeMember = null,
  removeMemberAsync = null,
  registerInternalAccountWithInvitation = null,
  renameBudget = null,
  renameBudgetAsync = null,
  resolveRequestActor = null,
  resolveRequestContext = null,
  resolveBudgetContext = null,
  resolveBudgetContextAsync = null,
  resolveRequestUser,
  resolveSession = null,
  resolveSessionAsync = null,
  revokeAdminAccountSession = null,
  revokeAdminAccountSessionAsync = null,
  revokeSession = null,
  rotateCsrfToken = null,
  selectUser = null,
  selectUserAsync = null,
  restoreBackup,
  restoreBackupAsync = null,
  restoreBudgetMetadata = null,
  restoreBudgetMetadataAsync = null,
  revokeInvitation = null,
  revokeInvitationAsync = null,
  purgeBudget = null,
  purgeBudgetAsync = null,
  leaveBudget = null,
  leaveBudgetAsync = null,
  selectBudget = null,
  transferOwnership = null,
  transferOwnershipAsync = null,
  testAdminAuthDraft = null,
  testAdminAuthDraftAsync = null,
  setAdminProviderIdentity = null,
  setAdminProviderIdentityAsync = null,
  setAdminExternalIdentity = null,
  setAdminExternalIdentityAsync = null,
  setAccountSystemAdmin = null,
  setAccountSystemAdminAsync = null,
  updateMemberRole = null,
  updateMemberRoleAsync = null,
  importFullData,
  importFullDataAsync = null,
  importOneOffCsv,
  importOneOffCsvAsync = null,
  importSampleData,
  importSampleDataAsync = null,
  previewFullImport,
  previewFullImportAsync = null,
  safeGetCurrentFxSnapshot,
  safeGetCurrentFxSnapshotAsync = null,
  setupRequired = null,
  setupRequiredAsync = null,
  updateFlexTransaction,
  updateGoal,
  updateOneOffTransaction,
  updatePendingTransaction,
  updateRecurringExpense,
  updateRecurringIncome,
  updateAdminAccount = null,
  updateAdminAccountAsync = null,
  updateAdminAuthDraft = null,
  updateAdminAuthDraftAsync = null,
  upsertAdminAuthProvider = null,
  upsertAdminAuthProviderAsync = null,
  startAuthProviderLink = null,
  startAuthProviderLogin = null,
  updateSettings,
  updateGlobalOptions = null,
  updateGlobalOptionsAsync = null,
  validatePlanMutationInput,
  translateLocale = async (_locale, key, params = {}) => String(key || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => params?.[name] ?? ""),
  validateCashflowData,
  validateCsrfToken = null,
  withProjectionStatus
}) {
    const csrfExemptRoutes = new Set([
      "POST /api/accounts",
      "POST /api/auth/external/login",
      "POST /api/auth/internal/login",
      "POST /api/auth/internal/password",
      "POST /api/auth/internal/register",
      "POST /api/session/select-account",
      "POST /api/session/select",
      "POST /api/users"
    ]);
    const csrfExemptRoutePrefixes = [
      /^POST \/api\/auth\/providers\/[^/]+\/login\/start$/
    ];

    function setSessionCookie(req, res, token) {
      const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
      res.setHeader("Set-Cookie", [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=604800",
        ...(secure ? ["Secure"] : [])
      ].join("; "));
    }

    function clearSessionCookie(req, res) {
      const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
      res.setHeader("Set-Cookie", [
        `${SESSION_COOKIE_NAME}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
        ...(secure ? ["Secure"] : [])
      ].join("; "));
    }

    function absoluteRequestUrl(req) {
      const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim() || "http";
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      return `${proto}://${host}${req.originalUrl || req.url || "/"}`;
    }

    async function resolveRequestLocale(req) {
      try {
        const hasBudgetHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-budget-id")
          || Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-user-id");
        if (!hasBudgetHeader && !sessionTokenFromRequest(req)) return "en";
        const context = req.cashflowContext && typeof req.cashflowContext.then !== "function"
          ? req.cashflowContext
          : null;
        const userId = context?.budget?.id
          || String(req.headers["x-cashflow-budget-id"] || req.headers["x-cashflow-user-id"] || "").trim();
        if (!userId) return "en";
        return (await getSettingsAsync(userId))?.locale || "en";
      } catch {
        return "en";
      }
    }

    async function snapshotForUser(userId) {
      return typeof getSnapshotAsync === "function"
        ? await getSnapshotAsync(userId)
        : getSnapshot(userId);
    }

    async function fail(req, res, error, fallback, logKind = null) {
      await sendApiError({
        req,
        res,
        error,
        fallback,
        logKind,
        logError,
        resolveLocale: resolveRequestLocale,
        translateLocale
      });
    }

    async function recordRouteProjectionFailure(userId, error) {
      if (!userId) return;

      try {
        const currentSnapshot = (
          typeof safeGetCurrentFxSnapshotAsync === "function"
            ? await safeGetCurrentFxSnapshotAsync(userId)
            : safeGetCurrentFxSnapshot(userId)
        );
        const fxSnapshot = currentSnapshot || (
          typeof getCachedFxSnapshotAsync === "function"
            ? await getCachedFxSnapshotAsync(userId)
            : getCachedFxSnapshot(userId)
        );
        await recordProjectionFailureAsync(userId, error, fxSnapshot);
      } catch (recordError) {
        logCashflowError("cashflow_projection_failure_record_failed", recordError, {
          userId
        });
      }
    }

    async function requestUserId(req) {
      return await resolveRequestUser(req);
    }

    function requestUserHeader(req) {
      return String(req.headers["x-cashflow-user-id"] || "").trim();
    }

    function hasBudgetSelector(req) {
      return Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-budget-id")
        || Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-user-id");
    }

    async function contextForRequest(req) {
      if ((await activeAuthMode()) !== "none" && !sessionTokenFromRequest(req)) {
        throw unauthorized();
      }
      return typeof resolveRequestContext === "function"
        ? await resolveRequestContext(req)
        : null;
    }

    async function actorForRequest(req) {
      const actor = typeof resolveRequestActor === "function"
        ? await resolveRequestActor(req)
        : null;
      if (actor) return actor;
      return (await activeAuthMode()) === "none" ? await contextForRequest(req) : null;
    }

    async function requireActor(req) {
      const actor = await actorForRequest(req);
      if (!actor?.account?.id || !actor.authSession) throw unauthorized();
      return actor;
    }

    async function sessionForRequest(req) {
      const context = await actorForRequest(req);
      if (context?.session) return context.session;
      if ((await activeAuthMode()) !== "none") throw unauthorized();
      const userId = requestUserHeader(req);
      return await resolveSessionForRoute(userId);
    }

    function canAdmin(session) {
      return Array.isArray(session?.permissions) && session.permissions.includes("admin");
    }

    async function adminAuthConfig() {
      if (typeof getAdminAuthConfigAsync === "function") return await getAdminAuthConfigAsync();
      return typeof getAdminAuthConfig === "function" ? getAdminAuthConfig() : null;
    }

    async function globalOptions() {
      if (typeof getGlobalOptionsAsync === "function") return await getGlobalOptionsAsync();
      return typeof getGlobalOptions === "function" ? getGlobalOptions() : {};
    }

    async function authProviders(options = {}) {
      if (typeof listAuthProvidersAsync === "function") return await listAuthProvidersAsync(options);
      return typeof listAuthProviders === "function" ? listAuthProviders(options) : [];
    }

    async function resolveSessionForRoute(userId = "") {
      if (typeof resolveSessionAsync === "function") return await resolveSessionAsync(userId);
      return typeof resolveSession === "function"
        ? resolveSession(userId)
        : {
            authenticated: Boolean(userId),
            userId,
            displayName: userId,
            permissions: userId ? ["admin"] : []
          };
    }

    async function resolveBudgetContextForRoute(budgetId, options = {}) {
      if (typeof resolveBudgetContextAsync === "function") return await resolveBudgetContextAsync(budgetId, options);
      if (typeof resolveBudgetContext === "function") return resolveBudgetContext(budgetId, options);
      throw new Error("Budget context service is unavailable");
    }

    async function adminPayload(session) {
      if (!canAdmin(session)) return null;
      return {
        accounts: await callGlobal(listAdminAccountsAsync, listAdminAccounts, [], "Admin account service is unavailable"),
        authConfig: await adminAuthConfig(),
        options: await globalOptions(),
        providers: await authProviders()
      };
    }

    async function callGlobal(asyncFn, syncFn, args = [], message = "Service is unavailable") {
      if (typeof asyncFn === "function") return await asyncFn(...args);
      if (typeof syncFn === "function") return syncFn(...args);
      throw new Error(message);
    }

    async function requireAdmin(req) {
      const context = await actorForRequest(req);
      if (context) {
        assertCapability(context, CAPABILITIES.SYSTEM_ADMIN, "Admin permission required");
        return context.session;
      }

      const session = await sessionForRequest(req);
      if (!canAdmin(session)) {
        throw forbidden("Admin permission required");
      }
      return session;
    }

    function adminActorId(session = null) {
      return session?.accountId || session?.userId || null;
    }

    async function requireBudgetCapability(req, capability, message = "Budget permission required") {
      const context = await contextForRequest(req);
      if (!context) return await sessionForRequest(req);
      assertCapability(context, capability, message);
      return context;
    }

    async function withBudgetRouteLock(userId, jobName, work, {
      message = "Operation is already running",
      ttlMs = 120000
    } = {}) {
      if (!lockService || typeof lockService.withLock !== "function") {
        return await work();
      }

      const lockResult = await lockService.withLock(
        budgetRuntimeLockName(userId, jobName),
        work,
        { ttlMs }
      );
      if (!lockResult?.acquired) {
        throw conflict(message, [{
          field: "operation",
          reason: "locked",
          lock: budgetRuntimeLockName(userId, jobName)
        }]);
      }
      return lockResult.result;
    }

    async function activeAuthMode() {
      return (await adminAuthConfig())?.activeMode || "none";
    }

    app.use("/api", (req, res, next) => {
      if (
        Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-user-id")
        && !Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-budget-id")
      ) {
        res.setHeader("Deprecation", "true");
        res.setHeader("X-Cashflow-Deprecated", "x-cashflow-user-id");
      }
      next();
    });

    app.use("/api", async (req, res, next) => {
      const method = String(req.method || "GET").toUpperCase();
      const routeKey = `${method} ${String(req.originalUrl || req.url || "").split("?")[0]}`;
      const token = sessionTokenFromRequest(req);
      if (
        ["GET", "HEAD", "OPTIONS"].includes(method)
        || csrfExemptRoutes.has(routeKey)
        || csrfExemptRoutePrefixes.some(pattern => pattern.test(routeKey))
        || !token
      ) {
        next();
        return;
      }

      try {
        const csrfToken = String(req.headers["x-cashflow-csrf-token"] || "");
        if (typeof validateCsrfToken !== "function" || !(await validateCsrfToken(token, csrfToken))) {
          throw forbidden("Invalid CSRF token");
        }
        next();
      } catch (error) {
        await fail(req, res, error, "Request verification failed", "cashflow_csrf_failed");
      }
    });

    app.get("/api/users", async (req, res) => {
      try {
        if ((await activeAuthMode()) !== "none") await requireActor(req);
        res.json({
          users: await callGlobal(listUsersAsync, listUsers, [], "User service is unavailable")
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list users", "cashflow_users_list_failed");
      }
    });

    app.post("/api/users", async (req, res) => {
      try {
        if ((await activeAuthMode()) !== "none") throw forbidden("Account creation is invite-only in this authentication mode");
        const created = await callGlobal(createUserAsync, createUser, [req.body || {}], "User service is unavailable");
        const issued = typeof createNoneSession === "function"
          ? await createNoneSession(created.budgetId || created.userId)
          : null;
        if (issued?.token) setSessionCookie(req, res, issued.token);
        res.json({
          session: issued?.context?.session || created,
          ...(issued?.csrfToken ? { csrfToken: issued.csrfToken } : {})
        });
      } catch (error) {
        await fail(req, res, error, "Failed to create user", "cashflow_user_create_failed");
      }
    });

    app.get("/api/accounts", async (req, res) => {
      try {
        if ((await activeAuthMode()) !== "none") await requireActor(req);
        res.json({
          accounts: await callGlobal(listAccountsAsync, listAccounts, [], "Account service is unavailable")
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list accounts", "cashflow_accounts_list_failed");
      }
    });

    app.post("/api/accounts", async (req, res) => {
      try {
        if ((await activeAuthMode()) !== "none") throw forbidden("Account creation is invite-only in this authentication mode");
        const created = await callGlobal(createUserAsync, createUser, [req.body || {}], "Account service is unavailable");
        const issued = typeof createNoneAccountSession === "function"
          ? await createNoneAccountSession(created.accountId)
          : null;
        if (issued?.token) setSessionCookie(req, res, issued.token);
        res.json({
          session: issued?.context?.session || created,
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [created.accountId],
            "Budget service is unavailable"
          ),
          ...(issued?.csrfToken ? { csrfToken: issued.csrfToken } : {})
        });
      } catch (error) {
        await fail(req, res, error, "Failed to create account", "cashflow_account_create_failed");
      }
    });

    app.get("/api/auth/config", async (req, res) => {
      try {
        const config = await adminAuthConfig();
        const providers = await authProviders({ publicOnly: true });
        res.json({
          auth: config
            ? {
                activeMode: config.activeMode,
                external: {
                  enabled: config.activeMode === "external"
                },
                internal: {
                  allowPasswordLogin: config.activeConfig?.internal?.allowPasswordLogin !== false,
                  providers
                }
              }
            : {
                activeMode: "none",
                internal: {
                  allowPasswordLogin: true,
                  providers: []
                }
              }
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load authentication configuration", "cashflow_auth_config_failed");
      }
    });

    app.post("/api/auth/providers/:providerId/login/start", async (req, res) => {
      try {
        if (typeof startAuthProviderLogin !== "function") throw new Error("Authentication provider service is unavailable");
        res.json(await startAuthProviderLogin(req.params.providerId));
      } catch (error) {
        await fail(req, res, error, "Failed to start provider login", "cashflow_provider_login_start_failed");
      }
    });

    app.post("/api/auth/providers/:providerId/link/start", async (req, res) => {
      try {
        const actor = await requireActor(req);
        if (typeof startAuthProviderLink !== "function") throw new Error("Authentication provider service is unavailable");
        res.json(await startAuthProviderLink(actor.account.id, req.params.providerId));
      } catch (error) {
        await fail(req, res, error, "Failed to start provider linking", "cashflow_provider_link_start_failed");
      }
    });

    app.get("/api/auth/providers/:providerId/callback", async (req, res) => {
      try {
        if (typeof completeAuthProviderCallback !== "function") throw new Error("Authentication provider service is unavailable");
        if (typeof createInternalAccountSession !== "function") throw new Error("Session service is unavailable");
        const completed = await completeAuthProviderCallback(req.params.providerId, absoluteRequestUrl(req));
        const issued = await createInternalAccountSession(completed.accountId);
        setSessionCookie(req, res, issued.token);
        res.redirect("/?cashflow_auth=provider");
      } catch (error) {
        await fail(req, res, error, "Failed to complete provider login", "cashflow_provider_callback_failed");
      }
    });

    app.post("/api/auth/internal/password", async (req, res) => {
      try {
        if (typeof completeInternalPasswordSetup !== "function") throw new Error("Internal authentication service is unavailable");
        res.json(await completeInternalPasswordSetup(req.body || {}));
      } catch (error) {
        await fail(req, res, error, "Failed to set internal login password", "cashflow_internal_password_failed");
      }
    });

    app.post("/api/auth/external/login", async (req, res) => {
      try {
        if (typeof authenticateExternalLogin !== "function") throw new Error("External authentication service is unavailable");
        if (typeof createExternalAccountSession !== "function") throw new Error("Session service is unavailable");
        const authenticated = await authenticateExternalLogin(req.headers || {});
        const issued = await createExternalAccountSession(authenticated.accountId);
        setSessionCookie(req, res, issued.token);
        res.json({
          session: issued.context.session,
          csrfToken: issued.csrfToken,
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [issued.context.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to log in with external authentication", "cashflow_external_login_failed");
      }
    });

    app.post("/api/auth/internal/login", async (req, res) => {
      try {
        if (typeof authenticateInternalLogin !== "function") throw new Error("Internal authentication service is unavailable");
        if (typeof createInternalAccountSession !== "function") throw new Error("Session service is unavailable");
        const authenticated = await authenticateInternalLogin(req.body || {});
        const issued = await createInternalAccountSession(authenticated.accountId);
        setSessionCookie(req, res, issued.token);
        res.json({
          session: issued.context.session,
          csrfToken: issued.csrfToken,
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [issued.context.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to log in", "cashflow_internal_login_failed");
      }
    });

    app.post("/api/auth/internal/register", async (req, res) => {
      try {
        if (typeof registerInternalAccountWithInvitation !== "function") throw new Error("Internal authentication service is unavailable");
        if (typeof createInternalSession !== "function") throw new Error("Session service is unavailable");
        const registered = await registerInternalAccountWithInvitation(req.body || {});
        const issued = await createInternalSession(registered.budgetId, {
          accountId: registered.account.id
        });
        setSessionCookie(req, res, issued.token);
        res.json({
          account: registered.account,
          invitation: {
            budgetId: registered.budgetId,
            membership: registered.membership
          },
          session: issued.context.session,
          csrfToken: issued.csrfToken,
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [issued.context.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to register account", "cashflow_internal_register_failed");
      }
    });

    app.get("/api/accounts/:accountId/budgets", async (req, res) => {
      try {
        const actor = await requireActor(req);
        if (actor.account.id !== req.params.accountId) {
          throw forbidden("Account access denied");
        }
        res.json({
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [req.params.accountId],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list budgets", "cashflow_budgets_list_failed");
      }
    });

    app.get("/api/session", async (req, res) => {
      try {
        const token = sessionTokenFromRequest(req);
        const session = hasBudgetSelector(req) || token
          ? await sessionForRequest(req)
          : await resolveSessionForRoute("");
        const csrfToken = token && typeof rotateCsrfToken === "function"
          ? await rotateCsrfToken(token)
          : "";
        res.json({
          session,
          ...(csrfToken ? { csrfToken } : {}),
          admin: await adminPayload(session)
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load session", "cashflow_session_failed");
      }
    });

    app.post("/api/session/select", async (req, res) => {
      try {
        if ((await activeAuthMode()) !== "none") throw forbidden("None-mode account selection is disabled");
        const requestedBudgetId = req.body?.budgetId || req.body?.userId || req.body?.id || "";
        const requestedAccountId = req.body?.accountId || null;
        let selected = null;
        if (!requestedAccountId) {
          selected = await callGlobal(selectUserAsync, selectUser, [requestedBudgetId], "User service is unavailable");
        }
        const issued = typeof createNoneSession === "function"
          ? await createNoneSession(selected?.budgetId || selected?.userId || requestedBudgetId, {
              accountId: requestedAccountId
            })
          : null;
        if (issued?.token) setSessionCookie(req, res, issued.token);
        const session = issued?.context?.session || selected;
        res.json({
          session,
          ...(issued?.csrfToken ? { csrfToken: issued.csrfToken } : {}),
          admin: await adminPayload(session)
        });
      } catch (error) {
        await fail(req, res, error, "Failed to select user", "cashflow_session_select_failed");
      }
    });

    app.post("/api/session/select-account", async (req, res) => {
      try {
        if (typeof createNoneAccountSession !== "function") throw new Error("Session service is unavailable");
        const issued = await createNoneAccountSession(req.body?.accountId || req.body?.id || "");
        setSessionCookie(req, res, issued.token);
        res.json({
          session: issued.context.session,
          csrfToken: issued.csrfToken,
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [issued.context.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to select account", "cashflow_account_select_failed");
      }
    });

    app.post("/api/logout", async (req, res) => {
      const token = sessionTokenFromRequest(req);
      if (token && typeof revokeSession === "function") {
        await revokeSession(token);
      }
      clearSessionCookie(req, res);
      res.json({
        ok: true,
        session: {
          authenticated: false,
          userId: "",
          displayName: "",
          permissions: []
        }
      });
    });

    app.get("/api/budgets", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budgets: await callGlobal(
            listBudgetsForAccountAsync,
            listBudgetsForAccount,
            [actor.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list budgets", "cashflow_budgets_list_failed");
      }
    });

    app.post("/api/budgets", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budget: await callGlobal(
            createBudgetAsync,
            createBudget,
            [actor.account.id, req.body || {}],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to create budget", "cashflow_budget_create_failed");
      }
    });

    app.post("/api/budgets/:budgetId/select", async (req, res) => {
      try {
        await requireActor(req);
        if (typeof selectBudget !== "function") throw new Error("Session service is unavailable");
        const context = await selectBudget(sessionTokenFromRequest(req), req.params.budgetId);
        res.json({ session: context.session });
      } catch (error) {
        await fail(req, res, error, "Failed to select budget", "cashflow_budget_select_failed");
      }
    });

    app.put("/api/budgets/:budgetId", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budget: await callGlobal(
            renameBudgetAsync,
            renameBudget,
            [actor.account.id, req.params.budgetId, req.body || {}],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to rename budget", "cashflow_budget_rename_failed");
      }
    });

    app.post("/api/budgets/:budgetId/archive", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budget: await callGlobal(
            archiveBudgetAsync,
            archiveBudget,
            [actor.account.id, req.params.budgetId],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to archive budget", "cashflow_budget_archive_failed");
      }
    });

    app.get("/api/budgets/:budgetId/export", async (req, res) => {
      try {
        const actor = await requireActor(req);
        const context = await resolveBudgetContextForRoute(req.params.budgetId, {
          accountId: actor.account.id
        });
        assertCapability(context, CAPABILITIES.BUDGET_EXPORT, "Budget permission required");
        const includeOperationalSettings = req.query.includeOperationalSettings === "1"
          || req.query.includeOperationalSettings === "true";
        const exported = typeof exportFullDataAsync === "function"
          ? await exportFullDataAsync(context.budget.id, appVersion, { includeOperationalSettings })
          : exportFullData(context.budget.id, appVersion, { includeOperationalSettings });
        const fileName = `cashflow-${context.budget.id}-full-export.json`;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        await fail(req, res, error, "Failed to export budget", "cashflow_budget_export_failed");
      }
    });

    app.post("/api/budgets/:budgetId/restore", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budget: await callGlobal(
            restoreBudgetMetadataAsync,
            restoreBudgetMetadata,
            [actor.account.id, req.params.budgetId],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to restore budget", "cashflow_budget_restore_failed");
      }
    });

    app.delete("/api/budgets/:budgetId", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          budget: await callGlobal(
            purgeBudgetAsync,
            purgeBudget,
            [actor.account.id, req.params.budgetId],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to purge budget", "cashflow_budget_purge_failed");
      }
    });

    app.get("/api/budgets/:budgetId/members", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          members: await callGlobal(
            listMembersAsync,
            listMembers,
            [req.params.budgetId, actor.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list budget members", "cashflow_budget_members_failed");
      }
    });

    app.put("/api/budgets/:budgetId/members/:accountId", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          membership: await callGlobal(
            updateMemberRoleAsync,
            updateMemberRole,
            [
              actor.account.id,
              req.params.budgetId,
              req.params.accountId,
              req.body || {}
            ],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to update budget member", "cashflow_budget_member_update_failed");
      }
    });

    app.delete("/api/budgets/:budgetId/members/:accountId", async (req, res) => {
      try {
        const actor = await requireActor(req);
        await callGlobal(
          removeMemberAsync,
          removeMember,
          [actor.account.id, req.params.budgetId, req.params.accountId],
          "Budget service is unavailable"
        );
        res.json({ ok: true });
      } catch (error) {
        await fail(req, res, error, "Failed to remove budget member", "cashflow_budget_member_remove_failed");
      }
    });

    app.post("/api/budgets/:budgetId/leave", async (req, res) => {
      try {
        const actor = await requireActor(req);
        await callGlobal(
          leaveBudgetAsync,
          leaveBudget,
          [actor.account.id, req.params.budgetId],
          "Budget service is unavailable"
        );
        res.json({ ok: true });
      } catch (error) {
        await fail(req, res, error, "Failed to leave budget", "cashflow_budget_leave_failed");
      }
    });

    app.post("/api/budgets/:budgetId/transfer-ownership", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          membership: await callGlobal(
            transferOwnershipAsync,
            transferOwnership,
            [
              actor.account.id,
              req.params.budgetId,
              req.body?.accountId || ""
            ],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to transfer budget ownership", "cashflow_budget_transfer_failed");
      }
    });

    app.get("/api/budgets/:budgetId/invitations", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          invitations: await callGlobal(
            listInvitationsAsync,
            listInvitations,
            [req.params.budgetId, actor.account.id],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list invitations", "cashflow_budget_invitations_failed");
      }
    });

    app.post("/api/budgets/:budgetId/invitations", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          invitation: await callGlobal(
            createInvitationAsync,
            createInvitation,
            [actor.account.id, req.params.budgetId, req.body || {}],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to create invitation", "cashflow_budget_invitation_create_failed");
      }
    });

    app.delete("/api/budgets/:budgetId/invitations/:invitationId", async (req, res) => {
      try {
        const actor = await requireActor(req);
        await callGlobal(
          revokeInvitationAsync,
          revokeInvitation,
          [actor.account.id, req.params.budgetId, req.params.invitationId],
          "Budget service is unavailable"
        );
        res.json({ ok: true });
      } catch (error) {
        await fail(req, res, error, "Failed to revoke invitation", "cashflow_budget_invitation_revoke_failed");
      }
    });

    app.post("/api/invitations/accept", async (req, res) => {
      try {
        const actor = await requireActor(req);
        res.json({
          invitation: await callGlobal(
            acceptInvitationAsync,
            acceptInvitation,
            [actor.account.id, req.body?.token || ""],
            "Budget service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to accept invitation", "cashflow_budget_invitation_accept_failed");
      }
    });

    app.get("/api/admin/options", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          options: await globalOptions()
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load admin options", "cashflow_admin_options_failed");
      }
    });

    app.get("/api/admin/accounts", async (req, res) => {
      try {
        await requireAdmin(req);

        res.json({
          accounts: await callGlobal(
            listAdminAccountsAsync,
            listAdminAccounts,
            [],
            "Admin account service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load admin accounts", "cashflow_admin_accounts_failed");
      }
    });

    app.put("/api/admin/accounts/:accountId", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            updateAdminAccountAsync,
            updateAdminAccount,
            [adminActorId(session), req.params.accountId, req.body || {}],
            "Admin account service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to update admin account", "cashflow_admin_account_update_failed");
      }
    });

    app.post("/api/admin/accounts/:accountId/password-reset-token", async (req, res) => {
      try {
        const session = await requireAdmin(req);
        if (typeof createAdminPasswordResetToken !== "function") throw new Error("Internal authentication service is unavailable");

        res.json(await createAdminPasswordResetToken(adminActorId(session), req.params.accountId, req.body || {}));
      } catch (error) {
        await fail(req, res, error, "Failed to create password setup token", "cashflow_admin_account_password_token_failed");
      }
    });

    app.put("/api/admin/accounts/:accountId/external-identity", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            setAdminExternalIdentityAsync,
            setAdminExternalIdentity,
            [adminActorId(session), req.params.accountId, req.body || {}],
            "External authentication service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to link external identity", "cashflow_admin_account_external_identity_failed");
      }
    });

    app.put("/api/admin/accounts/:accountId/provider-identities/:providerId", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            setAdminProviderIdentityAsync,
            setAdminProviderIdentity,
            [adminActorId(session), req.params.accountId, req.params.providerId, req.body || {}],
            "Authentication provider service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to link provider identity", "cashflow_admin_account_provider_identity_failed");
      }
    });

    app.put("/api/admin/accounts/:accountId/system-admin", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            setAccountSystemAdminAsync,
            setAccountSystemAdmin,
            [adminActorId(session), req.params.accountId, req.body?.enabled],
            "Admin account service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to update system admin role", "cashflow_admin_account_role_update_failed");
      }
    });

    app.post("/api/admin/accounts/:accountId/sessions/:sessionId/revoke", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            revokeAdminAccountSessionAsync,
            revokeAdminAccountSession,
            [adminActorId(session), req.params.accountId, req.params.sessionId],
            "Admin account service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to revoke account session", "cashflow_admin_account_session_revoke_failed");
      }
    });

    app.delete("/api/admin/accounts/:accountId", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          account: await callGlobal(
            deleteAdminAccountAsync,
            deleteAdminAccount,
            [adminActorId(session), req.params.accountId],
            "Admin account service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to delete admin account", "cashflow_admin_account_delete_failed");
      }
    });

    app.get("/api/admin/auth", async (req, res) => {
      try {
        await requireAdmin(req);
        res.json({
          authConfig: await adminAuthConfig(),
          providers: await authProviders()
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load admin auth configuration", "cashflow_admin_auth_failed");
      }
    });

    app.get("/api/admin/auth/providers", async (req, res) => {
      try {
        await requireAdmin(req);
        res.json({ providers: await authProviders() });
      } catch (error) {
        await fail(req, res, error, "Failed to load authentication providers", "cashflow_admin_auth_providers_failed");
      }
    });

    app.put("/api/admin/auth/providers/:providerId", async (req, res) => {
      try {
        const session = await requireAdmin(req);
        res.json({
          provider: await callGlobal(
            upsertAdminAuthProviderAsync,
            upsertAdminAuthProvider,
            [adminActorId(session), req.params.providerId, req.body || {}],
            "Authentication provider service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to save authentication provider", "cashflow_admin_auth_provider_save_failed");
      }
    });

    app.delete("/api/admin/auth/providers/:providerId", async (req, res) => {
      try {
        const session = await requireAdmin(req);
        res.json(await callGlobal(
          deleteAdminAuthProviderAsync,
          deleteAdminAuthProvider,
          [adminActorId(session), req.params.providerId],
          "Authentication provider service is unavailable"
        ));
      } catch (error) {
        await fail(req, res, error, "Failed to delete authentication provider", "cashflow_admin_auth_provider_delete_failed");
      }
    });

    app.put("/api/admin/auth/draft", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          authConfig: await callGlobal(
            updateAdminAuthDraftAsync,
            updateAdminAuthDraft,
            [adminActorId(session), req.body || {}],
            "Admin auth service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to save admin auth draft", "cashflow_admin_auth_draft_failed");
      }
    });

    app.post("/api/admin/auth/test", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json(await callGlobal(
          testAdminAuthDraftAsync,
          testAdminAuthDraft,
          [adminActorId(session)],
          "Admin auth service is unavailable"
        ));
      } catch (error) {
        await fail(req, res, error, "Failed to test admin auth draft", "cashflow_admin_auth_test_failed");
      }
    });

    app.post("/api/admin/auth/activate", async (req, res) => {
      try {
        const session = await requireAdmin(req);

        res.json({
          authConfig: await callGlobal(
            activateAdminAuthDraftAsync,
            activateAdminAuthDraft,
            [adminActorId(session)],
            "Admin auth service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to activate admin auth draft", "cashflow_admin_auth_activate_failed");
      }
    });

    app.put("/api/admin/options", async (req, res) => {
      try {
        await requireAdmin(req);

        res.json({
          ok: true,
          options: await callGlobal(
            updateGlobalOptionsAsync,
            updateGlobalOptions,
            [req.body || {}],
            "Admin options service is unavailable"
          )
        });
      } catch (error) {
        await fail(req, res, error, "Failed to save admin options", "cashflow_admin_options_update_failed");
      }
    });

    app.post("/api/setup", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_SETTINGS);
        if (typeof completeSetup !== "function") throw new Error("Setup service is unavailable");
        const userId = await requestUserId(req);
        const result = await completeSetup(userId, req.body || {});
        const snapshot = await snapshotForUser(userId);
        const session = await sessionForRequest(req);
        res.json({
          app: {
            name: "cashflow",
            version: appVersion
          },
          ...snapshot,
          session,
          setup_required: false,
          admin: await adminPayload(session),
          setup: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to complete first-run setup", "cashflow_setup_failed");
      }
    });

    app.get("/api", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await requestUserId(req);
        const session = await sessionForRequest(req);
        const isSetupRequired = typeof setupRequiredAsync === "function"
          ? await setupRequiredAsync(userId)
          : typeof setupRequired === "function" ? setupRequired(userId) : false;
        const snapshot = await snapshotForUser(userId);
        res.json({
          app: {
            name: "cashflow",
            version: appVersion
          },
          session,
          setup_required: isSetupRequired,
          admin: await adminPayload(session),
          ...snapshot
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load cashflow data", "cashflow_snapshot_failed");
      }
    });

    app.get("/api/locales", async (req, res) => {
      try {
        res.json({
          defaultLocale: "en",
          locales: listAvailableLocales()
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list locales", "cashflow_locales_failed");
      }
    });

    app.get("/api/ledger/confirmed", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const listPage = typeof listConfirmedTransactionsPageAsync === "function"
          ? listConfirmedTransactionsPageAsync
          : listConfirmedTransactionsPage;
        res.json(await listPage(userId, {
          currency: req.query.currency,
          dateFrom: req.query.date_from,
          dateTo: req.query.date_to,
          ledgerCurrency: req.query.ledger_currency,
          limit: req.query.limit,
          offset: req.query.offset,
          sourceId: req.query.source_id,
          sourceType: req.query.source_type,
          type: req.query.type,
          year: req.query.year
        }));
      } catch (error) {
        await fail(req, res, error, "Failed to list confirmed ledger rows", "cashflow_confirmed_page_failed");
      }
    });

    app.post("/api/run-jobs", async (req, res) => {
      let userId = "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_MAINTAIN);
        userId = await resolveRequestUser(req);
        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          allowCachedFxOnRefreshFailure: true,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          _projection: projection,
          ...(await snapshotForUser(userId))
        });
      } catch (error) {
        await recordRouteProjectionFailure(userId, error);

        logCashflowError("cashflow_run_jobs_failed", error, {
          userId
        });

        await fail(req, res, error, "Failed to regenerate projection");
      }
    });

    app.post("/api/fx/refresh", async (req, res) => {
      let userId = "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_MAINTAIN);
        userId = await resolveRequestUser(req);
        const projection = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.fxRefresh,
          () => regenerateProjectionsWithFxRefresh(userId, {
            date: req.body?.date || null,
            refreshFxFirst: true
          }),
          { message: "FX refresh is already running for this budget" }
        );

        res.json({
          ok: true,
          _projection: projection,
          ...(await snapshotForUser(userId))
        });
      } catch (error) {
        logCashflowError("cashflow_fx_refresh_failed", error, {
          userId
        });

        await fail(req, res, error, "Failed to refresh FX rates");
      }
    });

    app.post("/api/fx/refresh-all", async (req, res) => {
      try {
        await requireAdmin(req);
        const result = await refreshNbpFxCacheForAllUsers(req.body?.date || null);
        res.json({ ok: true, users: result });
      } catch (error) {
        await fail(req, res, error, "Failed to refresh FX rates", "cashflow_fx_refresh_all_failed");
      }
    });

    app.get("/api/fx/nbp/:currency", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const settings = typeof getSettingsAsync === "function"
          ? await getSettingsAsync(userId)
          : null;
        const rate = await fetchNbpRate(req.params.currency, null, settings?.timezone);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_current_failed");
      }
    });

    app.get("/api/fx/nbp/:currency/:date", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const settings = typeof getSettingsAsync === "function"
          ? await getSettingsAsync(userId)
          : null;
        const rate = await fetchNbpRate(req.params.currency, req.params.date, settings?.timezone);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_historical_failed");
      }
    });

    app.get("/api/fx/rate/:base/:quote", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const rate = await getProviderPairRate(userId, req.params.base, req.params.quote, req.query.date || null);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_pair_fx_current_failed");
      }
    });

    app.get("/api/fx/rate/:base/:quote/:date", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const rate = await getProviderPairRate(userId, req.params.base, req.params.quote, req.params.date);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_pair_fx_historical_failed");
      }
    });

    app.get("/api/fx/nbp-snapshot", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_READ);
        const userId = await resolveRequestUser(req);
        const settings = typeof getSettingsAsync === "function"
          ? await getSettingsAsync(userId)
          : null;
        const timezone = settings?.timezone || null;
        const currencies = typeof collectCurrenciesForFxSnapshotAsync === "function"
          ? await collectCurrenciesForFxSnapshotAsync(userId)
          : collectCurrenciesForFxSnapshot(userId);
        const snapshot = await fetchNbpFxSnapshot(currencies, req.query.date || null, timezone);
        res.json(snapshot);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_snapshot_failed");
      }
    });

    app.put("/api/settings", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_SETTINGS);
        const userId = await resolveRequestUser(req);
        const updated = await updateSettings(userId, req.body);

        res.json(withProjectionStatus(userId, updated));
      } catch (error) {
        await fail(req, res, error, "Failed to save settings", "cashflow_settings_update_failed");
      }
    });

    app.put("/api/pending/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const updated = await updatePendingTransaction(userId, req.params.id, req.body);
        res.json(updated);
      } catch (error) {
        await fail(req, res, error, "Failed to update pending transaction", "cashflow_pending_update_failed");
      }
    });

    app.delete("/api/pending/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const dismissed = await dismissPendingOneOffRemainder(userId, req.params.id);
        res.json(dismissed);
      } catch (error) {
        await fail(req, res, error, "Failed to dismiss pending one-off remainder", "cashflow_pending_remainder_dismiss_failed");
      }
    });

    app.post("/api/pending/:id/confirm", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.LEDGER_CONFIRM);
        const userId = await resolveRequestUser(req);
        const confirmed = await confirmPendingTransaction(userId, req.params.id, req.body);
        res.json(confirmed);
      } catch (error) {
        await fail(req, res, error, "Failed to confirm pending transaction", "cashflow_pending_confirm_failed");
      }
    });

    app.post("/api/pending/recalculate", async (req, res) => {
      let userId = "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_MAINTAIN);
        userId = await resolveRequestUser(req);
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.projection,
          async () => {
            let deletedPendingCount = typeof countPendingTransactions === "function"
              ? await countPendingTransactions(userId)
              : 0;

            const preflightProjection = await regenerateProjectionsWithFxRefresh(userId, {
              date: req.body?.date || null,
              allowCachedFxOnRefreshFailure: true,
              refreshFxFirst: true,
              skipProjectionLock: true
            });

            deletedPendingCount = typeof clearPendingTransactions === "function"
              ? await clearPendingTransactions(userId)
              : 0;

            const projection = await regenerateProjectionsWithFxRefresh(userId, {
              date: req.body?.date || null,
              refreshFxFirst: false,
              skipProjectionLock: true
            });
            projection.fx_refresh = preflightProjection.fx_refresh;

            return {
              ok: true,
              deletedPendingCount,
              _projection: projection,
              ...(await snapshotForUser(userId))
            };
          },
          { message: "Pending recalculation is already running" }
        );

        res.json(result);
      } catch (error) {
        logCashflowError("cashflow_pending_recalculate_failed", error, {
          userId
        });
        await fail(req, res, error, "Failed to recalculate pending transactions");
      }
    });

    app.post("/api/future/:id/move-to-pending", async (req, res) => {
      let userId = "";
      const occurrenceKey = typeof req.body?.occurrenceKey === "string" ? req.body.occurrenceKey : "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        userId = await resolveRequestUser(req);
        const moved = await moveFutureTransactionToPending(userId, req.params.id, { occurrenceKey });
        res.json({
          ...(await snapshotForUser(userId)),
          move: moved
        });
      } catch (error) {
        logError("cashflow_future_move_to_pending_failed", {
          userId,
          futureTransactionId: req.params.id,
          occurrenceKey,
          error: error.message || String(error)
        });
        await fail(req, res, error, "Failed to move future transaction to pending");
      }
    });

    app.post("/api/ledger/compact-history", async (req, res) => {
      let userId = "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_MAINTAIN);
        userId = await resolveRequestUser(req);
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.retention,
          () => compactLedgerHistory(userId, {
            months: Object.prototype.hasOwnProperty.call(req.body || {}, "months")
              ? req.body.months
              : undefined
          }),
          { message: "Ledger compaction is already running" }
        );
        res.json({
          ...(await snapshotForUser(userId)),
          compaction: result
        });
      } catch (error) {
        logCashflowError("cashflow_ledger_compaction_failed", error, {
          userId
        });
        await fail(req, res, error, "Failed to compact ledger history", "cashflow_ledger_compaction_failed");
      }
    });

    app.post("/api/recurring-expenses", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-expense", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(await createRecurringExpense(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create recurring expense", "cashflow_recurring_expense_create_failed");
      }
    });

    app.put("/api/recurring-expenses/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-expense", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(await updateRecurringExpense(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update recurring expense", "cashflow_recurring_expense_update_failed");
      }
    });

    app.delete("/api/recurring-expenses/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        res.json(await deleteRecurringExpense(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete recurring expense", "cashflow_recurring_expense_delete_failed");
      }
    });

    app.post("/api/recurring-incomes", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-income", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(await createRecurringIncome(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create recurring income", "cashflow_recurring_income_create_failed");
      }
    });

    app.put("/api/recurring-incomes/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-income", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(await updateRecurringIncome(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update recurring income", "cashflow_recurring_income_update_failed");
      }
    });

    app.delete("/api/recurring-incomes/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        res.json(await deleteRecurringIncome(userId, req.params.id, {
          reassignAnchorsToIncomeId: req.body?.reassignAnchorsToIncomeId || null,
          fallbackAnchorsToFixedDay: Boolean(req.body?.fallbackAnchorsToFixedDay)
        }));
      } catch (error) {
        await fail(req, res, error, "Failed to delete recurring income", "cashflow_recurring_income_delete_failed");
      }
    });

    app.post("/api/goals", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("goal", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(await createGoal(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create goal", "cashflow_goal_create_failed");
      }
    });

    app.put("/api/goals/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("goal", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(await updateGoal(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update goal", "cashflow_goal_update_failed");
      }
    });

    app.delete("/api/goals/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        res.json(await deleteGoal(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete goal", "cashflow_goal_delete_failed");
      }
    });

    app.post("/api/flex", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("flex", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(await createFlexTransaction(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create flex transaction", "cashflow_flex_create_failed");
      }
    });

    app.put("/api/flex/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("flex", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(await updateFlexTransaction(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update flex transaction", "cashflow_flex_update_failed");
      }
    });

    app.delete("/api/flex/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        res.json(await deleteFlexTransaction(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete flex transaction", "cashflow_flex_delete_failed");
      }
    });

    app.post("/api/one-off", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("one-off", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(await createOneOffTransaction(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create one-off transaction", "cashflow_oneoff_create_failed");
      }
    });

    app.put("/api/one-off/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        const input = validatePlanMutationInput("one-off", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(await updateOneOffTransaction(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update one-off transaction", "cashflow_oneoff_update_failed");
      }
    });

    app.delete("/api/one-off/:id", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.PLANNER_WRITE);
        const userId = await resolveRequestUser(req);
        res.json(await deleteOneOffTransaction(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete one-off transaction", "cashflow_oneoff_delete_failed");
      }
    });

    app.post("/api/regenerate-projections", async (req, res) => {
      let userId = "";

      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_MAINTAIN);
        userId = await resolveRequestUser(req);
        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          allowCachedFxOnRefreshFailure: true,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          _projection: projection,
          ...(await snapshotForUser(userId))
        });
      } catch (error) {
        await recordRouteProjectionFailure(userId, error);

        logCashflowError("cashflow_regenerate_projections_failed", error, {
          userId
        });

        await fail(req, res, error, "Failed to regenerate projection");
      }
    });

    app.post("/api/backup", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_BACKUP);
        const userId = await resolveRequestUser(req);
        const backupPath = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.automaticBackup,
          () => typeof createBackupAsync === "function" ? createBackupAsync(userId) : createBackup(userId),
          {
            message: "Backup is already running",
            ttlMs: 300000
          }
        );
        res.json({ ok: true, path: backupPath });
      } catch (error) {
        await fail(req, res, error, "Failed to create backup", "cashflow_backup_failed");
      }
    });

    app.get("/api/export/full", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_EXPORT);
        const userId = await resolveRequestUser(req);
        const includeOperationalSettings = req.query.includeOperationalSettings === "1"
          || req.query.includeOperationalSettings === "true";
        const exported = typeof exportFullDataAsync === "function"
          ? await exportFullDataAsync(userId, appVersion, { includeOperationalSettings })
          : exportFullData(userId, appVersion, { includeOperationalSettings });
        const fileName = `cashflow-${userId}-full-export.json`;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        await fail(req, res, error, "Failed to export cashflow data", "cashflow_full_export_failed");
      }
    });

    app.post("/api/import/full/preview", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_IMPORT);
        const userId = await resolveRequestUser(req);
        const previewArgs = [
          userId,
          req.body?.export || req.body,
          req.body?.mode || "replace",
          { includeOperationalSettings: Boolean(req.body?.includeOperationalSettings) }
        ];
        const result = typeof previewFullImportAsync === "function"
          ? await previewFullImportAsync(...previewArgs)
          : previewFullImport(...previewArgs);
        res.json(result);
      } catch (error) {
        await fail(req, res, error, "Failed to preview cashflow import", "cashflow_full_import_preview_failed");
      }
    });

    app.post("/api/import/full", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_IMPORT);
        const userId = await resolveRequestUser(req);
        const importArgs = [
          userId,
          req.body?.export || req.body,
          req.body?.mode || "replace",
          { includeOperationalSettings: Boolean(req.body?.includeOperationalSettings) }
        ];
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.dataPortability,
          () => typeof importFullDataAsync === "function"
            ? importFullDataAsync(...importArgs)
            : importFullData(...importArgs),
          {
            message: "An import or restore is already running for this budget",
            ttlMs: 300000
          }
        );
        res.json({
          ...(await snapshotForUser(userId)),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to import cashflow data", "cashflow_full_import_failed");
      }
    });

    app.post("/api/import/one-offs-csv", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_IMPORT);
        const userId = await resolveRequestUser(req);
        const csv = req.body?.csv || "";
        const mode = req.body?.mode || "append";
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.dataPortability,
          () => typeof importOneOffCsvAsync === "function"
            ? importOneOffCsvAsync(userId, csv, mode)
            : importOneOffCsv(userId, csv, mode),
          {
            message: "An import or restore is already running for this budget",
            ttlMs: 300000
          }
        );
        res.json({
          ...(await snapshotForUser(userId)),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to import one-off CSV", "cashflow_oneoff_csv_import_failed");
      }
    });

    app.get("/api/export/confirmed-ledger.csv", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_EXPORT);
        const userId = await resolveRequestUser(req);
        const csv = typeof exportConfirmedLedgerCsvAsync === "function"
          ? await exportConfirmedLedgerCsvAsync(userId)
          : exportConfirmedLedgerCsv(userId);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="cashflow-${userId}-confirmed-ledger.csv"`);
        res.send(csv);
      } catch (error) {
        await fail(req, res, error, "Failed to export confirmed ledger CSV", "cashflow_confirmed_ledger_csv_export_failed");
      }
    });

    app.get("/api/export/sample", async (req, res) => {
      try {
        const exported = exportSampleData();

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", "attachment; filename=\"cashflow-sample-dataset.json\"");
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        await fail(req, res, error, "Failed to export sample dataset", "cashflow_sample_export_failed");
      }
    });

    app.post("/api/import/sample", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_IMPORT);
        const userId = await resolveRequestUser(req);
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.dataPortability,
          () => typeof importSampleDataAsync === "function"
            ? importSampleDataAsync(userId)
            : importSampleData(userId),
          {
            message: "An import or restore is already running for this budget",
            ttlMs: 300000
          }
        );
        res.json({
          ...(await snapshotForUser(userId)),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load sample dataset", "cashflow_sample_import_failed");
      }
    });

    app.post("/api/validate", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_VALIDATE);
        const userId = await resolveRequestUser(req);
        res.json(validateCashflowData(userId));
      } catch (error) {
        await fail(req, res, error, "Failed to run validation", "cashflow_validate_failed");
      }
    });

    app.post("/api/restore/:backupId", async (req, res) => {
      try {
        await requireBudgetCapability(req, CAPABILITIES.BUDGET_RESTORE);
        const userId = await resolveRequestUser(req);
        const result = await withBudgetRouteLock(
          userId,
          BUDGET_RUNTIME_LOCK_JOBS.dataPortability,
          () => typeof restoreBackupAsync === "function"
            ? restoreBackupAsync(userId, req.params.backupId)
            : restoreBackup(userId, req.params.backupId),
          {
            message: "An import or restore is already running for this budget",
            ttlMs: 300000
          }
        );
        res.json({
          ...(await snapshotForUser(userId)),
          restore: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to restore backup", "cashflow_restore_failed");
      }
    });
}

