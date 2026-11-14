import { formatMessage, t } from "./i18n.js";
import { useState } from "react";
import { apiFetch } from "./api.js";

export default function ProjectionWarnings({ snapshot, onRefresh }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const staleFxRates = snapshot?.staleFxRates || [];
  const missingFxRates = snapshot?.missingFxRates || [];
  const latestProjection = snapshot?.latestProjectionSnapshot || null;
  const projectionFailed = latestProjection && Number(latestProjection.generation_succeeded) === 0;
  const canMaintain = (snapshot?.session?.capabilities || []).includes("budget:maintain");

  if (!missingFxRates.length && !staleFxRates.length && !projectionFailed && !success) return null;

  async function run(key, path) {
    setBusy(key);
    setError("");
    setSuccess("");
    try {
      await apiFetch(path, { method: "POST" });
      await onRefresh();
      if (key === "fx") setSuccess(t("Exchange rates refreshed."));
    } catch (err) {
      setError(err.message || t("The projection could not be refreshed. Try again."));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="beta-global-warnings" role="status">
      {success ? <div className="beta-success">{success}</div> : null}
      {error ? <div className="beta-error">{error}</div> : null}
      {staleFxRates.length ? (
        <div className="beta-warning beta-projection-warning">
          <div>
            <strong>{t("Exchange rates are out of date")}</strong>
            <span>{staleFxRates.map(({ pair, ageDays }) => formatMessage("Exchange rate {pair} is {days} days old.", { pair, days: ageDays })).join(" ")}</span>
            <span>{t("Projections use the last known rate; confirming foreign-currency transactions is blocked until rates are refreshed.")}</span>
          </div>
          {canMaintain ? (
            <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("fx", "/api/fx/refresh")}>
              {busy === "fx" ? t("Refreshing...") : t("Refresh FX rates")}
            </button>
          ) : null}
        </div>
      ) : null}
      {missingFxRates.length ? (
        <div className="beta-warning beta-projection-warning">
          <div>
            <strong>{t("Missing FX rates")}</strong>
            <span>{t("Projections are missing rates for:")} {missingFxRates.join(", ")}.</span>
          </div>
          {canMaintain ? (
            <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("fx", "/api/fx/refresh")}>
              {busy === "fx" ? t("Refreshing...") : t("Refresh FX rates")}
            </button>
          ) : null}
        </div>
      ) : null}
      {projectionFailed ? (
        <div className="beta-warning beta-projection-warning">
          <div>
            <strong>{t("Last projection failed")}</strong>
            <span>{latestProjection.snapshot_timestamp || t("Timestamp unavailable")}</span>
          </div>
          {canMaintain ? (
            <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("projection", "/api/run-jobs")}>
              {busy === "projection" ? t("Regenerating...") : t("Regenerate projection")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
