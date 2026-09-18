import { NAV_SECTIONS as DEFAULT_NAV_SECTIONS } from "./NAV_SECTIONS.js";

function NavIcon({ id }) {
  const paths = {
    ledger: "M4 5h12M4 10h12M4 15h8",
    recurring: "M4 8a5 5 0 0 1 8.7-3.4M16 4v4h-4M16 12a5 5 0 0 1-8.7 3.4M4 16v-4h4",
    oneoff: "M10 3v14M3 10h14",
    priorities: "M5 15V9M10 15V5M15 15v-7",
    targets: "M10 10m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0M10 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    budget: "M3.5 4.5h13v11h-13zM3.5 8h13",
    settings: "M10 10m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0M10 3.5v2M10 14.5v2M16.5 10h-2M5.5 10h-2M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4M14.8 14.8l-1.4-1.4M6.6 6.6 5.2 5.2",
    admin: "M10 3l6 2.5v4c0 4-2.5 6.5-6 7.5-3.5-1-6-3.5-6-7.5v-4z"
  };
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d={paths[id] || ""} />
    </svg>
  );
}

export default function Shell({ activeSection, onSelectSection, budgetLabel, ledgerCurrency, sections, children }) {
  const navSections = sections || DEFAULT_NAV_SECTIONS;
  return (
    <div className="beta-shell">
      <aside className="beta-rail">
        <div className="beta-wordmark">
          <span className="beta-mark">&#8353;</span>
          Cashflow
          <span className="beta-badge">BETA</span>
        </div>
        <nav className="beta-sections">
          {navSections.map(section => (
            <button
              key={section.id}
              type="button"
              className={`beta-section-btn${activeSection === section.id ? " active" : ""}`}
              onClick={() => onSelectSection(section.id)}
              aria-label={section.label}
              aria-current={activeSection === section.id ? "page" : undefined}
              title={section.label}
            >
              <NavIcon id={section.id} />
              <span>{section.label}</span>
              {!section.ready ? <span className="beta-soon">soon</span> : null}
            </button>
          ))}
        </nav>
        <div className="beta-rail-footer">
          {budgetLabel}
          <br />
          Ledger currency: {ledgerCurrency}
        </div>
      </aside>
      <div className="beta-main">{children}</div>
    </div>
  );
}
