import { t } from "./i18n.js";
import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";

const ENTITY_ROUTES = {
  "recurring-expense": "/api/recurring-expenses",
  flex: "/api/flex",
  goal: "/api/goals"
};

function PriorityRow({ item, onSaved, onEdit }) {
  const [value, setValue] = useState(String(item.priority ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const dirty = value !== String(item.priority ?? "");

  async function handleSave() {
    const priority = Number(value);
    if (!Number.isInteger(priority) || priority < 1) {
      setError(t("Priority must be a whole number of 1 or more"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const url = `${ENTITY_ROUTES[item.entityType]}/${encodeURIComponent(item.id)}`;
      await apiFetch(url, { method: "PUT", body: { priority } });
      await onSaved();
    } catch (err) {
      setError(err.message || t("Failed to save priority"));
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
      <td><span className="beta-pill beta-pill-muted">{t(item.label)}</span></td>
      <td>{item.name || t("Unnamed")}</td>
      <td className="beta-num">{formatMoney(item.amount, item.currency)}</td>
      <td>
        {dirty ? (
          <button type="button" className="beta-btn-small" disabled={saving} onClick={handleSave}>
            {saving ? "..." : t("Save")}
          </button>
        ) : null}
        <button type="button" className="beta-btn-small" onClick={() => onEdit(item)}>{t("Edit details")}</button>
        {error ? <span className="beta-inline-error">{error}</span> : null}
      </td>
    </tr>
  );
}

function PriorityTable({ items, emptyLabel, onSaved, onEdit }) {
  if (!items.length) return <p className="beta-empty">{emptyLabel}</p>;
  return (
    <div className="beta-panel-table">
      <table>
        <thead>
          <tr>
            <th className="beta-num">{t("Priority")}</th>
            <th>{t("Type")}</th>
            <th>{t("Name")}</th>
            <th className="beta-num">{t("Amount")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <PriorityRow key={`${item.entityType}:${item.id}`} item={item} onSaved={onSaved} onEdit={onEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrioritiesView({ snapshot, onRefresh }) {
  const [editing, setEditing] = useState(null);
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
        <h1>{t("Priorities")}</h1>
        <p>{t("Lower numbers fund first. Edit a number and save to reorder.")}</p>
      </div>

      <div className="beta-panel">
        <h3>{t("Operating priority")}</h3>
        <PriorityTable items={operating} emptyLabel={t("No recurring expenses or flex items yet.")} onSaved={onRefresh} onEdit={setEditing} />
      </div>

      <div className="beta-panel">
        <h3>{t("Goal priority")}</h3>
        <PriorityTable items={goals} emptyLabel={t("No goals yet.")} onSaved={onRefresh} onEdit={setEditing} />
      </div>
      {editing ? <EditModal
        entityType={editing.entityType}
        item={editing}
        recurringIncomes={snapshot?.recurringIncomes || []}
        settings={snapshot?.settings || {}}
        today={snapshot?.today}
        usedPriorities={editing.entityType === "goal" ? goals : operating}
        onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await onRefresh(); }}
      /> : null}
    </section>
  );
}
