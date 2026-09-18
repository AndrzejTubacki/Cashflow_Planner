import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function EditModal({ entityType, item = null, onClose, onSaved, recurringIncomes = [] }) {
  const isCreate = !item;
  const source = item || {};
  const isRecurring = entityType === "recurring-expense" || entityType === "recurring-income";
  const [form, setForm] = useState(() => ({
    name: source.name ?? "",
    currency: source.currency ?? "PLN",
    amount: source.amount ?? "",
    active: source.active ?? true,
    priority: source.priority ?? "",
    necessary: source.necessary ?? true,
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
    anchor_holiday_country: source.anchor_holiday_country ?? "PL",
    anchor_income_id: source.anchor_income_id ?? "",
    due_date: source.due_date ?? todayIso(),
    allow_split: source.allow_split ?? false,
    min_amount: source.min_amount ?? "",
    max_amount: source.max_amount ?? "",
    type: source.type ?? "expense",
    date: source.date ?? todayIso()
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
    if (entityType === "pending") {
      body.name = form.name.trim() || "Unnamed";
      body.amount = Number(form.amount) || 0;
      body.date = form.date;
      return body;
    }

    body.name = form.name.trim() || "Unnamed";
    body.currency = form.currency;
    body.amount = Number(form.amount) || 0;

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
        body.min_amount = form.min_amount === "" ? null : Number(form.min_amount);
        body.max_amount = form.max_amount === "" ? null : Number(form.max_amount);
      }
      return body;
    }

    if (isRecurring) {
      body.prediction_strategy = form.prediction_strategy;
      body.prediction_substitute_missing = form.prediction_substitute_missing;
      body.prediction_min_recorded_months = Number(form.prediction_min_recorded_months) || 6;
      body.repeat_every_months = Number(form.repeat_every_months) || 1;
      body.start_month_year = form.start_month_year || null;
      body.anchor_type = form.anchor_type;
      body.anchor_day_of_month = form.anchor_type === "day_of_month" ? Number(form.anchor_day_of_month) || 1 : null;
      body.anchor_offset_days = Number(form.anchor_offset_days) || 0;
      body.anchor_business_day_adjustment = form.anchor_business_day_adjustment;
      body.anchor_holiday_country = form.anchor_holiday_country;
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
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="beta-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="beta-modal" role="dialog" aria-modal="true">
        <div className="beta-modal-head">
          <h2>{isCreate ? "Add" : "Edit"} {ENTITY_LABELS[entityType] || "item"}</h2>
          <button type="button" className="beta-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="beta-modal-form">
          {error ? <div className="beta-error">{error}</div> : null}

          {entityType === "pending" ? (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Name</span>
                <input type="text" value={form.name} onChange={e => set("name", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>Amount</span>
                <input type="number" step="0.01" value={form.amount} onChange={e => set("amount", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>Date</span>
                <input type="date" value={form.date} onChange={e => set("date", e.target.value)} required />
              </label>
            </div>
          ) : (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Name</span>
                <input type="text" value={form.name} onChange={e => set("name", e.target.value)} required />
              </label>
              <label className="beta-field">
                <span>Currency</span>
                <select value={form.currency} onChange={e => set("currency", e.target.value)}>
                  {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="beta-field">
                <span>Amount</span>
                <input type="number" step="0.01" min="0" value={form.amount} onChange={e => set("amount", e.target.value)} required />
              </label>

              {entityType === "one-off" ? (
                <>
                  <label className="beta-field">
                    <span>Type</span>
                    <select value={form.type} onChange={e => set("type", e.target.value)}>
                      <option value="expense">Expense</option>
                      <option value="income">Income</option>
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>Date</span>
                    <input type="date" value={form.date} onChange={e => set("date", e.target.value)} required />
                  </label>
                </>
              ) : null}

              {entityType === "goal" ? (
                <>
                  <label className="beta-field">
                    <span>Priority</span>
                    <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Due date</span>
                    <input type="date" value={form.due_date} onChange={e => set("due_date", e.target.value)} required />
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>Active</span>
                  </label>
                </>
              ) : null}

              {entityType === "flex" ? (
                <>
                  <label className="beta-field">
                    <span>Priority</span>
                    <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>Active</span>
                  </label>
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.allow_split} onChange={e => set("allow_split", e.target.checked)} />
                    <span>Allow split</span>
                  </label>
                  {form.allow_split ? (
                    <>
                      <label className="beta-field">
                        <span>Minimum</span>
                        <input type="number" step="0.01" min="0" value={form.min_amount} onChange={e => set("min_amount", e.target.value)} />
                      </label>
                      <label className="beta-field">
                        <span>Maximum</span>
                        <input type="number" step="0.01" min="0" value={form.max_amount} onChange={e => set("max_amount", e.target.value)} />
                      </label>
                    </>
                  ) : null}
                </>
              ) : null}

              {isRecurring ? (
                <>
                  <label className="beta-field">
                    <span>Prediction strategy</span>
                    <select value={form.prediction_strategy} onChange={e => set("prediction_strategy", e.target.value)}>
                      <option value="fixed">Fixed</option>
                      <option value={entityType === "recurring-expense" ? "12month_max" : "12month_min"}>
                        {entityType === "recurring-expense" ? "12-month maximum" : "12-month minimum"}
                      </option>
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>Substitute missing with</span>
                    <select value={form.prediction_substitute_missing} onChange={e => set("prediction_substitute_missing", e.target.value)}>
                      {PREDICTION_SUBSTITUTE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>Minimum recorded months</span>
                    <input type="number" min="1" max="12" value={form.prediction_min_recorded_months} onChange={e => set("prediction_min_recorded_months", e.target.value)} />
                  </label>
                  {entityType === "recurring-expense" ? (
                    <label className="beta-field">
                      <span>Follow income</span>
                      <select value={form.anchor_income_id} onChange={e => set("anchor_income_id", e.target.value)}>
                        <option value="">No &mdash; use a fixed anchor below</option>
                        {recurringIncomes.map(income => (
                          <option key={income.id} value={income.id}>{income.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!form.anchor_income_id ? (
                    <>
                      <label className="beta-field">
                        <span>Anchor</span>
                        <select value={form.anchor_type} onChange={e => set("anchor_type", e.target.value)}>
                          <option value="day_of_month">Day of month</option>
                          <option value="month_end">Month end</option>
                        </select>
                      </label>
                      {form.anchor_type === "day_of_month" ? (
                        <label className="beta-field">
                          <span>Day of month</span>
                          <input type="number" min="1" max="31" value={form.anchor_day_of_month} onChange={e => set("anchor_day_of_month", e.target.value)} />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  <label className="beta-field">
                    <span>{form.anchor_income_id ? "Days after income lands" : "Offset days"}</span>
                    <input type="number" step="1" value={form.anchor_offset_days} onChange={e => set("anchor_offset_days", e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Business day adjustment</span>
                    <select value={form.anchor_business_day_adjustment} onChange={e => set("anchor_business_day_adjustment", e.target.value)}>
                      <option value="none">None</option>
                      <option value="previous">Previous</option>
                      <option value="next">Next</option>
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>Holiday country</span>
                    <select value={form.anchor_holiday_country} onChange={e => set("anchor_holiday_country", e.target.value)}>
                      {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} - {c.label}</option>)}
                    </select>
                  </label>
                  <label className="beta-field">
                    <span>Repeat every X months</span>
                    <input type="number" min="1" max="12" value={form.repeat_every_months} onChange={e => set("repeat_every_months", e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Start YYYY-MM</span>
                    <input type="text" placeholder="2026-05" value={form.start_month_year} onChange={e => set("start_month_year", e.target.value)} />
                  </label>

                  {entityType === "recurring-expense" ? (
                    <>
                      <label className="beta-field">
                        <span>Priority</span>
                        <input type="number" min="1" value={form.priority} onChange={e => set("priority", e.target.value)} />
                      </label>
                      <label className="beta-field beta-field-checkbox">
                        <input type="checkbox" checked={form.necessary} onChange={e => set("necessary", e.target.checked)} />
                        <span>Necessary</span>
                      </label>
                    </>
                  ) : (
                    <label className="beta-field beta-field-checkbox">
                      <input type="checkbox" checked={form.period_setting} onChange={e => set("period_setting", e.target.checked)} />
                      <span>Defines budget period</span>
                    </label>
                  )}
                  <label className="beta-field beta-field-checkbox">
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span>Active</span>
                  </label>
                </>
              ) : null}
            </div>
          )}

          <div className="beta-form-actions">
            <button type="button" className="beta-btn-small" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="beta-btn-primary" disabled={saving}>
              {saving ? "Saving..." : isCreate ? "Add" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
