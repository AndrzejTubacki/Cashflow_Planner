import { t } from "./i18n.js";
import { todayIso } from "./format.js";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { lowestUnusedPriority, normalizeDecimalInput } from "./parity.js";
import {
  HOLIDAY_COUNTRIES,
  PREDICTION_SUBSTITUTE_OPTIONS,
  SUPPORTED_FX_CURRENCIES
} from "./constants.js";

const ROUTES = {
  "recurring-expense": "/api/recurring-expenses",
  "recurring-income": "/api/recurring-incomes",
  goal: "/api/goals",
  flex: "/api/flex",
  "one-off": "/api/one-off",
  pending: "/api/pending"
};

const ENTITY_LABELS = {
  "recurring-expense": "recurring expense",
  "recurring-income": "recurring income",
  goal: "goal",
  flex: "flex",
  "one-off": "transaction",
  pending: "pending transaction"
};


export default function EditModal({ entityType, item = null, onClose, onSaved, recurringIncomes = [], settings = {}, today, usedPriorities = [] }) {
  const isCreate = !item;
  const source = item || {};
  const isRecurring = entityType === "recurring-expense" || entityType === "recurring-income";
  const [form, setForm] = useState(() => ({
    name: source.name ?? "",
    currency: source.currency ?? "PLN",
    amount: source.amount ?? "",
    active: source.active ?? true,
    priority: source.priority ?? (isCreate && ["goal", "flex", "recurring-expense"].includes(entityType) ? lowestUnusedPriority(usedPriorities) : ""),
    necessary: source.necessary ?? false,
    period_setting: source.period_setting ?? false,
    prediction_strategy: source.prediction_strategy ?? "fixed",
    prediction_substitute_missing: source.prediction_substitute_missing ?? "none",
    prediction_min_recorded_months: source.prediction_min_recorded_months ?? 6,
    repeat_every_months: source.repeat_every_months ?? 1,
    start_month_year: source.start_month_year ?? "",
    anchor_type: source.anchor_type ?? "month_end",
    anchor_day_of_month: source.anchor_day_of_month ?? 1,
    anchor_offset_days: source.anchor_offset_days ?? 0,
    anchor_business_day_adjustment: source.anchor_business_day_adjustment ?? "none",
    anchor_holiday_country: String(source.anchor_holiday_country ?? settings.holiday_country ?? "PL").toUpperCase(),
    anchor_income_id: source.anchor_income_id ?? "",
    due_date: source.due_date ?? today ?? todayIso(),
    allow_split: source.allow_split ?? false,
    min_amount: source.min_amount ?? "",
    max_amount: source.max_amount ?? "",
    type: source.type ?? "expense",
    date: source.date ?? today ?? todayIso()
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const usesPredictionHistory = form.prediction_strategy === "12month_min" || form.prediction_strategy === "12month_max";
  const usesMinimumHistory = usesPredictionHistory && form.prediction_substitute_missing === "require_min_recorded_months";
  const repeatNeedsStart = Number(form.repeat_every_months) > 1;
  const usesMonthEndOptions = Boolean(form.anchor_income_id) || form.anchor_type === "month_end";
  const usesHolidayCalendar = usesMonthEndOptions && form.anchor_business_day_adjustment !== "none";

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function buildBody() {
    const body = {};
    const amount = normalizeDecimalInput(form.amount);
    if (amount === null) throw new Error(t("Enter a valid amount with no more than two decimal places."));
    if (entityType === "pending") {
      body.name = form.name.trim() || "Unnamed";
      body.amount = amount;
      body.date = form.date;
      return body;
    }

    body.name = form.name.trim() || "Unnamed";
    body.currency = form.currency;
    body.amount = amount;

    if (entityType === "one-off") {
      body.type = form.type;
      body.date = form.date;
      return body;
    }

    body.active = Boolean(form.active);

    if (entityType === "goal") {
      body.priority = Number(form.priority) || 1;
      body.due_date = form.due_date;
      return body;
    }

    if (entityType === "flex") {
      body.priority = Number(form.priority) || 1;
      body.allow_split = Boolean(form.allow_split);
      if (form.allow_split) {
        body.min_amount = form.min_amount === "" ? null : normalizeDecimalInput(form.min_amount);
        body.max_amount = form.max_amount === "" ? null : normalizeDecimalInput(form.max_amount);
        if (body.min_amount === null || body.max_amount === null) throw new Error(t("Enter valid minimum and maximum amounts with no more than two decimal places."));
      }
      return body;
    }

    if (isRecurring) {
      body.prediction_strategy = form.prediction_strategy;
      if (usesPredictionHistory) body.prediction_substitute_missing = form.prediction_substitute_missing;
      if (usesMinimumHistory) body.prediction_min_recorded_months = Number(form.prediction_min_recorded_months) || 6;
      body.repeat_every_months = Number(form.repeat_every_months) || 1;
      if (repeatNeedsStart) body.start_month_year = form.start_month_year;
      body.anchor_type = form.anchor_type;
      if (!form.anchor_income_id && form.anchor_type === "day_of_month") {
        body.anchor_day_of_month = Number(form.anchor_day_of_month) || 1;
      }
      if (usesMonthEndOptions) {
        body.anchor_offset_days = Number(form.anchor_offset_days) || 0;
        body.anchor_business_day_adjustment = form.anchor_business_day_adjustment;
      }
      if (usesHolidayCalendar) body.anchor_holiday_country = form.anchor_holiday_country;
      if (entityType === "recurring-expense") {
        body.necessary = Boolean(form.necessary);
        body.priority = Number(form.priority) || 1;
        body.anchor_income_id = form.anchor_income_id || null;
      } else {
        body.period_setting = Boolean(form.period_setting);
      }
      return body;
    }

    return body;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isCreate) {
        await apiFetch(ROUTES[entityType], { method: "POST", body: buildBody() });
      } else {
        await apiFetch(`${ROUTES[entityType]}/${encodeURIComponent(item.id)}`, {
          method: "PUT",
          body: buildBody()
        });
      }
      await onSaved();
    } catch (err) {
      setError(err.message || t("Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="beta-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="beta-modal" role="dialog" aria-modal="true">
        <div className="beta-modal-head">
          <h2>{isCreate ? t("Add") : t("Edit")} {t(ENTITY_LABELS[entityType] || "item")}</h2>
          <button type="button" className="beta-modal-close" onClick={onClose} aria-label={t("Close")}>&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="beta-modal-form">
          {error ? <div className="beta-error">{error}</div> : null}

          {entityType === "pending" ? (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>{t("Name")}</span>
                <input type="text" value={form.name} onChange={e => set("name", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>{t("Amount")}</span>
                <input type="text" inputMode="decimal" value={form.amount} onChange={e => set("amount", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>{t("Date")}</span>
                <input type="date" value={form.date} onChange={e => set("date", e.target.value)} required />
              </label>
            </div>
          ) : (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>{t("Name")}</span>
                <input type="text" value={form.name} onChange={e => set("name", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>{t("Currency")}</span>
                <select value={form.currency} onChange={e => set("currency", e.target.value)}>
                  {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="beta-field">
                <span>{t("Amount")}</span>
                <input type="text" inputMode="decimal" value={form.amount} onChange={e => set("amount", e.target.value)} required />
              </label>

              {entityType === "one-off" ? (
                <>
                  <label className="beta-field">
                    <span>{t("Type")}</span>
                    <select value={form.type} onChange={e => set("type", e.target.value)}>
                      <option value="expense">{t("Expense")}</option>
                      <option value="income">{t("Income")}</option>
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>{t("Date")}</span>
                    <input type="date" value={form.date} onChange={e => set("date", e.target.value)} required />
                  </label>
                </>
              ) : null}

              {entityType === "goal" ? (
                <>
                  <label className="beta-field">
                    <span>{t("Priority")}</span>
                    <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>{t("Due date")}</span>
                    <input type="date" value={form.due_date} onChange={e => set("due_date", e.target.value)} required />
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>{t("Active")}</span>
                  </label>
                </>
              ) : null}

              {entityType === "flex" ? (
                <>
                  <label className="beta-field">
                    <span>{t("Priority")}</span>
                    <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>{t("Active")}</span>
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.allow_split} onChange={e => set("allow_split", e.target.checked)} />
                    <span>{t("Allow split")}</span>
                  </label>
                  {form.allow_split ? (
                    <>
                      <label className="beta-field">
                        <span>{t("Minimum")}</span>
                        <input type="text" inputMode="decimal" value={form.min_amount} onChange={e => set("min_amount", e.target.value)} />
                      </label>
                      <label className="beta-field">
                        <span>{t("Maximum")}</span>
                        <input type="text" inputMode="decimal" value={form.max_amount} onChange={e => set("max_amount", e.target.value)} />
                      </label>
                    </>
                  ) : null}
                </>
              ) : null}

              {isRecurring ? (
                <>
                  <label className="beta-field">
                    <span>{t("Prediction strategy")}</span>
                    <select value={form.prediction_strategy} onChange={e => set("prediction_strategy", e.target.value)}>
                      <option value="fixed">{t("Fixed")}</option>
                      <option value={entityType === "recurring-expense" ? "12month_max" : "12month_min"}>
                        {entityType === "recurring-expense" ? t("12-month maximum") : t("12-month minimum")}
                      </option>
                    </select>
                  </label>
                  {usesPredictionHistory ? (
                    <label className="beta-field">
                      <span>{t("Substitute missing with")}</span>
                      <select value={form.prediction_substitute_missing} onChange={e => set("prediction_substitute_missing", e.target.value)}>
                        {PREDICTION_SUBSTITUTE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {usesMinimumHistory ? (
                    <label className="beta-field">
                      <span>{t("Minimum recorded months")}</span>
                      <input type="number" min="1" max="12" value={form.prediction_min_recorded_months} onChange={e => set("prediction_min_recorded_months", e.target.value)} />
                    </label>
                  ) : null}
                  {entityType === "recurring-expense" ? (
                    <label className="beta-field">
                      <span>{t("Follow income")}</span>
                      <select value={form.anchor_income_id} onChange={e => set("anchor_income_id", e.target.value)}>
                        <option value="">{t("No — use a fixed anchor below")}</option>
                        {recurringIncomes.map(income => (
                          <option key={income.id} value={income.id}>{income.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!form.anchor_income_id ? (
                    <>
                      <label className="beta-field">
                        <span>{t("Anchor")}</span>
                        <select value={form.anchor_type} onChange={e => set("anchor_type", e.target.value)}>
                          <option value="day_of_month">{t("Day of month")}</option>
                          <option value="month_end">{t("Month end")}</option>
                        </select>
                      </label>
                      {form.anchor_type === "day_of_month" ? (
                        <label className="beta-field">
                          <span>{t("Day of month")}</span>
                          <input type="number" min="1" max="31" value={form.anchor_day_of_month} onChange={e => set("anchor_day_of_month", e.target.value)} />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  {usesMonthEndOptions ? (
                    <>
                      <label className="beta-field">
                        <span>{form.anchor_income_id ? t("Days after income lands") : t("Offset days")}</span>
                        <input type="number" step="1" value={form.anchor_offset_days} onChange={e => set("anchor_offset_days", e.target.value)} />
                      </label>
                      <label className="beta-field">
                        <span>{t("Business day adjustment")}</span>
                        <select value={form.anchor_business_day_adjustment} onChange={e => set("anchor_business_day_adjustment", e.target.value)}>
                          <option value="none">{t("None")}</option>
                          <option value="previous">{t("Previous")}</option>
                          <option value="next">{t("Next")}</option>
                        </select>
                      </label>
                    </>
                  ) : null}
                  {usesHolidayCalendar ? (
                    <label className="beta-field">
                      <span>{t("Holiday country")}</span>
                      <select value={form.anchor_holiday_country} onChange={e => set("anchor_holiday_country", e.target.value)}>
                        {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} - {t(c.label)}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <label className="beta-field">
                    <span>{t("Repeat every X months")}</span>
                    <input type="number" min="1" max="12" value={form.repeat_every_months} onChange={e => set("repeat_every_months", e.target.value)} />
                  </label>
                  {repeatNeedsStart ? (
                    <label className="beta-field">
                      <span>{t("Start YYYY-MM")}</span>
                      <input
                        type="text"
                        placeholder={t("2026-05")}
                        pattern="[0-9]{4}-(0[1-9]|1[0-2])"
                        value={form.start_month_year}
                        onChange={e => set("start_month_year", e.target.value)}
                        required
                      />
                    </label>
                  ) : null}

                  {entityType === "recurring-expense" ? (
                    <>
                      <label className="beta-field">
                        <span>{t("Priority")}</span>
                        <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                      </label>
                      <label className="beta-field beta-field-checkbox">
                        <input type="checkbox" checked={form.necessary} onChange={e => set("necessary", e.target.checked)} />
                        <span>{t("Necessary")}</span>
                      </label>
                    </>
                  ) : (
                    <label className="beta-field beta-field-checkbox">
                      <input type="checkbox" checked={form.period_setting} onChange={e => set("period_setting", e.target.checked)} />
                      <span>{t("Defines budget period")}</span>
                    </label>
                  )}
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>{t("Active")}</span>
                  </label>
                </>
              ) : null}
            </div>
          )}

          <div className="beta-form-actions">
            <button type="button" className="beta-btn-small" onClick={onClose} disabled={saving}>{t("Cancel")}</button>
            <button type="submit" className="beta-btn-primary" disabled={saving}>
              {saving ? t("Saving...") : isCreate ? t("Add") : t("Save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
