import { useRef, useState } from "react";
import { apiFetch, downloadFile } from "./api.js";
import {
  FX_PROVIDER_OPTIONS,
  HOLIDAY_COUNTRIES,
  NOTIFICATION_PRIORITY_OPTIONS,
  NOTIFICATION_TYPES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";

function ManualFxRates({ currencies, rates, ledgerCurrency, onChange }) {
  if (!currencies.length) {
    return <p className="beta-hint">Select at least one used currency to enter manual rates.</p>;
  }
  return (
    <div className="beta-form-grid">
      {currencies.map(currency => (
        <label className="beta-field" key={currency}>
          <span>{currency} / {ledgerCurrency}</span>
          <input
            type="number"
            min="0.000001"
            step="0.000001"
            placeholder="1.000000"
            value={rates[currency] ?? ""}
            onChange={e => onChange(currency, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

function DataPortabilityPanel({ onRefresh }) {
  const [includeOperational, setIncludeOperational] = useState(false);
  const [importOperational, setImportOperational] = useState(false);
  const [importMode, setImportMode] = useState("replace");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const fullImportRef = useRef(null);
  const csvImportRef = useRef(null);

  async function withBusy(key, fn) {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy("");
    }
  }

  function describePreview(preview) {
    const lines = [];
    if (preview?.rowCounts) {
      lines.push("Rows: " + Object.entries(preview.rowCounts).map(([k, v]) => `${k}=${v}`).join(", "));
    }
    if (preview?.settingsChanges?.length) {
      lines.push(`Settings changes: ${preview.settingsChanges.length}`);
    }
    if (preview?.mergeConflicts?.length) {
      lines.push(`Merge conflicts: ${preview.mergeConflicts.length}`);
    }
    lines.push("Proceed with this import?");
    return lines.join("\n");
  }

  return (
    <div className="beta-panel">
      <h3>Data portability</h3>
      {error ? <div className="beta-error">{error}</div> : null}

      <div className="beta-form-actions beta-form-actions-start">
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "export"}
          onClick={() => withBusy("export", () => downloadFile(
            includeOperational ? "/api/export/full?includeOperationalSettings=1" : "/api/export/full",
            "cashflow-full-export.json"
          ))}
        >
          Download full export
        </button>
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "csv"}
          onClick={() => withBusy("csv", () => downloadFile("/api/export/confirmed-ledger.csv", "cashflow-confirmed-ledger.csv"))}
        >
          Download confirmed ledger CSV
        </button>
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "sample"}
          onClick={() => withBusy("sample", () => downloadFile("/api/export/sample", "cashflow-sample-dataset.json"))}
        >
          Download sample dataset
        </button>
      </div>

      <label className="beta-field beta-field-checkbox">
        <input type="checkbox" checked={includeOperational} onChange={e => setIncludeOperational(e.target.checked)} />
        <span>Include operational settings in full export</span>
      </label>

      <div className="beta-form-grid">
        <label className="beta-field">
          <span>Full import file</span>
          <input type="file" accept="application/json,.json" ref={fullImportRef} />
        </label>

        <label className="beta-field">
          <span>Full import mode</span>
          <select value={importMode} onChange={e => setImportMode(e.target.value)}>
            <option value="replace">Replace after backup</option>
            <option value="merge">Merge</option>
          </select>
        </label>
      </div>

      <label className="beta-field beta-field-checkbox">
        <input type="checkbox" checked={importOperational} onChange={e => setImportOperational(e.target.checked)} />
        <span>Include operational settings during full import</span>
      </label>

      <div className="beta-form-actions beta-form-actions-start">
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "import"}
          onClick={() => withBusy("import", async () => {
            const file = fullImportRef.current?.files?.[0];
            if (!file) throw new Error("Choose a full export file first.");
            const text = await file.text();
            const exportData = JSON.parse(text);
            const requestBody = { mode: importMode, export: exportData, includeOperationalSettings: importOperational };
            const preview = await apiFetch("/api/import/full/preview", { method: "POST", body: requestBody });
            if (!window.confirm(describePreview(preview))) return;
            await apiFetch("/api/import/full", { method: "POST", body: requestBody });
            await onRefresh();
          })}
        >
          {busy === "import" ? "Importing..." : "Import full export"}
        </button>
      </div>

      <label className="beta-field">
        <span>One-off CSV file</span>
        <input type="file" accept="text/csv,.csv" ref={csvImportRef} />
        <small className="beta-hint">CSV columns: name,type,amount,currency,date</small>
      </label>

      <div className="beta-form-actions beta-form-actions-start">
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "csv-import"}
          onClick={() => withBusy("csv-import", async () => {
            const file = csvImportRef.current?.files?.[0];
            if (!file) throw new Error("Choose a one-off CSV file first.");
            const mode = window.confirm("Replace unconfirmed one-off transactions before importing? Cancel appends instead.")
              ? "replace"
              : "append";
            const csv = await file.text();
            await apiFetch("/api/import/one-offs-csv", { method: "POST", body: { mode, csv } });
            await onRefresh();
          })}
        >
          Import one-off CSV
        </button>
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy === "load-sample"}
          onClick={() => {
            if (!window.confirm("Load sample dataset? Current data will be replaced after a safety backup.")) return;
            withBusy("load-sample", async () => {
              await apiFetch("/api/import/sample", { method: "POST" });
              await onRefresh();
            });
          }}
        >
          Load sample dataset
        </button>
      </div>
    </div>
  );
}

export default function SettingsView({ snapshot, onRefresh }) {
  const settings = snapshot?.settings || {};
  const canMaintain = (snapshot?.session?.capabilities || []).includes("budget:maintain");
  const ledgerCurrencyInitial = String(settings.ledger_currency || "PLN").toUpperCase();

  const [ledgerCurrency, setLedgerCurrency] = useState(ledgerCurrencyInitial);
  const [timezone, setTimezone] = useState(settings.timezone || "Europe/Warsaw");
  const [holidayCountry, setHolidayCountry] = useState(String(settings.holiday_country || "PL").toUpperCase());
  const [fxBufferPercent, setFxBufferPercent] = useState(settings.fx_buffer_percent ?? 0);
  const [fxProvider, setFxProvider] = useState(settings.fx_provider || "nbp");
  const [fxCurrencies, setFxCurrencies] = useState(() => {
    try {
      const parsed = typeof settings.fx_used_currencies === "string"
        ? JSON.parse(settings.fx_used_currencies)
        : settings.fx_used_currencies;
      return Array.isArray(parsed) ? parsed.filter(c => c !== ledgerCurrencyInitial) : [];
    } catch {
      return [];
    }
  });
  const [manualRates, setManualRates] = useState(() => {
    try {
      const parsed = typeof settings.manual_fx_rates === "string"
        ? JSON.parse(settings.manual_fx_rates)
        : settings.manual_fx_rates;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });

  const [budgetPeriodIncomeId, setBudgetPeriodIncomeId] = useState(settings.budget_period_income_id || "");
  const [futurePeriods, setFuturePeriods] = useState(settings.future_periods ?? 11);
  const [minReserveEnabled, setMinReserveEnabled] = useState(Number(settings.minimum_reserve_enabled) === 1);
  const [minReserveAmount, setMinReserveAmount] = useState(settings.minimum_reserve_amount ?? 0);
  const [compactionMonths, setCompactionMonths] = useState(settings.ledger_history_compaction_months ?? 0);

  const [notificationChannel, setNotificationChannel] = useState(settings.notification_channel || "ntfy");
  const [ntfyUrl, setNtfyUrl] = useState(settings.ntfy_url || "");
  const [ntfyAuthToken, setNtfyAuthToken] = useState(settings.ntfy_auth_token || "");
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState(settings.discord_webhook_url || "");
  const [deliveryTime, setDeliveryTime] = useState(settings.notification_delivery_time || "08:00");
  const [repeatDays, setRepeatDays] = useState(settings.necessary_underfunded_repeat_days ?? 1);
  const [notifyToggles, setNotifyToggles] = useState(() => Object.fromEntries(
    NOTIFICATION_TYPES.map(n => [n.key, Number(settings[`notify_${n.key}`]) === 1])
  ));
  const [notifyPriorities, setNotifyPriorities] = useState(() => Object.fromEntries(
    NOTIFICATION_TYPES.map(n => [n.key, settings[`ntfy_priority_${n.key}`] || "default"])
  ));

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fxRefreshing, setFxRefreshing] = useState(false);
  const [compacting, setCompacting] = useState(false);

  const availableCurrencies = SUPPORTED_FX_CURRENCIES.filter(c => c !== ledgerCurrency && !fxCurrencies.includes(c));
  const fxAvailableRef = useRef(null);
  const fxSelectedRef = useRef(null);

  function toggleFxCurrency(currency, add) {
    setFxCurrencies(prev => add ? [...prev, currency] : prev.filter(c => c !== currency));
  }

  function moveFxCurrencies(fromRef, add) {
    const picked = [...(fromRef.current?.selectedOptions || [])].map(o => o.value);
    picked.forEach(c => toggleFxCurrency(c, add));
  }

  function setManualRate(currency, value) {
    setManualRates(prev => ({ ...prev, [currency]: value }));
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const manualRatesPayload = Object.fromEntries(
        Object.entries(manualRates)
          .map(([currency, value]) => [currency, Number(value)])
          .filter(([, value]) => Number.isFinite(value) && value > 0)
      );

      await apiFetch("/api/settings", {
        method: "PUT",
        body: {
          ledger_currency: ledgerCurrency,
          timezone,
          holiday_country: holidayCountry,
          fx_buffer_percent: Number(fxBufferPercent) || 0,
          fx_provider: fxProvider,
          fx_used_currencies: fxCurrencies,
          manual_fx_rates: manualRatesPayload,
          budget_period_income_id: budgetPeriodIncomeId || null,
          future_periods: Number(futurePeriods) || 11,
          minimum_reserve_enabled: minReserveEnabled ? 1 : 0,
          minimum_reserve_amount: Number(minReserveAmount) || 0,
          ledger_history_compaction_months: Number(compactionMonths) || 0,
          notification_channel: notificationChannel,
          ntfy_url: ntfyUrl,
          ntfy_auth_token: ntfyAuthToken,
          discord_webhook_url: discordWebhookUrl,
          notification_delivery_time: deliveryTime,
          necessary_underfunded_repeat_days: Number(repeatDays) || 1,
          ...Object.fromEntries(NOTIFICATION_TYPES.map(n => [`notify_${n.key}`, notifyToggles[n.key] ? 1 : 0])),
          ...Object.fromEntries(NOTIFICATION_TYPES.map(n => [`ntfy_priority_${n.key}`, notifyPriorities[n.key]]))
        }
      });
      setMessage("Settings saved.");
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshFx() {
    setFxRefreshing(true);
    setError("");
    try {
      await apiFetch("/api/fx/refresh", { method: "POST" });
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to refresh FX rates");
    } finally {
      setFxRefreshing(false);
    }
  }

  async function handleCompact() {
    if (!window.confirm("Compact old confirmed ledger rows? A safety backup will be created first.")) return;
    setCompacting(true);
    setError("");
    try {
      await apiFetch("/api/ledger/compact-history", { method: "POST", body: { months: Number(compactionMonths) || 0 } });
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to compact ledger history");
    } finally {
      setCompacting(false);
    }
  }

  const fxProviderNote = FX_PROVIDER_OPTIONS.find(p => p.id === fxProvider)?.note || "";

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Settings</h1>
        <p>Preferences for this budget.</p>
      </div>

      <p className="beta-hint">
        Looking for Theme or Density? They moved to the account menu in the top-right corner.
      </p>

      {message ? <div className="beta-success">{message}</div> : null}
      {error ? <div className="beta-error">{error}</div> : null}

      <form className="beta-panel" onSubmit={handleSave}>
        <details className="beta-details" open>
          <summary>Currency &amp; Exchange</summary>
          <div className="beta-settings-section">
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Ledger currency</span>
                <select value={ledgerCurrency} onChange={e => setLedgerCurrency(e.target.value)}>
                  {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="beta-field">
                <span>Timezone</span>
                <input type="text" value={timezone} onChange={e => setTimezone(e.target.value)} list="beta-timezones" />
                <datalist id="beta-timezones">
                  {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz} />)}
                </datalist>
              </label>
              <label className="beta-field">
                <span>Default holiday country</span>
                <select value={holidayCountry} onChange={e => setHolidayCountry(e.target.value)}>
                  {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} - {c.label}</option>)}
                </select>
              </label>
              <label className="beta-field">
                <span>FX buffer (%)</span>
                <input type="number" min="0" max="100" step="0.5" value={fxBufferPercent} onChange={e => setFxBufferPercent(e.target.value)} />
              </label>
              <label className="beta-field">
                <span>FX provider</span>
                <select value={fxProvider} onChange={e => setFxProvider(e.target.value)}>
                  {FX_PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <small className="beta-hint">{fxProviderNote}</small>
              </label>
            </div>

            <div className="beta-fx-currency-picker">
              <div>
                <span className="beta-fx-picker-label">Available currencies</span>
                <select multiple size="8" className="beta-fx-picker-select" ref={fxAvailableRef}>
                  {availableCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="beta-fx-picker-controls">
                <button type="button" className="beta-btn-small" onClick={() => moveFxCurrencies(fxAvailableRef, true)}>
                  &gt;
                </button>
                <button type="button" className="beta-btn-small" onClick={() => moveFxCurrencies(fxSelectedRef, false)}>
                  &lt;
                </button>
              </div>
              <div>
                <span className="beta-fx-picker-label">Used currencies</span>
                <select multiple size="8" className="beta-fx-picker-select" ref={fxSelectedRef}>
                  {fxCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <ManualFxRates currencies={fxCurrencies} rates={manualRates} ledgerCurrency={ledgerCurrency} onChange={setManualRate} />

            {canMaintain ? (
              <div className="beta-form-actions beta-form-actions-start">
                <button type="button" className="beta-btn-small" disabled={fxRefreshing} onClick={handleRefreshFx}>
                  {fxRefreshing ? "Refreshing..." : "Refresh FX rates"}
                </button>
              </div>
            ) : null}
          </div>
        </details>

        <details className="beta-details">
          <summary>Budget period</summary>
          <div className="beta-settings-section">
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Budget period income</span>
                <select value={budgetPeriodIncomeId} onChange={e => setBudgetPeriodIncomeId(e.target.value)}>
                  <option value="">Calendar month</option>
                  {(snapshot?.recurringIncomes || []).map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.active ? "" : " (Inactive)"}</option>
                  ))}
                </select>
              </label>
              <label className="beta-field">
                <span>Periods to generate</span>
                <input type="number" min="1" max="60" value={futurePeriods} onChange={e => setFuturePeriods(e.target.value)} />
              </label>
              <label className="beta-field beta-field-checkbox">
                <input type="checkbox" checked={minReserveEnabled} onChange={e => setMinReserveEnabled(e.target.checked)} />
                <span>Protect minimum reserve</span>
              </label>
              <label className="beta-field">
                <span>Minimum reserve</span>
                <input type="number" step="0.01" value={minReserveAmount} onChange={e => setMinReserveAmount(e.target.value)} />
              </label>
              <label className="beta-field">
                <span>Ledger history compaction (months)</span>
                <input type="number" min="0" max="600" value={compactionMonths} onChange={e => setCompactionMonths(e.target.value)} />
                <small className="beta-hint">Use 0 to keep detailed ledger history forever.</small>
              </label>
            </div>
            {canMaintain ? (
              <div className="beta-form-actions beta-form-actions-start">
                <button type="button" className="beta-btn-small" disabled={compacting} onClick={handleCompact}>
                  {compacting ? "Compacting..." : "Compact ledger history now"}
                </button>
              </div>
            ) : null}
          </div>
        </details>

        <details className="beta-details">
          <summary>Notifications</summary>
          <div className="beta-settings-section">
            <p className="beta-hint">Cashflow checks the ledger and sends queued notifications at the same profile-local time.</p>
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Notification service</span>
                <select value={notificationChannel} onChange={e => setNotificationChannel(e.target.value)}>
                  <option value="ntfy">ntfy</option>
                  <option value="discord">Discord</option>
                </select>
              </label>
              <label className="beta-field">
                <span>Full ntfy URL</span>
                <input type="url" value={ntfyUrl} onChange={e => setNtfyUrl(e.target.value)} placeholder="https://ntfy.example.com/topic" />
              </label>
              <label className="beta-field">
                <span>ntfy access token</span>
                <input type="text" autoComplete="off" value={ntfyAuthToken} onChange={e => setNtfyAuthToken(e.target.value)} placeholder="tk_..." />
              </label>
              <label className="beta-field">
                <span>Discord webhook URL</span>
                <input type="url" value={discordWebhookUrl} onChange={e => setDiscordWebhookUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
              </label>
              <label className="beta-field">
                <span>Ledger check and notification time</span>
                <input type="time" value={deliveryTime} onChange={e => setDeliveryTime(e.target.value)} />
              </label>
              <label className="beta-field">
                <span>Repeat necessary-underfunded every X days</span>
                <input type="number" min="1" value={repeatDays} onChange={e => setRepeatDays(e.target.value)} />
              </label>
            </div>

            <div className="beta-notification-rows">
              {NOTIFICATION_TYPES.map(n => (
                <div className="beta-notification-row" key={n.key}>
                  <label className="beta-field beta-field-checkbox">
                    <input
                      type="checkbox"
                      checked={notifyToggles[n.key]}
                      onChange={e => setNotifyToggles(prev => ({ ...prev, [n.key]: e.target.checked }))}
                    />
                    <span>{n.label}</span>
                  </label>
                  <label className="beta-field beta-field-inline">
                    <span>ntfy priority</span>
                    <select
                      value={notifyPriorities[n.key]}
                      onChange={e => setNotifyPriorities(prev => ({ ...prev, [n.key]: e.target.value }))}
                    >
                      {NOTIFICATION_PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                </div>
              ))}
            </div>
          </div>
        </details>

        <div className="beta-form-actions">
          <button type="submit" className="beta-btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>

      <DataPortabilityPanel onRefresh={onRefresh} />
    </section>
  );
}
