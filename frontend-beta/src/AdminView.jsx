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
import { availableLocales, formatMessage, t } from "./i18n.js";

function isSystemAdmin(account) {
  return Array.isArray(account?.globalRoles) && account.globalRoles.includes("system_admin");
}

function AccountSessions({ account, busy, onRevoke }) {
  const sessions = Array.isArray(account?.sessions) ? account.sessions : [];
  if (!sessions.length) return <small className="beta-hint">{t("No active sessions")}</small>;
  return (
    <div className="beta-budget-list">
      {sessions.map(session => (
        <div className="beta-budget-row" key={session.id}>
          <div className="beta-budget-row-main">
            <strong>{t(session.auth_method || "none")}</strong>
            <span className="beta-budget-meta">{session.id} &middot; {session.last_seen_at || session.created_at || ""}</span>
          </div>
          <div className="beta-budget-row-actions">
            <button
              type="button"
              className="beta-btn-small beta-btn-danger"
              disabled={busy}
              onClick={() => onRevoke(account.id, session.id)}
            >{t("Revoke session")}</button>
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
      setError(err.message || t("Something went wrong"));
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
    if (status === "disabled" && !window.confirm(t("Disable this account?"))) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body: { status } });
      await onChanged();
    });
  }

  async function setSystemAdmin(enabled) {
    if (!enabled && !window.confirm(t("Revoke system admin from this account?"))) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/system-admin`, { method: "PUT", body: { enabled } });
      await onChanged();
    });
  }

  async function revokeSession(accountId, sessionId) {
    if (!window.confirm(t("Revoke this session?"))) return;
    await withBusy(async () => {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST", body: {} });
      await onChanged();
    });
  }

  async function deleteAccount() {
    if (!window.confirm(t("Delete this account?"))) return;
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
          <span className="beta-pill beta-pill-muted">{t(account.status || "active")}</span>
          <span className={`beta-pill ${admin ? "beta-pill-accent" : "beta-pill-muted"}`}>
            {admin ? t("System admin") : t("Budget member")}
          </span>
          <span className="beta-admin-account-budgets-count">
            {formatMessage("Budgets: {owned} owned / {total} memberships", {
              owned: account.ownedBudgetCount ?? 0,
              total: account.membershipCount ?? 0
            })}</span>
        </div>
      </button>

      {!expanded ? null : (
        <div className="beta-admin-account-body">
          {error ? <div className="beta-error">{error}</div> : null}

          <div className="beta-form-grid beta-form-grid-wide beta-form-grid-three beta-admin-account-grid">
        <label className="beta-field">
          <span>{t("Display name")}</span>
          <input value={name} disabled={deleted} onChange={e => setName(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>{t("Email")}</span>
          <input value={email} disabled={deleted} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>{t("External subject")}</span>
          <input value={externalSubject} disabled={deleted} onChange={e => setExternalSubject(e.target.value)} />
          <small className="beta-hint">{externalIdentity?.provider_id || t("No external identity")}</small>
        </label>
        <div className="beta-field beta-admin-account-sessions">
          <span>{t("Internal password")}</span>
          <strong>{account.hasPasswordCredential ? t("Configured") : t("Not configured")}</strong>
        </div>
        <div className="beta-field">
          <span>{t("Budgets")}</span>
          <strong>{account.ownedBudgetCount ?? 0} / {account.membershipCount ?? 0}</strong>
          <small className="beta-hint">{t("Owned / memberships")}</small>
        </div>
        <div className="beta-field">
          <span>{t("Active sessions")}</span>
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
          <button type="button" className="beta-btn-small" disabled={busy} onClick={saveAccount}>{t("Save account")}</button>
          {!account.hasPasswordCredential ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => createPasswordToken("password_setup")}>{t("Create password setup token")}</button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => createPasswordToken("password_reset")}>{t("Create password reset token")}</button>
          )}
          <button type="button" className="beta-btn-small" disabled={busy} onClick={linkExternalIdentity}>{t("Link external identity")}</button>
          {account.status === "active" ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setStatus("disabled")}>{t("Disable account")}</button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setStatus("active")}>{t("Enable account")}</button>
          )}
          {admin ? (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setSystemAdmin(false)}>{t("Revoke admin")}</button>
          ) : (
            <button type="button" className="beta-btn-small" disabled={busy} onClick={() => setSystemAdmin(true)}>{t("Grant admin")}</button>
          )}
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={deleteAccount}>{t("Delete account")}</button>
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
      <h3>{t("Account management")}</h3>
      <p className="beta-hint">{t("Manage who can sign in, who can administer Cashflow, and which active sessions can be revoked. Budget access is still controlled by budget membership. Click an account to see and edit its details.")}</p>

      {accounts.length > 8 ? (
        <label className="beta-field">
          <span>{t("Search accounts")}</span>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("Name, id, or email")}
          />
        </label>
      ) : null}

      {accounts.length ? (
        <>
          {normalizedQuery ? (
            <p className="beta-hint">{formatMessage("Showing {visible} of {total} accounts", { visible: filtered.length, total: accounts.length })}</p>
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
          ) : <p className="beta-empty">{formatMessage("No accounts match “{query}”.", { query })}</p>}
        </>
      ) : <p className="beta-empty">{t("No accounts yet.")}</p>}
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
      setError(err.message || t("Failed to save auth draft"));
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
      setError(err.message || t("Auth draft test failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate() {
    if (!window.confirm(t("Activate this authentication draft for the whole instance?"))) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/admin/auth/activate", { method: "POST" });
      await onChanged();
    } catch (err) {
      setError(err.message || t("Failed to activate auth draft"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-panel">
      <h3>{t("Authentication")}</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <form className="beta-settings-section" onSubmit={handleSave}>
        <div className="beta-field">
          <span>{t("Active authentication mode")}</span>
          <strong>{t(AUTH_MODE_OPTIONS.find(o => o.value === String(config.activeMode || "none"))?.label || "None")}</strong>
          <small className="beta-hint">{t("The active mode is changed only by activating a tested draft.")}</small>
        </div>

        <div className="beta-form-grid">
          <label className="beta-field">
            <span>{t("Draft authentication mode")}</span>
            <select value={draftMode} onChange={e => { setDraftMode(e.target.value); setTestResult(null); }}>
              {AUTH_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Session idle timeout (minutes)")}</span>
            <input type="number" min="5" max="10080" value={sessionIdleMinutes} onChange={e => setSessionIdleMinutes(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Session absolute timeout (minutes)")}</span>
            <input type="number" min="5" max="43200" value={sessionAbsoluteMinutes} onChange={e => setSessionAbsoluteMinutes(e.target.value)} />
          </label>
        </div>

        {draftMode === "none" ? (
          <p className="beta-hint">{t("No sign-in: anyone who can reach Cashflow can pick any account. Only use this behind a VPN or a reverse proxy that already restricts access.")}</p>
        ) : null}

        {draftMode === "external" ? (
          <fieldset className="beta-admin-fieldset beta-fieldset-stack">
            <legend>{t("Reverse-proxy SSO (the proxy signs people in before they reach Cashflow)")}</legend>
            <div className="beta-settings-section">
              <span className="beta-setup-step">{t("Which proxy signs people in?")}</span>
              <div className="beta-setup-choices" role="radiogroup" aria-label={t("Sign-in proxy")}>
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
                    <span>{t("User ID header")}</span>
                    <input value={subjectHeader} required onChange={e => setSubjectHeader(e.target.value)} />
                    <small className="beta-hint">{t("A stable ID the proxy sends for the signed-in person.")}</small>
                  </label>
                  <label className="beta-field">
                    <span>{t("Email header")}</span>
                    <input value={emailHeader} onChange={e => setEmailHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>{t("Display name header")}</span>
                    <input value={displayNameHeader} onChange={e => setDisplayNameHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>{t("Groups header")}</span>
                    <input value={groupsHeader} onChange={e => setGroupsHeader(e.target.value)} />
                    <small className="beta-hint">{t("Comma- or semicolon-separated group names.")}</small>
                  </label>
                  <label className="beta-field">
                    <span>{t("Assertion secret header")}</span>
                    <input value={assertionSecretHeader} required onChange={e => setAssertionSecretHeader(e.target.value)} />
                  </label>
                  <label className="beta-field">
                    <span>{t("Assertion secret environment variable")}</span>
                    <input value={assertionSecretEnv} required onChange={e => setAssertionSecretEnv(e.target.value)} />
                    <small className="beta-hint">{t("The name of the variable on the Cashflow server, not the secret.")}</small>
                  </label>
                  <label className="beta-field">
                    <span>{t("Unknown people")}</span>
                    <select value={provisioningMode} onChange={e => setProvisioningMode(e.target.value)}>
                      {AUTH_PROVISIONING_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                    </select>
                    <small className="beta-hint">{t("Keep “Deny unknown identities” until linking works for your accounts.")}</small>
                  </label>
                  <label className="beta-field">
                    <span>{t("Allowed email domains")}</span>
                    <input value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)} placeholder="example.com, example.org" />
                  </label>
                  <label className="beta-field">
                    <span>{t("Admin groups")}</span>
                    <input value={adminGroups} onChange={e => setAdminGroups(e.target.value)} placeholder="admins, ops" />
                    <small className="beta-hint">{t("Members of these groups become administrators.")}</small>
                  </label>
                </div>
                <details className="beta-details">
                  <summary>{t("Advanced")}</summary>
                  <label className="beta-field">
                    <span>{t("Trusted issuer label")}</span>
                    <input value={trustedIssuer} onChange={e => setTrustedIssuer(e.target.value)} placeholder="external" />
                    <small className="beta-hint">{t("Groups the linked identities under one name. Changing it later unlinks everyone.")}</small>
                  </label>
                </details>
              </>
            ) : null}
          </fieldset>
        ) : null}

        {draftMode === "internal" ? (
          <fieldset className="beta-admin-fieldset beta-fieldset-stack">
            <legend>{t("Cashflow sign-in")}</legend>
            <p className="beta-hint">{t("The sign-in page offers email and password plus a button for each enabled sign-in provider (set up under Sign-in providers below). Each person uses whichever they prefer: they can link providers and turn their own password off under Account settings.")}</p>
            <label className="beta-field beta-field-checkbox">
              <input type="checkbox" checked={allowPasswordLogin} onChange={e => setAllowPasswordLogin(e.target.checked)} />
              <span>{t("Allow email and password sign-in")}</span>
            </label>
            <p className="beta-hint">{t("Before activating, set your own email and password under Account settings in the account menu.")}</p>
          </fieldset>
        ) : null}

        {testResult ? (
          <div className={testResult.ok ? "beta-success" : "beta-error"} role="status">
            <strong>{testResult.ok ? t("This draft can be activated.") : t("This draft can't be activated yet:")}</strong>
            <ul className="beta-check-list">
              {(testResult.checks || []).map(check => (
                <li key={check.code}>{check.ok ? "✓" : "✗"} {check.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>{t("Save auth draft")}</button>
          <button type="button" className="beta-btn-small" disabled={busy} onClick={handleTest}>{t("Test auth draft")}</button>
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleActivate}>{t("Activate auth draft")}</button>
        </div>
        <small className="beta-hint">{t("Save the draft, test it, then activate. Activating a different mode signs everyone out.")}</small>
      </form>
    </div>
  );
}

function AdminOptionsPanel({ options, onChanged }) {
  const [locale, setLocale] = useState(options.locale || "en");
  const [ledgerCurrency, setLedgerCurrency] = useState(String(options.ledger_currency || "PLN").toUpperCase());
  const [timezone, setTimezone] = useState(options.timezone || "Europe/Warsaw");
  const [holidayCountry, setHolidayCountry] = useState(String(options.holiday_country || "PL").toUpperCase());
  const [futurePeriods, setFuturePeriods] = useState(options.future_periods || 11);
  const [fxProvider, setFxProvider] = useState(options.fx_provider || "nbp");
  const [fxBufferPercent, setFxBufferPercent] = useState(options.fx_buffer_percent ?? 0);
  const [ntfyAllowedPrivateHosts, setNtfyAllowedPrivateHosts] = useState(
    Array.isArray(options.ntfy_allowed_private_hosts) ? options.ntfy_allowed_private_hosts.join("\n") : ""
  );
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
          locale,
          ledger_currency: ledgerCurrency,
          timezone,
          holiday_country: holidayCountry,
          future_periods: Number(futurePeriods) || 11,
          fx_provider: fxProvider,
          fx_buffer_percent: Number(fxBufferPercent) || 0,
          ntfy_allowed_private_hosts: ntfyAllowedPrivateHosts
        }
      });
      await onChanged();
    } catch (err) {
      setError(err.message || t("Failed to save global options"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-panel">
      <h3>{t("Global options")}</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <form className="beta-settings-section" onSubmit={handleSubmit}>
        <div className="beta-form-grid beta-form-grid-wide beta-form-grid-three">
          <label className="beta-field">
            <span>{t("Default language")}</span>
            <select value={locale} onChange={e => setLocale(e.target.value)}>
              {availableLocales().map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Default ledger currency")}</span>
            <select value={ledgerCurrency} onChange={e => setLedgerCurrency(e.target.value)}>
              {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Default timezone")}</span>
            <input value={timezone} onChange={e => setTimezone(e.target.value)} list="beta-admin-timezones" />
            <datalist id="beta-admin-timezones">
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz} />)}
            </datalist>
          </label>
          <label className="beta-field">
            <span>{t("Default holiday country")}</span>
            <select value={holidayCountry} onChange={e => setHolidayCountry(e.target.value)}>
              {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} - {t(c.label)}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Default projection horizon")}</span>
            <input type="number" min="1" max="60" value={futurePeriods} onChange={e => setFuturePeriods(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Default FX provider")}</span>
            <select value={fxProvider} onChange={e => setFxProvider(e.target.value)}>
              {FX_PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Default FX buffer (%)")}</span>
            <input type="number" min="0" max="100" step="0.5" value={fxBufferPercent} onChange={e => setFxBufferPercent(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Private ntfy hosts")}</span>
            <textarea rows="4" value={ntfyAllowedPrivateHosts} onChange={e => setNtfyAllowedPrivateHosts(e.target.value)} />
            <small className="beta-hint">{t("Allow self-hosted ntfy servers on a private network. Only the exact hosts listed here are allowed, one per line.")}</small>
          </label>
        </div>
        <div className="beta-form-actions">
          <button type="submit" className="beta-btn-primary" disabled={busy}>{t("Save global options")}</button>
        </div>
      </form>
    </div>
  );
}

export default function AdminView({ snapshot, onRefresh, embedded = false }) {
  const admin = snapshot?.admin || {};
  const accounts = Array.isArray(admin.accounts) ? admin.accounts : [];
  const providers = Array.isArray(admin.providers) ? admin.providers : [];
  const options = admin.options || {};

  return (
    <section className="beta-view">
      {!embedded ? <div className="beta-view-head">
        <h1>{t("Admin")}</h1>
        <p>{t("Instance-wide account and authentication administration. Changes here affect every user.")}</p>
      </div> : null}

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
