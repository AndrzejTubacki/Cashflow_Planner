import { t } from "./i18n.js";
import { useState } from "react";
import { apiFetch } from "./api.js";

export default function ProjectionWarnings({ snapshot, onRefresh }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const missingFxRates = snapshot?.missingFxRates || [];
  const latestProjection = snapshot?.latestProjectionSnapshot || null;
  const projectionFailed = latestProjection && Number(latestProjection.generation_succeeded) === 0;
  const canMaintain = (snapshot?.session?.capabilities || []).includes("budget:maintain");

  if (!missingFxRates.length && !projectionFailed) return null;

  async function run(key, path) {
    setBusy(key);
    setError("");
    try {
      await apiFetch(path, { method: "POST" });
      await onRefresh();
    } catch (err) {
      setError(err.message || t("The projection could not be refreshed. Try again."));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="beta-global-warnings" role="status">
      {error ? <div className="beta-error">{error}</div> : null}
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
