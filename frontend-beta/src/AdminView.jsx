import { useState } from "react";
import { apiFetch } from "./api.js";
import {
  AUTH_MODE_OPTIONS,
  AUTH_PROVIDER_KINDS,
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

function AdminAccountCard({ account, expanded, onToggle, onChanged }) {
  const [name, setName] = useState(account.display_name || account.id);
  const [email, setEmail] = useState(account.email || "");
  const externalIdentity = (account.identities || []).find(i => String(i.provider_id || "").startsWith("external_")) || null;
  const [externalSubject, setExternalSubject] = useState(externalIdentity?.subject || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tokenOutput, setTokenOutput] = useState("");
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

  async function createPasswordToken(purpose) {
    await withBusy(async () => {
      const result = await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/password-reset-token`, {
        method: "POST",
        body: { purpose }
      });
      setTokenOutput(result.token || "");
    });
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
          {tokenOutput ? <small className="beta-hint">Password token: <code>{tokenOutput}</code></small> : null}
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

function AdminAccountsPanel({ accounts, onChanged }) {
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      await apiFetch("/api/admin/auth/test", { method: "POST" });
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
            <select value={draftMode} onChange={e => setDraftMode(e.target.value)}>
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

        <fieldset className="beta-admin-fieldset">
          <legend>External SSO draft</legend>
          <div className="beta-form-grid">
            <label className="beta-field">
              <span>Subject header</span>
              <input value={subjectHeader} onChange={e => setSubjectHeader(e.target.value)} />
            </label>
            <label className="beta-field">
              <span>Assertion secret header</span>
              <input value={assertionSecretHeader} onChange={e => setAssertionSecretHeader(e.target.value)} />
            </label>
            <label className="beta-field">
              <span>Assertion secret environment variable</span>
              <input value={assertionSecretEnv} onChange={e => setAssertionSecretEnv(e.target.value)} />
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
            </label>
            <label className="beta-field">
              <span>Trusted issuer</span>
              <input value={trustedIssuer} onChange={e => setTrustedIssuer(e.target.value)} />
            </label>
            <label className="beta-field">
              <span>Provisioning mode</span>
              <select value={provisioningMode} onChange={e => setProvisioningMode(e.target.value)}>
                {AUTH_PROVISIONING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="beta-field">
              <span>Allowed domains</span>
              <input value={allowedDomains} onChange={e => setAllowedDomains(e.target.value)} placeholder="example.com, example.org" />
            </label>
            <label className="beta-field">
              <span>Admin groups</span>
              <input value={adminGroups} onChange={e => setAdminGroups(e.target.value)} placeholder="admins, ops" />
            </label>
          </div>
        </fieldset>

        <fieldset className="beta-admin-fieldset">
          <legend>Internal login draft</legend>
          <label className="beta-field beta-field-checkbox">
            <input type="checkbox" checked={allowPasswordLogin} onChange={e => setAllowPasswordLogin(e.target.checked)} />
            <span>Password login</span>
          </label>
        </fieldset>

        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Save auth draft</button>
          <button type="button" className="beta-btn-small" disabled={busy} onClick={handleTest}>Test auth draft</button>
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleActivate}>Activate auth draft</button>
        </div>
        <small className="beta-hint">
          Internal activation requires a system administrator with an email/password credential or
          linked enabled provider. External activation requires an assertion secret and linked
          administrator identity.
        </small>
      </form>
    </div>
  );
}

function AuthProviderForm({ provider, onSaved, onDeleted }) {
  const isExisting = Boolean(provider?.id);
  const config = provider?.config || {};
  const [providerId, setProviderId] = useState(provider?.id || "");
  const [kind, setKind] = useState(provider?.kind || "oidc");
  const [displayName, setDisplayName] = useState(provider?.displayName || "");
  const [enabled, setEnabled] = useState(Boolean(provider?.enabled));
  const [issuer, setIssuer] = useState(provider?.issuer || "");
  const [clientId, setClientId] = useState(provider?.clientId || "");
  const [secretEnv, setSecretEnv] = useState("");
  const [redirectUri, setRedirectUri] = useState(config.redirectUri || "");
  const [scope, setScope] = useState(config.scope || "openid email profile");
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState(config.authorizationEndpoint || "");
  const [tokenEndpoint, setTokenEndpoint] = useState(config.tokenEndpoint || "");
  const [userInfoEndpoint, setUserInfoEndpoint] = useState(config.userInfoEndpoint || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (!providerId.trim() || !displayName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        body: {
          kind, displayName, enabled: enabled ? 1 : 0, issuer, clientId,
          secretEnv: secretEnv || undefined,
          redirectUri, scope, authorizationEndpoint, tokenEndpoint, userInfoEndpoint
        }
      });
      await onSaved();
    } catch (err) {
      setError(err.message || "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this identity provider?")) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
      await onDeleted();
    } catch (err) {
      setError(err.message || "Failed to delete provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-admin-fieldset beta-settings-section" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{provider?.displayName || "New provider"}</legend>
        {error ? <div className="beta-error">{error}</div> : null}
        <div className="beta-form-grid">
          <label className="beta-field">
            <span>Provider ID</span>
            <input value={providerId} readOnly={isExisting} required maxLength={80} onChange={e => setProviderId(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Provider type</span>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              {AUTH_PROVIDER_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="beta-field">
            <span>Display name</span>
            <input value={displayName} required maxLength={120} onChange={e => setDisplayName(e.target.value)} />
          </label>
          <label className="beta-field beta-field-checkbox">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
          <label className="beta-field">
            <span>Issuer</span>
            <input value={issuer} onChange={e => setIssuer(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Client ID</span>
            <input value={clientId} onChange={e => setClientId(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Client secret env</span>
            <input
              value={secretEnv}
              onChange={e => setSecretEnv(e.target.value)}
              placeholder={provider?.secretConfigured ? "Configured" : "CASHFLOW_OIDC_CLIENT_SECRET"}
            />
          </label>
          <label className="beta-field">
            <span>Redirect URI</span>
            <input value={redirectUri} onChange={e => setRedirectUri(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Scope</span>
            <input value={scope} onChange={e => setScope(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Authorization endpoint</span>
            <input value={authorizationEndpoint} onChange={e => setAuthorizationEndpoint(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Token endpoint</span>
            <input value={tokenEndpoint} onChange={e => setTokenEndpoint(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>Userinfo endpoint</span>
            <input value={userInfoEndpoint} onChange={e => setUserInfoEndpoint(e.target.value)} />
          </label>
        </div>
        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Save provider</button>
          {isExisting ? (
            <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleDelete}>
              Delete provider
            </button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}

function AdminProvidersPanel({ providers, onChanged }) {
  return (
    <div className="beta-panel">
      <h3>Identity providers</h3>
      {providers.length ? providers.map(provider => (
        <div key={provider.id} className="beta-admin-provider-block">
          <div className="beta-budget-row">
            <div className="beta-budget-row-main">
              <strong>{provider.displayName || provider.id}</strong>
              <span className="beta-budget-meta">
                {provider.id} &middot; {provider.kind} &middot; {provider.enabled ? "Enabled" : "Disabled"} &middot; {provider.secretConfigured ? "Secret configured" : "Secret missing"}
              </span>
            </div>
          </div>
          <AuthProviderForm provider={provider} onSaved={onChanged} onDeleted={onChanged} />
        </div>
      )) : <p className="beta-empty">No identity providers configured.</p>}
      <AuthProviderForm provider={null} onSaved={onChanged} onDeleted={onChanged} />
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

      <AdminAccountsPanel accounts={accounts} onChanged={onRefresh} />
      <AdminAuthPanel authConfig={admin.authConfig} onChanged={onRefresh} />
      <AdminProvidersPanel providers={providers} onChanged={onRefresh} />
      <AdminOptionsPanel options={options} onChanged={onRefresh} />
    </section>
  );
}
