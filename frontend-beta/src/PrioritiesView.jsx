import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";

const ENTITY_ROUTES = {
  "recurring-expense": "/api/recurring-expenses",
  flex: "/api/flex",
  goal: "/api/goals"
};

function PriorityRow({ item, onSaved }) {
  const [value, setValue] = useState(String(item.priority ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const dirty = value !== String(item.priority ?? "");

  async function handleSave() {
    const priority = Number(value);
    if (!Number.isInteger(priority) || priority < 1) {
      setError("Priority must be a whole number of 1 or more");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const url = `${ENTITY_ROUTES[item.entityType]}/${encodeURIComponent(item.id)}`;
      await apiFetch(url, { method: "PUT", body: { priority } });
      await onSaved();
    } catch (err) {
      setError(err.message || "Failed to save priority");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td className="beta-num">
        <input
          type="number"
          min="1"
          className="beta-priority-input"
          value={value}
          onChange={e => setValue(e.target.value)}
        />
      </td>
      <td><span className="beta-pill beta-pill-muted">{item.label}</span></td>
      <td>{item.name || "Unnamed"}</td>
      <td className="beta-num">{formatMoney(item.amount, item.currency)}</td>
      <td>
        {dirty ? (
          <button type="button" className="beta-btn-small" disabled={saving} onClick={handleSave}>
            {saving ? "..." : "Save"}
          </button>
        ) : null}
        {error ? <span className="beta-inline-error">{error}</span> : null}
      </td>
    </tr>
  );
}

function PriorityTable({ items, emptyLabel, onSaved }) {
  if (!items.length) return <p className="beta-empty">{emptyLabel}</p>;
  return (
    <div className="beta-panel-table">
      <table>
        <thead>
          <tr>
            <th className="beta-num">Priority</th>
            <th>Type</th>
            <th>Name</th>
            <th className="beta-num">Amount</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <PriorityRow key={`${item.entityType}:${item.id}`} item={item} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrioritiesView({ snapshot, onRefresh }) {
  const byPriority = (a, b) => (Number(a.priority) || 9999) - (Number(b.priority) || 9999);

  const operating = [
    ...(snapshot?.recurringExpenses || []).map(item => ({ ...item, entityType: "recurring-expense", label: "Recurring expense" })),
    ...(snapshot?.flexTransactions || []).map(item => ({ ...item, entityType: "flex", label: "Flex" }))
  ].sort(byPriority);

  const goals = (snapshot?.goals || [])
    .map(item => ({ ...item, entityType: "goal", label: "Goal" }))
    .sort(byPriority);

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Priorities</h1>
        <p>Lower numbers fund first. Edit a number and save to reorder.</p>
      </div>

      <div className="beta-panel">
        <h3>Operating priority</h3>
        <PriorityTable items={operating} emptyLabel="No recurring expenses or flex items yet." onSaved={onRefresh} />
      </div>

      <div className="beta-panel">
        <h3>Goal priority</h3>
        <PriorityTable items={goals} emptyLabel="No goals yet." onSaved={onRefresh} />
      </div>
    </section>
  );
}
