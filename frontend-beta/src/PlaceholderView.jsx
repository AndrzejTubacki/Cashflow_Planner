import { formatParts, t } from "./i18n.js";
export default function PlaceholderView({ label }) {
  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{label}</h1>
      </div>
      <div className="beta-placeholder">
        <strong>{t("Not built in the beta yet")}</strong>
        <p>{formatParts("This section still lives on the legacy app. {link} to use it.", {
          link: <a href="/">{t("Switch to legacy")}</a>
        })}</p>
      </div>
    </section>
  );
}
