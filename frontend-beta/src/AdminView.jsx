import { useState } from "react";
import { apiFetch } from "./api.js";
import PasswordTokenModal from "./PasswordTokenModal.jsx";
import { IdentityProvidersPanel, ProxyGuide, PROXY_GUIDES, detectProxyPreset } from "./AuthSetup.jsx";
import {
  AUTH_MODE_OPTIONS,
  AUTH_PROVISIONING_OPTIONS,
  FX_PROVIDER_OPTIONS,
  HOLIDAY_COUNTRIES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";

function isSystemAdmin(account) {
  return Array.isArray(account?.globalRoles) && account.globalRoles.includes("system_admin");
}

function AccountSessions({ account, busy, onRevoke }) {
  const sessions = Array.isArray(account?.sessions) ? account.sessions : [];
  if (!sessions.length) return <small className="beta-hint">No active sessions</small>;
  return (
    <div className="beta-budget-list">
      {sessions.map(session => (
        <div className="beta-budget-row" key={session.id}>
          <div className="beta-budget-row-main">
            <strong>{session.auth_method || "none"}</strong>
            <span className="beta-budget-meta">{session.id} &middot; {session.last_seen_at || session.created_at || ""}</span>
          </div>
          <div className="beta-budget-row-actions">
            <button
              type="button"
              className="beta-btn-small beta-btn-danger"
              disabled={busy}
              onClick={() => onRevoke(account.id, session.id)}
            >
              Revoke session
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminAccountCard({ account, expanded, onToggle, onChanged, internalLoginActive, currentAccountId }) {
  const [name, setName] = useState(account.display_name || account.id);
  const [email, setEmail] = useState(account.email || "");
  const externalIdentity = (account.identities || []).find(i => String(i.provider_id || "").startsWith("external_")) || null;
  const [externalSubject, setExternalSubject] = useState(externalIdentity?.subject || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tokenPurpose, setTokenPurpose] = useState("");
  const deleted = account.status === "deleted";
  const admin = isSystemAdmin(account);

  async function withBusy(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount() {
    await withBusy(async () => {
      const body = { displayName: name };
      if (email.trim()) body.email = email;
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body });
      await onChanged();
    });
  }

  function createPasswordToken(purpose) {
    setError("");
    setTokenPurpose(purpose);
  }

  async function linkExternalIdentity() {
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/external-identity`, {
        method: "PUT",
        body: { subject: externalSubject }
      });
      await onChanged();
    });
  }

  async function setStatus(status) {
    if (status === "disabled" && !window.confirm("Disable this account?")) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body: { status } });
      await onChanged();
    });
  }

  async function setSystemAdmin(enabled) {
    if (!enabled && !window.confirm("Revoke system admin from this account?")) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/system-admin`, { method: "PUT", body: { enabled } });
      await onChanged();
    });
  }

  async function revokeSession(accountId, sessionId) {
    if (!window.confirm("Revoke this session?")) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST", body: {} });
      await onChanged();
    });
  }

  async function deleteAccount() {
    if (!window.confirm("Delete this account?")) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      await onChanged();
    });
  }

  return (
    <article className="beta-admin-account-card">
      <button type="button" className="beta-admin-account-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="beta-admin-account-head-chevron">{expanded ? "⌄" : "›"}</span>
        <div className="beta-admin-account-head-main">
          <strong>{account.display_name || account.id}</strong>
          <span className="beta-budget-meta">{account.id}</span>
        </div>
        <div className="beta-admin-account-badges">
          <span className="beta-pill beta-pill-muted">{account.status || "active"}</span>
          <span className={`beta-pill ${admin ? "beta-pill-accent" : "beta-pill-muted"}`}>
            {admin ? "System admin" : "Budget member"}
          </span>
          <span className="beta-admin-account-budgets-count">
            {account.ownedBudgetCount ?? 0} / {account.membershipCount ?? 0} budgets
          </span>
        </div>
      </button>

      {!expanded ? null : (
        <div className="beta-admin-account-body">
          {error ? <div className="beta-error">{error}</div> : null}

          <div className="beta-form-grid">
        <label className="beta-field">
          <span>Display name</span>
          <input value={name} disabled={deleted} onChange={e => setName(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>Email</span>
          <input value={email} disabled={deleted} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>External subject</span>
          <input value={externalSubject} disabled={deleted} onChange={e => setExternalSubject(e.target.value)} />
          <small className="beta-hint">{externalIdentity?.provider_id || "No external identity"}</small>
        </label>
        <div className="beta-field">
          <span>Internal password</span>
          <strong>{account.hasPasswordCredential ? "Configured" : "Not configured"}</strong>
        </div>
        <div className="beta-field">
          <span>Budgets</span>
          <strong>{account.ownedBudgetCount ?? 0} / {account.membershipCount ?? 0}</strong>
          <small className="beta-hint">Owned / memberships</small>
        </div>
        <div className="beta-field">
          <span>Active sessions</span>
          <AccountSessions account={account} busy={busy} onRevoke={revokeSession} />
        </div>
      </div>

      {tokenPurpose ? (
        <PasswordTokenModal
          account={account}
          purpose={tokenPurpose}
          internalLoginActive={internalLoginActive}
          isSelf={account.id === currentAccountId}
          onClose={() => setTokenPurpose("")}
        />
      ) : null}

      {!deleted ? (
        <div className="beta-row-actions beta-row-actions-wrap">
          <button type="button" className="beta-btn-small" disabled={busy} onClick={saveAccount}>Save account</button>
          {!account.hasPasswordCredential ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => createPasswordToken("password_setup")}>
              Create password setup token
            </button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => createPasswordToken("password_reset")}>
              Create password reset token
            </button>
          )}
          <button type="button" className="beta-btn-small" disabled={busy} onClick={linkExternalIdentity}>Link external identity</button>
          {account.status === "active" ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setStatus("disabled")}>Disable account</button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setStatus("active")}>Enable account</button>
          )}
          {admin ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setSystemAdmin(false)}>Revoke admin</button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setSystemAdmin(true)}>Grant admin</button>
          )}
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={deleteAccount}>Delete account</button>
        </div>
      ) : null}
        </div>
      )}
    </article>
  );
}

function AdminAccountsPanel({ accounts, onChanged, internalLoginActive, currentAccountId }) {
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  function toggle(id) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? accounts.filter(account => [account.display_name, account.id, account.email]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(normalizedQuery)))
    : accounts;

  return (
    <div className="beta-panel">
      <h3>Account management</h3>
      <p className="beta-hint">
        Manage who can sign in, who can administer Cashflow, and which active sessions can be revoked.
        Budget access is still controlled by budget membership. Click an account to see and edit its
        details.
      </p>

      {accounts.length > 8 ? (
        <label className="beta-field">
          <span>Search accounts</span>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Name, id, or email"
          />
        </label>
      ) : null}

      {accounts.length ? (
        <>
          {normalizedQuery ? (
            <p className="beta-hint">{filtered.length} of {accounts.length} accounts</p>
          ) : null}
          {filtered.length ? (
            <div className="beta-admin-account-list">
              {filtered.map(account => (
                <AdminAccountCard
                  key={account.id}
                  account={account}
                  expanded={expandedIds.has(account.id)}
                  onToggle={() => toggle(account.id)}
                  onChanged={onChanged}
                  internalLoginActive={internalLoginActive}
                  currentAccountId={currentAccountId}
                />
              ))}
            </div>
          ) : <p className="beta-empty">No accounts match &ldquo;{query}&rdquo;.</p>}
        </>
      ) : <p className="beta-empty">No accounts yet.</p>}
    </div>
  );
}

function AdminAuthPanel({ authConfig, onChanged }) {
  const config = authConfig || {};
  const draft = config.draftConfig || {};
  const external = draft.external || {};
  const internal = draft.internal || {};

  const [draftMode, setDraftMode] = useState(String(config.draftMode || "none"));
  const [sessionIdleMinutes, setSessionIdleMinutes] = useState(config.sessionIdleMinutes || 720);
  const [sessionAbsoluteMinutes, setSessionAbsoluteMinutes] = useState(config.sessionAbsoluteMinutes || 10080);
  const [subjectHeader, setSubjectHeader] = useState(external.subjectHeader || "x-auth-request-user");
  const [assertionSecretHeader, setAssertionSecretHeader] = useState(external.assertionSecretHeader || "x-cashflow-auth-secret");
  const [assertionSecretEnv, setAssertionSecretEnv] = useState(external.assertionSecretEnv || "CASHFLOW_EXTERNAL_AUTH_SECRET");
  const [emailHeader, setEmailHeader] = useState(external.emailHeader || "");
  const [displayNameHeader, setDisplayNameHeader] = useState(external.displayNameHeader || "");
  const [groupsHeader, setGroupsHeader] = useState(external.groupsHeader || "");
  const [trustedIssuer, setTrustedIssuer] = useState(external.trustedIssuer || "");
  const [provisioningMode, setProvisioningMode] = useState(external.provisioningMode || "deny_unknown");
  const [allowedDomains, setAllowedDomains] = useState((external.allowedDomains || []).join(", "));
  const [adminGroups, setAdminGroups] = useState((external.adminGroups || []).join(", "));
  const [allowPasswordLogin, setAllowPasswordLogin] = useState(internal.allowPasswordLogin !== false);
  const [proxyPreset, setProxyPreset] = useState(() => (String(config.draftMode || "none") === "external" ? detectProxyPreset(external) : ""));
  const [testResult, setTestResult] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function choosePreset(id) {
    setProxyPreset(id);
    setTestResult(null);
    const headers = PROXY_GUIDES[id]?.headers;
    if (!headers) return;
    setSubjectHeader(headers.subjectHeader);
    setEmailHeader(headers.emailHeader);
    setDisplayNameHeader(headers.displayNameHeader);
    setGroupsHeader(headers.groupsHeader);
  }

  function buildPayload() {
    return {
      draftMode: draftMode || "none",
      sessionIdleMinutes: Number(sessionIdleMinutes) || 720,
      sessionAbsoluteMinutes: Number(sessionAbsoluteMinutes) || 10080,
      draftConfig: {
        external: {
          subjectHeader: subjectHeader || "x-auth-request-user",
          assertionSecretHeader: assertionSecretHeader || "x-cashflow-auth-secret",
          assertionSecretEnv: assertionSecretEnv || "CASHFLOW_EXTERNAL_AUTH_SECRET",
          emailHeader,
          displayNameHeader,
          groupsHeader,
          trustedIssuer,
          provisioningMode: provisioningMode || "deny_unknown",
          allowedDomains,
          adminGroups
        },
        internal: { allowPasswordLogin: allowPasswordLogin ? 1 : 0 }
      }
    };
  }

  async function handleSave(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/admin/auth/draft", { method: "PUT", body: buildPayload() });
      setTestResult(null);
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to save auth draft");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setError("");
    try {
      setTestResult(await apiFetch("/api/admin/auth/test", { method: "POST" }));
    } catch (err) {
      setError(err.message || "Auth draft test failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate() {
    if (!window.confirm("Activate this authentication draft for the whole instance?")) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/admin/auth/activate", { method: "POST" });
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to activate auth draft");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-panel">
      <h3>Authentication</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <form className="beta-settings-section" onSubmit={handleSave}>
        <div className="beta-field">
          <span>Active authentication mode</span>
          <strong>{AUTH_MODE_OPTIONS.find(o => o.value === String(config.activeMode || "none"))?.label || "None"}</strong>
          <small className="beta-hint">The active mode is changed only by activating a tested draft.</small>
        </div>

        <div className="beta-form-grid">
          <label className="beta-field">
            <span>Draft authentication mode</span>
            <select value={draftMode} onChange={e => { setDraftMode(e.target.value); setTestResult(null); }}>
              {AUTH_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>Session idle timeout (minutes)</span>
            <input type="number" min="5" max="10080" value={sessionIdleMinutes} onChange={e => setSessionIdleMinutes(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Session absolute timeout (minutes)</span>
            <input type="number" min="5" max="43200" value={sessionAbsoluteMinutes} onChange={e => setSessionAbsoluteMinutes(e.target.value)} />
          </label>
        </div>

        {draftMode === "none" ? (
          <p className="beta-hint">
            No sign-in: anyone who can reach Cashflow can pick any account. Only use this behind a VPN or a reverse
            proxy that already restricts access.
          </p>
        ) : null}

        {draftMode === "external" ? (
          <fieldset className="beta-admin-fieldset beta-fieldset-stack">
            <legend>Reverse-proxy SSO (the proxy signs people in before they reach Cashflow)</legend>
            <div className="beta-settings-section">
              <span className="beta-setup-step">Which proxy signs people in?</span>
              <div className="beta-setup-choices" role="radiogroup" aria-label="Sign-in proxy">
                {Object.entries(PROXY_GUIDES).map(([id, guide]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={proxyPreset === id}
                    className={`beta-entry-choice${proxyPreset === id ? " is-selected" : ""}`}
                    onClick={() => choosePreset(id)}
                  >
                    <strong>{guide.label}</strong>
                  </button>
                ))}
              </div>
            </div>

            {proxyPreset ? (
              <>
                <ProxyGuide presetId={proxyPreset} secretHeader={assertionSecretHeader} secretEnv={assertionSecretEnv} />
                <div className="beta-form-grid beta-form-grid-wide">
                  <label className="beta-field">
                    <span>User ID header</span>
                    <input value={subjectHeader} required onChange={e => setSubjectHeader(e.target.value)} />
                    <small className="beta-hint">A stable ID the proxy sends for the signed-in person.</small>
                  </label>
                  <label className="beta-field">
                    <span>Email header</span>
                    <input value={emailHeader} onChange={e => setEmailHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Display name header</span>
                    <input value={displayNameHeader} onChange={e => setDisplayNameHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Groups header</span>
                    <input value={groupsHeader} onChange={e => setGroupsHeader(e.target.value)} />
                    <small className="beta-hint">Comma- or semicolon-separated group names.</small>
                  </label>
                  <label className="beta-field">
                    <span>Assertion secret header</span>
                    <input value={assertionSecretHeader} required onChange={e => setAssertionSecretHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>Assertion secret environment variable</span>
                    <input value={assertionSecretEnv} required onChange={e => setAssertionSecretEnv(e.target.value)} />
                    <small className="beta-hint">The name of the variable on the Cashflow server, not the secret.</small>
                  </label>
                  <label className="beta-field">
                    <span>Unknown people</span>
                    <select value={provisioningMode} onChange={e => setProvisioningMode(e.target.value)}>
                      {AUTH_PROVISIONING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <small className="beta-hint">Keep &ldquo;Deny unknown identities&rdquo; until linking works for your accounts.</small>
                  </label>
                  <label className="beta-field">
                    <span>Allowed email domains</span>
                    <input value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)} placeholder="example.com, example.org" />
                  </label>
                  <label className="beta-field">
                    <span>Admin groups</span>
                    <input value={adminGroups} onChange={e => setAdminGroups(e.target.value)} placeholder="admins, ops" />
                    <small className="beta-hint">Members of these groups become administrators.</small>
                  </label>
                </div>
                <details className="beta-details">
                  <summary>Advanced</summary>
                  <label className="beta-field">
                    <span>Trusted issuer label</span>
                    <input value={trustedIssuer} onChange={e => setTrustedIssuer(e.target.value)} placeholder="external" />
                    <small className="beta-hint">Groups the linked identities under one name. Changing it later unlinks everyone.</small>
                  </label>
                </details>
              </>
            ) : null}
          </fieldset>
        ) : null}

        {draftMode === "internal" ? (
          <fieldset className="beta-admin-fieldset beta-fieldset-stack">
            <legend>Cashflow sign-in</legend>
            <p className="beta-hint">
              The sign-in page offers email and password plus a button for each enabled sign-in provider (set up under
              Sign-in providers below). Each person uses whichever they prefer: they can link providers and turn their own
              password off under Account settings.
            </p>
            <label className="beta-field beta-field-checkbox">
              <input type="checkbox" checked={allowPasswordLogin} onChange={e => setAllowPasswordLogin(e.target.checked)} />
              <span>Allow email and password sign-in</span>
            </label>
            <p className="beta-hint">Before activating, set your own email and password under Account settings in the account menu.</p>
          </fieldset>
        ) : null}

        {testResult ? (
          <div className={testResult.ok ? "beta-success" : "beta-error"} role="status">
            <strong>{testResult.ok ? "This draft can be activated." : "This draft can't be activated yet:"}</strong>
            <ul className="beta-check-list">
              {(testResult.checks || []).map(check => (
                <li key={check.code}>{check.ok ? "✓" : "✗"} {check.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Save auth draft</button>
          <button type="button" className="beta-btn-small" disabled={busy} onClick={handleTest}>Test auth draft</button>
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleActivate}>Activate auth draft</button>
        </div>
        <small className="beta-hint">Save the draft, test it, then activate. Activating a different mode signs everyone out.</small>
      </form>
    </div>
  );
}

function AdminOptionsPanel({ options, onChanged }) {
  const [ledgerCurrency, setLedgerCurrency] = useState(String(options.ledger_currency || "PLN").toUpperCase());
  const [timezone, setTimezone] = useState(options.timezone || "Europe/Warsaw");
  const [holidayCountry, setHolidayCountry] = useState(String(options.holiday_country || "PL").toUpperCase());
  const [futurePeriods, setFuturePeriods] = useState(options.future_periods || 11);
  const [fxProvider, setFxProvider] = useState(options.fx_provider || "nbp");
  const [fxBufferPercent, setFxBufferPercent] = useState(options.fx_buffer_percent ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/admin/options", {
        method: "PUT",
        body: {
          ledger_currency: ledgerCurrency,
          timezone,
          holiday_country: holidayCountry,
          future_periods: Number(futurePeriods) || 11,
          fx_provider: fxProvider,
          fx_buffer_percent: Number(fxBufferPercent) || 0
        }
      });
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to save global options");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-panel">
      <h3>Global options</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <form className="beta-settings-section" onSubmit={handleSubmit}>
        <div className="beta-form-grid">
          <label className="beta-field">
            <span>Default ledger currency</span>
            <select value={ledgerCurrency} onChange={e => setLedgerCurrency(e.target.value)}>
              {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>Default timezone</span>
            <input value={timezone} onChange={e => setTimezone(e.target.value)} list="beta-admin-timezones" />
            <datalist id="beta-admin-timezones">
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz} />)}
            </datalist>
          </label>
          <label className="beta-field">
            <span>Default holiday country</span>
            <select value={holidayCountry} onChange={e => setHolidayCountry(e.target.value)}>
              {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} - {c.label}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>Default projection horizon</span>
            <input type="number" min="1" max="60" value={futurePeriods} onChange={e => setFuturePeriods(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Default FX provider</span>
            <select value={fxProvider} onChange={e => setFxProvider(e.target.value)}>
              {FX_PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>Default FX buffer (%)</span>
            <input type="number" min="0" max="100" step="0.5" value={fxBufferPercent} onChange={e => setFxBufferPercent(e.target.value)} />
          </label>
        </div>
        <div className="beta-form-actions">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Save global options</button>
        </div>
      </form>
    </div>
  );
}

export default function AdminView({ snapshot, onRefresh }) {
  const admin = snapshot?.admin || {};
  const accounts = Array.isArray(admin.accounts) ? admin.accounts : [];
  const providers = Array.isArray(admin.providers) ? admin.providers : [];
  const options = admin.options || {};

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Admin</h1>
        <p>Instance-wide account and authentication administration. Changes here affect every user.</p>
      </div>

      <AdminAccountsPanel
        accounts={accounts}
        onChanged={onRefresh}
        internalLoginActive={String(admin.authConfig?.activeMode || "none") === "internal"}
        currentAccountId={snapshot?.session?.accountId || ""}
      />
      <AdminAuthPanel authConfig={admin.authConfig} onChanged={onRefresh} />
      <IdentityProvidersPanel
        providers={providers}
        onChanged={onRefresh}
        internalLoginActive={String(admin.authConfig?.activeMode || "none") === "internal"}
      />
      <AdminOptionsPanel options={options} onChanged={onRefresh} />
    </section>
  );
}
