import { cashflowErrorMessage } from "./cashflow-error-utils.js";

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
  fetchProviderRate,
  fetchNbpFxSnapshot,
  fetchNbpRate,
  getCachedFxSnapshot,
  getGlobalOptions = null,
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
  translateLocale = async (_locale, key, params = {}) => String(key || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => params?.[name] ?? ""),
  validateCashflowData,
  withProjectionStatus
}) {
    function resolveRequestLocale(req) {
      try {
        const userId = resolveRequestUser(req);
        const db = openPlanningDb(userId);
        try {
          return db.prepare("SELECT locale FROM settings WHERE id = 1").get()?.locale || "en";
        } finally {
          db.close();
        }
      } catch {
        return "en";
      }
    }

    async function apiErrorMessage(req, error, fallback) {
      const message = cashflowErrorMessage(error) || error?.message || fallback;
      return translateLocale(resolveRequestLocale(req), message || fallback);
    }

    function requestUserId(req) {
      return resolveRequestUser(req);
    }

    function sessionForRequest(req) {
      const userId = requestUserId(req);
      return typeof resolveSession === "function"
        ? resolveSession(userId)
        : {
            authenticated: true,
            userId,
            displayName: userId,
            permissions: ["admin"]
          };
    }

    function canAdmin(session) {
      return Array.isArray(session?.permissions) && session.permissions.includes("admin");
    }

    app.get("/api/users", async (req, res) => {
      try {
        res.json({
          users: typeof listUsers === "function" ? listUsers() : []
        });
      } catch (error) {
        logError("cashflow_users_list_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to list users") });
      }
    });

    app.post("/api/users", async (req, res) => {
      try {
        if (typeof createUser !== "function") throw new Error("User service is unavailable");
        res.json({
          session: createUser(req.body || {})
        });
      } catch (error) {
        logError("cashflow_user_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create user") });
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
        logError("cashflow_session_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to load session") });
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
        const session = sessionForRequest(req);
        if (!canAdmin(session)) {
          res.status(403).json({ error: await translateLocale(resolveRequestLocale(req), "Admin permission required") });
          return;
        }

        res.json({
          options: typeof getGlobalOptions === "function" ? getGlobalOptions() : {}
        });
      } catch (error) {
        logError("cashflow_admin_options_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to load admin options") });
      }
    });

    app.put("/api/admin/options", async (req, res) => {
      try {
        const session = sessionForRequest(req);
        if (!canAdmin(session)) {
          res.status(403).json({ error: await translateLocale(resolveRequestLocale(req), "Admin permission required") });
          return;
        }

        if (typeof updateGlobalOptions !== "function") throw new Error("Admin options service is unavailable");
        res.json({
          ok: true,
          options: updateGlobalOptions(req.body || {})
        });
      } catch (error) {
        logError("cashflow_admin_options_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to save admin options") });
      }
    });

    app.post("/api/setup", async (req, res) => {
      try {
        if (typeof completeSetup !== "function") throw new Error("Setup service is unavailable");
        const userId = requestUserId(req);
        const result = completeSetup(userId, req.body || {});
        const snapshot = getSnapshot(userId);
        const session = sessionForRequest(req);
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
        logError("cashflow_setup_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to complete first-run setup") });
      }
    });

    app.get("/api", async (req, res) => {
      try {
        const userId = requestUserId(req);
        const session = sessionForRequest(req);
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
        logError("cashflow_snapshot_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to load cashflow data") });
      }
    });

    app.get("/api/locales", async (req, res) => {
      try {
        res.json({
          defaultLocale: "en",
          locales: listAvailableLocales()
        });
      } catch (error) {
        logError("cashflow_locales_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to list locales") });
      }
    });

    app.post("/api/run-jobs", async (req, res) => {
      const userId = resolveRequestUser(req);

      try {
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

        res.status(500).json({
          error: await apiErrorMessage(req, error, "Failed to regenerate projection")
        });
      }
    });

    app.post("/api/fx/refresh", async (req, res) => {
      const userId = resolveRequestUser(req);

      try {
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

        res.status(500).json({
          error: await apiErrorMessage(req, error, "Failed to refresh FX rates")
        });
      }
    });

    app.post("/api/fx/refresh-all", async (req, res) => {
      try {
        const result = await refreshNbpFxCacheForAllUsers(req.body?.date || null);
        res.json({ ok: true, users: result });
      } catch (error) {
        logError("cashflow_fx_refresh_all_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to refresh FX rates") });
      }
    });

    app.get("/api/fx/nbp/:currency", async (req, res) => {
      const db = openPlanningDb(resolveRequestUser(req));
      try {
        const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchNbpRate(req.params.currency, null, settings.timezone);
        res.json(rate);
      } catch (error) {
        logError("cashflow_nbp_fx_current_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      } finally {
        db.close();
      }
    });

    app.get("/api/fx/nbp/:currency/:date", async (req, res) => {
      const db = openPlanningDb(resolveRequestUser(req));
      try {
        const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchNbpRate(req.params.currency, req.params.date, settings.timezone);
        res.json(rate);
      } catch (error) {
        logError("cashflow_nbp_fx_historical_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      } finally {
        db.close();
      }
    });

    app.get("/api/fx/rate/:base/:quote", async (req, res) => {
      const db = openPlanningDb(resolveRequestUser(req));
      try {
        const settings = db.prepare("SELECT fx_provider, timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchProviderRate(settings.fx_provider || "nbp", req.params.base, req.query.date || null, req.params.quote, settings.timezone);
        res.json(rate);
      } catch (error) {
        logError("cashflow_pair_fx_current_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      } finally {
        db.close();
      }
    });

    app.get("/api/fx/rate/:base/:quote/:date", async (req, res) => {
      const db = openPlanningDb(resolveRequestUser(req));
      try {
        const settings = db.prepare("SELECT fx_provider, timezone FROM settings WHERE id = 1").get() || {};
        const rate = await fetchProviderRate(settings.fx_provider || "nbp", req.params.base, req.params.date, req.params.quote, settings.timezone);
        res.json(rate);
      } catch (error) {
        logError("cashflow_pair_fx_historical_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      } finally {
        db.close();
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
        logError("cashflow_nbp_fx_snapshot_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      }
    });

    app.put("/api/settings", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const updated = await updateSettings(userId, req.body);

        res.json(withProjectionStatus(userId, updated));
      } catch (error) {
        logError("cashflow_settings_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to save settings") });
      }
    });

    app.put("/api/pending/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const updated = updatePendingTransaction(userId, req.params.id, req.body);
        res.json(updated);
      } catch (error) {
        logError("cashflow_pending_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update pending transaction") });
      }
    });

    app.post("/api/pending/:id/confirm", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const confirmed = await confirmPendingTransaction(userId, req.params.id, req.body);
        res.json(confirmed);
      } catch (error) {
        logError("cashflow_pending_confirm_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to confirm pending transaction") });
      }
    });

    app.post("/api/pending/recalculate", async (req, res) => {
      const userId = resolveRequestUser(req);

      try {
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
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to recalculate pending transactions") });
      }
    });

    app.post("/api/future/:id/move-to-pending", async (req, res) => {
      const userId = resolveRequestUser(req);
      const occurrenceKey = typeof req.body?.occurrenceKey === "string" ? req.body.occurrenceKey : "";

      try {
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
        res.status(error.message === "Future transaction not found" ? 404 : 500).json({ error: await apiErrorMessage(req, error, "Failed to move future transaction to pending") });
      }
    });

    app.post("/api/recurring-expenses", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(createRecurringExpense(userId, req.body));
      } catch (error) {
        logError("cashflow_recurring_expense_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create recurring expense") });
      }
    });

    app.put("/api/recurring-expenses/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(updateRecurringExpense(userId, req.params.id, req.body));
      } catch (error) {
        logError("cashflow_recurring_expense_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update recurring expense") });
      }
    });

    app.delete("/api/recurring-expenses/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteRecurringExpense(userId, req.params.id));
      } catch (error) {
        logError("cashflow_recurring_expense_delete_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to delete recurring expense") });
      }
    });

    app.post("/api/recurring-incomes", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(createRecurringIncome(userId, req.body));
      } catch (error) {
        logError("cashflow_recurring_income_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create recurring income") });
      }
    });

    app.put("/api/recurring-incomes/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(updateRecurringIncome(userId, req.params.id, req.body));
      } catch (error) {
        logError("cashflow_recurring_income_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update recurring income") });
      }
    });

    app.delete("/api/recurring-incomes/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteRecurringIncome(userId, req.params.id));
      } catch (error) {
        logError("cashflow_recurring_income_delete_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to delete recurring income") });
      }
    });

    app.post("/api/goals", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(createGoal(userId, req.body));
      } catch (error) {
        logError("cashflow_goal_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create goal") });
      }
    });

    app.put("/api/goals/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(updateGoal(userId, req.params.id, req.body));
      } catch (error) {
        logError("cashflow_goal_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update goal") });
      }
    });

    app.delete("/api/goals/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteGoal(userId, req.params.id));
      } catch (error) {
        logError("cashflow_goal_delete_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to delete goal") });
      }
    });

    app.post("/api/flex", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(createFlexTransaction(userId, req.body));
      } catch (error) {
        logError("cashflow_flex_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create flex transaction") });
      }
    });

    app.put("/api/flex/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(updateFlexTransaction(userId, req.params.id, req.body));
      } catch (error) {
        logError("cashflow_flex_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update flex transaction") });
      }
    });

    app.delete("/api/flex/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteFlexTransaction(userId, req.params.id));
      } catch (error) {
        logError("cashflow_flex_delete_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to delete flex transaction") });
      }
    });

    app.post("/api/one-off", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(createOneOffTransaction(userId, req.body));
      } catch (error) {
        logError("cashflow_oneoff_create_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create one-off transaction") });
      }
    });

    app.put("/api/one-off/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        await ensureFxCacheForMutation(userId, req.body);
        res.json(updateOneOffTransaction(userId, req.params.id, req.body));
      } catch (error) {
        logError("cashflow_oneoff_update_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to update one-off transaction") });
      }
    });

    app.delete("/api/one-off/:id", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(deleteOneOffTransaction(userId, req.params.id));
      } catch (error) {
        logError("cashflow_oneoff_delete_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to delete one-off transaction") });
      }
    });

    app.post("/api/regenerate-projections", async (req, res) => {
      const userId = resolveRequestUser(req);

      try {
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

        res.status(500).json({
          error: await apiErrorMessage(req, error, "Failed to regenerate projection")
        });
      }
    });

    app.post("/api/backup", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const backupPath = createBackup(userId);
        res.json({ ok: true, path: backupPath });
      } catch (error) {
        logError("cashflow_backup_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to create backup") });
      }
    });

    app.get("/api/export/full", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const exported = exportFullData(userId, appVersion);
        const fileName = `cashflow-${userId}-full-export.json`;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        logError("cashflow_full_export_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to export cashflow data") });
      }
    });

    app.post("/api/import/full", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const result = importFullData(userId, req.body?.export || req.body, req.body?.mode || "replace");
        res.json({
          ...getSnapshot(userId),
          import: result
        });
      } catch (error) {
        logError("cashflow_full_import_failed", error);
        res.status(error.status || 500).json({
          error: await apiErrorMessage(req, error, "Failed to import cashflow data"),
          ...(error.conflicts ? { conflicts: error.conflicts } : {})
        });
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
        logError("cashflow_oneoff_csv_import_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to import one-off CSV") });
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
        logError("cashflow_confirmed_ledger_csv_export_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to export confirmed ledger CSV") });
      }
    });

    app.get("/api/export/sample", async (req, res) => {
      try {
        const exported = exportSampleData();

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", "attachment; filename=\"cashflow-sample-dataset.json\"");
        res.send(JSON.stringify(exported, null, 2));
      } catch (error) {
        logError("cashflow_sample_export_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to export sample dataset") });
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
        logError("cashflow_sample_import_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to load sample dataset") });
      }
    });

    app.post("/api/validate", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        res.json(validateCashflowData(userId));
      } catch (error) {
        logError("cashflow_validate_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to run validation") });
      }
    });

    app.post("/api/restore/:backupId", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const result = restoreBackup(userId, req.params.backupId);
        res.json({
          ...getSnapshot(userId),
          restore: result
        });
      } catch (error) {
        logError("cashflow_restore_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to restore backup") });
      }
    });
}

