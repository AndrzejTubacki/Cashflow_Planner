import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { t } from "./i18n.js";

export default function DevicesPanel() {
  const [devices, setDevices] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [selected, setSelected] = useState([]);
  const [writeSelected, setWriteSelected] = useState([]);
  // Separate, default-off consent: the device may create budgets owned by this account.
  const [mayCreate, setMayCreate] = useState(false);
  const [code, setCode] = useState("");
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const [deviceResult, budgetResult] = await Promise.all([
      apiFetch("/api/account/devices", { scoped: false }),
      apiFetch("/api/budgets", { scoped: false })
    ]);
    setDevices(deviceResult.devices);
    setBudgets(budgetResult.budgets || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function perform(work) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="beta-panel beta-settings-section" data-device-panel>
    <h3>{t("Connected devices")}</h3>
    <p className="beta-hint">{t("Devices download selected budgets. Financial synchronization requires separate write approval for each budget. Revoking access does not erase offline copies.")}</p>
    <p className="beta-hint">{t("Sign in again before approving a device. Approval requires a verified sign-in within five minutes.")}</p>
    {error && <div className="beta-error" role="alert">{error}</div>}
    {message && <div className="beta-success" role="status">{message}</div>}
    <form onSubmit={event => {
      event.preventDefault();
      perform(async () => {
        if (!review) {
          setReview(await apiFetch("/api/account/device-pairings/inspect", { method: "POST", scoped: false,
            body: { verificationCode: code } }));
          return;
        }
        const result = await apiFetch("/api/account/device-pairings/approve", { method: "POST", scoped: false,
          body: { verificationCode: code, budgetIds: selected, writeBudgetIds: writeSelected.filter(id => selected.includes(id)),
            mayCreateBudgets: mayCreate && writeSelected.some(id => selected.includes(id)) } });
        setCode(""); setReview(null); setWriteSelected([]); setMayCreate(false); setMessage(`${t("Device approved")}: ${result.label}`);
      });
    }}>
      <label className="beta-field"><span>{t("Verification code shown on your device")}</span>
        <input name="device_verification_code" value={code} onChange={event => { setCode(event.target.value); setReview(null); setWriteSelected([]); setMayCreate(false); }} required maxLength={20} autoComplete="off" />
      </label>
      <fieldset><legend>{t("Budgets this device may download")}</legend>
        {budgets.map(budget => <label key={budget.id} className="beta-check">
          <input type="checkbox" value={budget.id} checked={selected.includes(budget.id)} onChange={event => {
            setSelected(previous => event.target.checked ? [...previous, budget.id] : previous.filter(id => id !== budget.id));
            // Removing download access also discards its independently reviewed write consent.
            if (!event.target.checked) setWriteSelected(previous => previous.filter(id => id !== budget.id));
          }} />
          {budget.displayName || budget.display_name || budget.id}
        </label>)}
      </fieldset>
      {review && <p><strong>{review.label}</strong> — {review.scope === "app:financial:sync" ? t("Financial synchronization requested") : t("Read-only")}</p>}
      {review?.scope === "app:financial:sync" && <fieldset><legend>{t("Allow financial writes to these budgets")}</legend>
        {budgets.filter(budget => selected.includes(budget.id)).map(budget => <label key={budget.id} className="beta-check">
          <input type="checkbox" data-write-budget-id={budget.id} checked={writeSelected.includes(budget.id)} onChange={event => setWriteSelected(previous =>
            event.target.checked ? [...previous, budget.id] : previous.filter(id => id !== budget.id))} />
          {budget.displayName || budget.display_name || budget.id}
        </label>)}
      </fieldset>}
      {review?.scope === "app:financial:sync" && <label className="beta-check">
        <input type="checkbox" name="device_may_create_budgets" checked={mayCreate} disabled={!writeSelected.some(id => selected.includes(id))}
          onChange={event => setMayCreate(event.target.checked)} />
        {t("Allow this device to create new budgets in your account")}
      </label>}
      <button type="submit" disabled={busy || !selected.length}>{review ? t("Approve device") : t("Review device")}</button>
    </form>
    <ul>{devices.map(device => <li key={device.id} data-device-id={device.id}>
      <strong>{device.label}</strong> — {device.revoked ? t("Revoked") : device.scope === "app:financial:sync" ? t("Financial synchronization") : t("Read-only")}
      {!device.revoked && device.mayCreateBudgets && <> · {t("May create budgets")}</>}
      {device.writeBudgetIds?.length > 0 && <ul>{device.writeBudgetIds.map(id => <li key={id}>
        {budgets.find(budget => budget.id === id)?.displayName || budgets.find(budget => budget.id === id)?.display_name || id}
      </li>)}</ul>}
      {!device.revoked && <button type="button" disabled={busy} onClick={() => perform(() =>
        apiFetch(`/api/account/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", scoped: false }))}>{t("Revoke")}</button>}
    </li>)}</ul>
  </section>;
}