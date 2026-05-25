import { cashflowErrorMessage } from "./cashflow-error-utils.js";

export function registerCashflowRoutes(app, {
  appVersion = "0.0.0",
  collectCurrenciesForFxSnapshot,
  confirmPendingTransaction,
  createBackup,
  createFlexTransaction,
  createGoal,
  createOneOffTransaction,
  createRecurringExpense,
  createRecurringIncome,
  deleteFlexTransaction,
  deleteGoal,
  deleteOneOffTransaction,
  deleteRecurringExpense,
  deleteRecurringIncome,
  ensureFxCacheForMutation,
  fetchNbpFxSnapshot,
  fetchNbpRate,
  getCachedFxSnapshot,
  getSnapshot,
  listAvailableLocales = () => [{ id: "en", label: "English" }],
  logCashflowError,
  logError,
  moveFutureTransactionToPending,
  openPlanningDb,
  recordProjectionFailure,
  refreshNbpFxCacheForAllUsers,
  regenerateProjectionsWithFxRefresh,
  resolveRequestUser,
  restoreBackup,
  safeGetCurrentFxSnapshot,
  updateFlexTransaction,
  updateGoal,
  updateOneOffTransaction,
  updatePendingTransaction,
  updateRecurringExpense,
  updateRecurringIncome,
  updateSettings,
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

    app.get("/api", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const snapshot = getSnapshot(userId);
        res.json({
          app: {
            name: "cashflow",
            version: appVersion
          },
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
      try {
        const rate = await fetchNbpRate(req.params.currency);
        res.json(rate);
      } catch (error) {
        logError("cashflow_nbp_fx_current_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      }
    });

    app.get("/api/fx/nbp/:currency/:date", async (req, res) => {
      try {
        const rate = await fetchNbpRate(req.params.currency, req.params.date);
        res.json(rate);
      } catch (error) {
        logError("cashflow_nbp_fx_historical_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      }
    });

    app.get("/api/fx/nbp-snapshot", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const currencies = collectCurrenciesForFxSnapshot(userId);
        const snapshot = await fetchNbpFxSnapshot(currencies, req.query.date || null);
        res.json(snapshot);
      } catch (error) {
        logError("cashflow_nbp_fx_snapshot_failed", error);
        res.status(500).json({ error: await apiErrorMessage(req, error, "Failed to fetch FX rates") });
      }
    });

    app.put("/api/settings", async (req, res) => {
      try {
        const userId = resolveRequestUser(req);
        const updated = updateSettings(userId, req.body);

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

