import { sendApiError } from "./cashflow-error-utils.js";
import { forbidden } from "./cashflow-user-utils.js";

export function registerCashflowRoutes(app, {
  appVersion = "0.0.0",
  collectCurrenciesForFxSnapshot,
  confirmPendingTransaction,
  completeSetup = null,
  createBackup,
  createFlexTransaction,
  createGoal,
  createOneOffTransaction,
  createRecurringExpense,
  createRecurringIncome,
  createUser = null,
  deleteFlexTransaction,
  deleteGoal,
  deleteOneOffTransaction,
  deleteRecurringExpense,
  deleteRecurringIncome,
  ensureFxCacheForMutation,
  exportConfirmedLedgerCsv,
  exportFullData,
  exportSampleData,
  fetchNbpFxSnapshot,
  fetchNbpRate,
  getCachedFxSnapshot,
  getGlobalOptions = null,
  getProviderPairRate,
  getSnapshot,
  listAvailableLocales = () => [{ id: "en", label: "English" }],
  listUsers = null,
  logCashflowError,
  logError,
  moveFutureTransactionToPending,
  openPlanningDb,
  recordProjectionFailure,
  refreshNbpFxCacheForAllUsers,
  regenerateProjectionsWithFxRefresh,
  resolveRequestUser,
  resolveSession = null,
  selectUser = null,
  restoreBackup,
  importFullData,
  importOneOffCsv,
  importSampleData,
  safeGetCurrentFxSnapshot,
  setupRequired = null,
  updateFlexTransaction,
  updateGoal,
  updateOneOffTransaction,
  updatePendingTransaction,
  updateRecurringExpense,
  updateRecurringIncome,
  updateSettings,
  updateGlobalOptions = null,
  validatePlanMutationInput,
  translateLocale = async (_locale, key, params = {}) => String(key || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => params?.[name] ?? ""),
  validateCashflowData,
  withProjectionStatus
}) {
    function resolveRequestLocale(req) {
      try {
        const userId = resolveRequestUser(req);
        const db = openPlanningDb(userId, { create: false });
        try {
          return db.prepare("SELECT locale FROM settings WHERE id = 1").get()?.locale || "en";
        } finally {
          db.close();
        }
      } catch {
        return "en";
      }
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

    function requestUserId(req) {
      return resolveRequestUser(req);
    }

    function requestUserHeader(req) {
      return String(req.headers["x-cashflow-user-id"] || "").trim();
    }

    function sessionForRequest(req) {
      const userId = requestUserHeader(req);
      return typeof resolveSession === "function"
        ? resolveSession(userId)
        : {
            authenticated: Boolean(userId),
            userId,
            displayName: userId,
            permissions: userId ? ["admin"] : []
          };
    }

    function canAdmin(session) {
      return Array.isArray(session?.permissions) && session.permissions.includes("admin");
    }

    function requireAdmin(req) {
      const session = sessionForRequest(req);
      if (!canAdmin(session)) {
        throw forbidden("Admin permission required");
      }
      return session;
    }

    app.get("/api/users", async (req, res) => {
      try {
        res.json({
          users: typeof listUsers === "function" ? listUsers() : []
        });
      } catch (error) {
        await fail(req, res, error, "Failed to list users", "cashflow_users_list_failed");
      }
    });

    app.post("/api/users", async (req, res) => {
      try {
        if (typeof createUser !== "function") throw new Error("User service is unavailable");
        res.json({
          session: createUser(req.body || {})
        });
      } catch (error) {
        await fail(req, res, error, "Failed to create user", "cashflow_user_create_failed");
      }
    });

    app.get("/api/session", async (req, res) => {
      try {
        const session = sessionForRequest(req);
        res.json({
          session,
          admin: typeof getGlobalOptions === "function" && canAdmin(session)
            ? { options: getGlobalOptions() }
            : null
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load session", "cashflow_session_failed");
      }
    });

    app.post("/api/session/select", async (req, res) => {
      try {
        if (typeof selectUser !== "function") throw new Error("User service is unavailable");
        const session = selectUser(req.body?.userId || req.body?.id || "");
        res.json({
          session,
          admin: typeof getGlobalOptions === "function" && canAdmin(session)
            ? { options: getGlobalOptions() }
            : null
        });
      } catch (error) {
        await fail(req, res, error, "Failed to select user", "cashflow_session_select_failed");
      }
    });

    app.post("/api/logout", async (req, res) => {
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

    app.get("/api/admin/options", async (req, res) => {
      try {
        const session = requireAdmin(req);

        res.json({
          options: typeof getGlobalOptions === "function" ? getGlobalOptions() : {}
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load admin options", "cashflow_admin_options_failed");
      }
    });

    app.put("/api/admin/options", async (req, res) => {
      try {
        requireAdmin(req);

        if (typeof updateGlobalOptions !== "function") throw new Error("Admin options service is unavailable");
        res.json({
          ok: true,
          options: updateGlobalOptions(req.body || {})
        });
      } catch (error) {
        await fail(req, res, error, "Failed to save admin options", "cashflow_admin_options_update_failed");
      }
    });

    app.post("/api/setup", async (req, res) => {
      try {
        if (typeof completeSetup !== "function") throw new Error("Setup service is unavailable");
        const userId = requestUserId(req);
        const result = completeSetup(userId, req.body || {});
        const snapshot = getSnapshot(userId);
        const session = typeof resolveSession === "function"
          ? resolveSession(userId)
          : { authenticated: true, userId, displayName: userId, permissions: ["admin"] };
        res.json({
          app: {
            name: "cashflow",
            version: appVersion
          },
          ...snapshot,
          session,
          setup_required: false,
          admin: typeof getGlobalOptions === "function" && canAdmin(session)
            ? { options: getGlobalOptions() }
            : null,
          setup: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to complete first-run setup", "cashflow_setup_failed");
      }
    });

    app.get("/api", async (req, res) => {
      try {
        const userId = requestUserId(req);
        const session = typeof resolveSession === "function"
          ? resolveSession(userId)
          : { authenticated: true, userId, displayName: userId, permissions: ["admin"] };
        const isSetupRequired = typeof setupRequired === "function" ? setupRequired(userId) : false;
        const snapshot = getSnapshot(userId);
        res.json({
          app: {
            name: "cashflow",
            version: appVersion
          },
          session,
          setup_required: isSetupRequired,
          admin: typeof getGlobalOptions === "function" && canAdmin(session)
            ? { options: getGlobalOptions() }
            : null,
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

    app.post("/api/run-jobs", async (req, res) => {
      let userId = "";

      try {
        requireAdmin(req);
        userId = resolveRequestUser(req);
        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          _projection: projection,
          ...getSnapshot(userId)
        });
      } catch (error) {
        try {
          const db = openPlanningDb(userId);

          try {
            recordProjectionFailure(
              db,
              userId,
              error,
              safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId)
            );
          } finally {
            db.close();
          }
        } catch (recordError) {
          logCashflowError("cashflow_projection_failure_record_failed", recordError, {
            userId
          });
        }

        logCashflowError("cashflow_run_jobs_failed", error, {
          userId
        });

        await fail(req, res, error, "Failed to regenerate projection");
      }
    });

    app.post("/api/fx/refresh", async (req, res) => {
      let userId = "";

      try {
        requireAdmin(req);
        userId = resolveRequestUser(req);
        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          _projection: projection,
          ...getSnapshot(userId)
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
        requireAdmin(req);
        const result = await refreshNbpFxCacheForAllUsers(req.body?.date || null);
        res.json({ ok: true, users: result });
      } catch (error) {
        await fail(req, res, error, "Failed to refresh FX rates", "cashflow_fx_refresh_all_failed");
      }
    });

    app.get("/api/fx/nbp/:currency", async (req, res) => {
      let db = null;
      try {
        db = openPlanningDb(resolveRequestUser(req));
        const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchNbpRate(req.params.currency, null, settings.timezone);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_current_failed");
      } finally {
        db?.close();
      }
    });

    app.get("/api/fx/nbp/:currency/:date", async (req, res) => {
      let db = null;
      try {
        db = openPlanningDb(resolveRequestUser(req));
        const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchNbpRate(req.params.currency, req.params.date, settings.timezone);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_historical_failed");
      } finally {
        db?.close();
      }
    });

    app.get("/api/fx/rate/:base/:quote", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const rate = await getProviderPairRate(userId, req.params.base, req.params.quote, req.query.date || null);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_pair_fx_current_failed");
      }
    });

    app.get("/api/fx/rate/:base/:quote/:date", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const rate = await getProviderPairRate(userId, req.params.base, req.params.quote, req.params.date);
        res.json(rate);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_pair_fx_historical_failed");
      }
    });

    app.get("/api/fx/nbp-snapshot", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const db = openPlanningDb(userId);
        let timezone = null;
        try {
          timezone = db.prepare("SELECT timezone FROM settings WHERE id = 1").get()?.timezone || null;
        } finally {
          db.close();
        }
        const currencies = collectCurrenciesForFxSnapshot(userId);
        const snapshot = await fetchNbpFxSnapshot(currencies, req.query.date || null, timezone);
        res.json(snapshot);
      } catch (error) {
        await fail(req, res, error, "Failed to fetch FX rates", "cashflow_nbp_fx_snapshot_failed");
      }
    });

    app.put("/api/settings", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const updated = await updateSettings(userId, req.body);

        res.json(withProjectionStatus(userId, updated));
      } catch (error) {
        await fail(req, res, error, "Failed to save settings", "cashflow_settings_update_failed");
      }
    });

    app.put("/api/pending/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const updated = updatePendingTransaction(userId, req.params.id, req.body);
        res.json(updated);
      } catch (error) {
        await fail(req, res, error, "Failed to update pending transaction", "cashflow_pending_update_failed");
      }
    });

    app.post("/api/pending/:id/confirm", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const confirmed = await confirmPendingTransaction(userId, req.params.id, req.body);
        res.json(confirmed);
      } catch (error) {
        await fail(req, res, error, "Failed to confirm pending transaction", "cashflow_pending_confirm_failed");
      }
    });

    app.post("/api/pending/recalculate", async (req, res) => {
      let userId = "";

      try {
        requireAdmin(req);
        userId = resolveRequestUser(req);
        let deletedPendingCount = 0;
        const db = openPlanningDb(userId);

        try {
          deletedPendingCount = db.transaction(() => {
            const result = db.prepare("DELETE FROM pending_transactions").run();
            return result.changes || 0;
          })();
        } finally {
          db.close();
        }

        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          deletedPendingCount,
          _projection: projection,
          ...getSnapshot(userId)
        });
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
        userId = resolveRequestUser(req);
        const moved = moveFutureTransactionToPending(userId, req.params.id, { occurrenceKey });
        res.json({
          ...getSnapshot(userId),
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

    app.post("/api/recurring-expenses", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-expense", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(createRecurringExpense(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create recurring expense", "cashflow_recurring_expense_create_failed");
      }
    });

    app.put("/api/recurring-expenses/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-expense", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(updateRecurringExpense(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update recurring expense", "cashflow_recurring_expense_update_failed");
      }
    });

    app.delete("/api/recurring-expenses/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteRecurringExpense(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete recurring expense", "cashflow_recurring_expense_delete_failed");
      }
    });

    app.post("/api/recurring-incomes", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-income", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(createRecurringIncome(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create recurring income", "cashflow_recurring_income_create_failed");
      }
    });

    app.put("/api/recurring-incomes/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("recurring-income", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(updateRecurringIncome(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update recurring income", "cashflow_recurring_income_update_failed");
      }
    });

    app.delete("/api/recurring-incomes/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteRecurringIncome(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete recurring income", "cashflow_recurring_income_delete_failed");
      }
    });

    app.post("/api/goals", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("goal", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(createGoal(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create goal", "cashflow_goal_create_failed");
      }
    });

    app.put("/api/goals/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("goal", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(updateGoal(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update goal", "cashflow_goal_update_failed");
      }
    });

    app.delete("/api/goals/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteGoal(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete goal", "cashflow_goal_delete_failed");
      }
    });

    app.post("/api/flex", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("flex", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(createFlexTransaction(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create flex transaction", "cashflow_flex_create_failed");
      }
    });

    app.put("/api/flex/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("flex", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(updateFlexTransaction(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update flex transaction", "cashflow_flex_update_failed");
      }
    });

    app.delete("/api/flex/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteFlexTransaction(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete flex transaction", "cashflow_flex_delete_failed");
      }
    });

    app.post("/api/one-off", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("one-off", req.body, { create: true });
        await ensureFxCacheForMutation(userId, input);
        res.json(createOneOffTransaction(userId, input));
      } catch (error) {
        await fail(req, res, error, "Failed to create one-off transaction", "cashflow_oneoff_create_failed");
      }
    });

    app.put("/api/one-off/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const input = validatePlanMutationInput("one-off", req.body);
        await ensureFxCacheForMutation(userId, input);
        res.json(updateOneOffTransaction(userId, req.params.id, input));
      } catch (error) {
        await fail(req, res, error, "Failed to update one-off transaction", "cashflow_oneoff_update_failed");
      }
    });

    app.delete("/api/one-off/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(await deleteOneOffTransaction(userId, req.params.id));
      } catch (error) {
        await fail(req, res, error, "Failed to delete one-off transaction", "cashflow_oneoff_delete_failed");
      }
    });

    app.post("/api/regenerate-projections", async (req, res) => {
      let userId = "";

      try {
        requireAdmin(req);
        userId = resolveRequestUser(req);
        const projection = await regenerateProjectionsWithFxRefresh(userId, {
          date: req.body?.date || null,
          refreshFxFirst: true
        });

        res.json({
          ok: true,
          _projection: projection,
          ...getSnapshot(userId)
        });
      } catch (error) {
        try {
          const db = openPlanningDb(userId);

          try {
            recordProjectionFailure(
              db,
              userId,
              error,
              safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId)
            );
          } finally {
            db.close();
          }
        } catch (recordError) {
          logCashflowError("cashflow_projection_failure_record_failed", recordError, {
            userId
          });
        }

        logCashflowError("cashflow_regenerate_projections_failed", error, {
          userId
        });

        await fail(req, res, error, "Failed to regenerate projection");
      }
    });

    app.post("/api/backup", async (req, res) => {
      try {
        requireAdmin(req);
        const userId = resolveRequestUser(req);
        const backupPath = createBackup(userId);
        res.json({ ok: true, path: backupPath });
      } catch (error) {
        await fail(req, res, error, "Failed to create backup", "cashflow_backup_failed");
      }
    });

    app.get("/api/export/full", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const includeOperationalSettings = req.query.includeOperationalSettings === "1"
          || req.query.includeOperationalSettings === "true";
        const exported = exportFullData(userId, appVersion, { includeOperationalSettings });
        const fileName = `cashflow-${userId}-full-export.json`;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        await fail(req, res, error, "Failed to export cashflow data", "cashflow_full_export_failed");
      }
    });

    app.post("/api/import/full", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const result = importFullData(
          userId,
          req.body?.export || req.body,
          req.body?.mode || "replace",
          { includeOperationalSettings: Boolean(req.body?.includeOperationalSettings) }
        );
        res.json({
          ...getSnapshot(userId),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to import cashflow data", "cashflow_full_import_failed");
      }
    });

    app.post("/api/import/one-offs-csv", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const result = importOneOffCsv(userId, req.body?.csv || "", req.body?.mode || "append");
        res.json({
          ...getSnapshot(userId),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to import one-off CSV", "cashflow_oneoff_csv_import_failed");
      }
    });

    app.get("/api/export/confirmed-ledger.csv", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const csv = exportConfirmedLedgerCsv(userId);

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
        const userId = resolveRequestUser(req);
        const result = importSampleData(userId);
        res.json({
          ...getSnapshot(userId),
          import: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to load sample dataset", "cashflow_sample_import_failed");
      }
    });

    app.post("/api/validate", async (req, res) => {
      try {
        requireAdmin(req);
        const userId = resolveRequestUser(req);
        res.json(validateCashflowData(userId));
      } catch (error) {
        await fail(req, res, error, "Failed to run validation", "cashflow_validate_failed");
      }
    });

    app.post("/api/restore/:backupId", async (req, res) => {
      try {
        requireAdmin(req);
        const userId = resolveRequestUser(req);
        const result = restoreBackup(userId, req.params.backupId);
        res.json({
          ...getSnapshot(userId),
          restore: result
        });
      } catch (error) {
        await fail(req, res, error, "Failed to restore backup", "cashflow_restore_failed");
      }
    });
}

