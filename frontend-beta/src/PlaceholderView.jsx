export default function PlaceholderView({ label }) {
  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{label}</h1>
      </div>
      <div className="beta-placeholder">
        <strong>Not built in the beta yet</strong>
        <p>
          This section still lives on the legacy app. <a href="/">Switch to legacy</a> to use it.
        </p>
      </div>
    </section>
  );
}
