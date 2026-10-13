import { useCallback, useEffect, useState } from "react";
import { apiFetch, setCsrfToken } from "./api.js";
import { DEFAULT_TIMEZONE, HOLIDAY_COUNTRIES, SUPPORTED_FX_CURRENCIES, TIMEZONE_OPTIONS } from "./constants.js";

const ACCOUNT_ID_PATTERN = "[A-Za-z0-9_\\-]{1,64}";

function EntryFrame({ title, subtitle, onSignOut, children }) {
  return (
    <div className="beta-entry">
      <header className="beta-entry-head">
        <div className="beta-wordmark">
          <span className="beta-mark">&#8353;</span>
          Cashflow
          <span className="beta-badge">BETA</span>
        </div>
        {onSignOut ? (
          <button type="button" className="beta-btn-small" onClick={onSignOut}>Sign out</button>
        ) : null}
      </header>
      <div className="beta-entry-title">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children}
      <p className="beta-entry-foot">
        <a href="/?ui=legacy" onClick={() => localStorage.setItem("cashflow_preferred_ui", "legacy")}>Use the legacy app instead</a>
      </p>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async fn => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

function rememberSession(result) {
  if (result?.csrfToken) setCsrfToken(result.csrfToken);
  const accountId = String(result?.session?.accountId || "").trim();
  const budgetId = String(result?.session?.budgetId || "").trim();
  if (accountId) localStorage.setItem("cashflow_account_id", accountId);
  if (budgetId) {
    localStorage.setItem("cashflow_budget_id", budgetId);
    localStorage.setItem("cashflow_user_id", budgetId);
  } else {
    localStorage.removeItem("cashflow_budget_id");
    localStorage.removeItem("cashflow_user_id");
  }
}

function AccountPicker({ onSignedIn }) {
  const [accounts, setAccounts] = useState(null);
  const [legacyUsers, setLegacyUsers] = useState([]);
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    run(async () => {
      const [accountsResult, usersResult] = await Promise.all([
        apiFetch("/api/accounts", { cache: "no-store", scoped: false }),
        apiFetch("/api/users", { cache: "no-store", scoped: false }).catch(() => ({ users: [] }))
      ]);
      setAccounts(Array.isArray(accountsResult.accounts) ? accountsResult.accounts : []);
      setLegacyUsers(Array.isArray(usersResult.users) ? usersResult.users : []);
    });
  }, [run]);

  function selectAccount(accountId) {
    run(async () => {
      const result = await apiFetch("/api/session/select-account", { method: "POST", body: { accountId }, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  function selectLegacyUser(id) {
    run(async () => {
      const result = await apiFetch("/api/session/select", { method: "POST", body: { userId: id }, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  function createAccount(event) {
    event.preventDefault();
    run(async () => {
      const result = await apiFetch("/api/accounts", {
        method: "POST",
        body: { userId: userId.trim(), displayName: displayName.trim() },
        scoped: false
      });
      rememberSession(result);
      await onSignedIn();
    });
  }

  const visibleAccounts = accounts || [];
  // Budgets stored before accounts existed show up here until an account claims them.
  const showLegacyUsers = accounts !== null && !visibleAccounts.length && legacyUsers.length > 0;

  return (
    <div className="beta-entry-grid">
      <div className="beta-panel">
        <h3>Accounts</h3>
        {accounts === null ? <p className="beta-empty">Loading accounts...</p> : null}
        {accounts !== null && !visibleAccounts.length && !showLegacyUsers ? (
          <p className="beta-empty">No accounts yet. Create the first one to get started &mdash; it becomes the administrator.</p>
        ) : null}
        <div className="beta-budget-list">
          {visibleAccounts.map(account => (
            <button
              key={account.id}
              type="button"
              className="beta-entry-choice"
              disabled={busy || (account.status && account.status !== "active")}
              onClick={() => selectAccount(account.id)}
            >
              <strong>{account.display_name || account.id}</strong>
              <span className="beta-budget-meta">
                {account.id}
                {(account.globalRoles || []).includes("system_admin") ? " · administrator" : ""}
                {account.status && account.status !== "active" ? ` · ${account.status}` : ""}
              </span>
            </button>
          ))}
          {showLegacyUsers ? legacyUsers.map(user => (
            <button
              key={user.id}
              type="button"
              className="beta-entry-choice"
              disabled={busy}
              onClick={() => selectLegacyUser(user.id)}
            >
              <strong>{user.display_name || user.id}</strong>
              <span className="beta-budget-meta">{user.id}</span>
            </button>
          )) : null}
        </div>
      </div>

      <form className="beta-panel beta-settings-section" onSubmit={createAccount}>
        <h3>Create account</h3>
        {error ? <div className="beta-error">{error}</div> : null}
        <label className="beta-field">
          <span>Account ID</span>
          <input
            id="beta-create-account-id"
            value={userId}
            required
            maxLength={64}
            pattern={ACCOUNT_ID_PATTERN}
            autoComplete="username"
            onChange={e => setUserId(e.target.value)}
          />
          <small className="beta-hint">Letters, numbers, underscores or hyphens. It can&rsquo;t be changed later.</small>
        </label>
        <label className="beta-field">
          <span>Display name</span>
          <input id="beta-create-account-name" value={displayName} maxLength={120} onChange={e => setDisplayName(e.target.value)} />
        </label>
        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Create and continue</button>
        </div>
      </form>
    </div>
  );
}

function InternalLogin({ auth, onSignedIn }) {
  const providers = Array.isArray(auth?.internal?.providers) ? auth.internal.providers : [];
  const passwordLogin = auth?.internal?.allowPasswordLogin !== false;
  const login = useSubmit();
  const token = useSubmit();
  const register = useSubmit();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [tokenDone, setTokenDone] = useState(false);
  const [invitation, setInvitation] = useState({ invitationToken: "", email: "", displayName: "", password: "" });

  function handleLogin(event) {
    event.preventDefault();
    login.run(async () => {
      const result = await apiFetch("/api/auth/internal/login", { method: "POST", body: { email, password }, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  function startProvider(providerId) {
    login.run(async () => {
      const result = await apiFetch(`/api/auth/providers/${encodeURIComponent(providerId)}/login/start`, {
        method: "POST",
        body: {},
        scoped: false
      });
      if (!result?.authorizationUrl) throw new Error("Provider login did not return an authorization URL");
      window.location.assign(result.authorizationUrl);
    });
  }

  function handleSetPassword(event) {
    event.preventDefault();
    setTokenDone(false);
    token.run(async () => {
      await apiFetch("/api/auth/internal/password", {
        method: "POST",
        body: { token: setupToken.trim(), password: setupPassword },
        scoped: false
      });
      setSetupToken("");
      setSetupPassword("");
      setTokenDone(true);
    });
  }

  function handleRegister(event) {
    event.preventDefault();
    register.run(async () => {
      const result = await apiFetch("/api/auth/internal/register", { method: "POST", body: invitation, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  return (
    <div className="beta-entry-grid">
      <div className="beta-entry-stack">
        {passwordLogin ? (
          <form className="beta-panel beta-settings-section" onSubmit={handleLogin}>
            <h3>Email and password</h3>
            {login.error ? <div className="beta-error">{login.error}</div> : null}
            <label className="beta-field">
              <span>Email</span>
              <input id="beta-login-email" type="email" value={email} required autoComplete="username" onChange={e => setEmail(e.target.value)} />
            </label>
            <label className="beta-field">
              <span>Password</span>
              <input
                id="beta-login-password"
                type="password"
                value={password}
                required
                minLength={12}
                maxLength={1024}
                autoComplete="current-password"
                onChange={e => setPassword(e.target.value)}
              />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-primary" disabled={login.busy}>Sign in</button>
            </div>
          </form>
        ) : null}

        {providers.length ? (
          <div className="beta-panel beta-settings-section">
            <h3>Sign in with a provider</h3>
            {!passwordLogin && login.error ? <div className="beta-error">{login.error}</div> : null}
            {providers.map(provider => (
              <button
                key={provider.id}
                type="button"
                className="beta-btn-small beta-entry-provider"
                disabled={login.busy}
                onClick={() => startProvider(provider.id)}
              >
                Continue with {provider.displayName || provider.id}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="beta-entry-stack">
        <form className="beta-panel beta-settings-section" onSubmit={handleSetPassword}>
          <h3>Set password</h3>
          <p className="beta-hint">Got a password token from your administrator? Use it here, then sign in.</p>
          {token.error ? <div className="beta-error">{token.error}</div> : null}
          {tokenDone ? <div className="beta-success" role="status">Password set. You can sign in now.</div> : null}
          <label className="beta-field">
            <span>Password token</span>
            <input id="beta-token-input" value={setupToken} required autoComplete="off" onChange={e => setSetupToken(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>New password</span>
            <input
              id="beta-token-new-password"
              type="password"
              value={setupPassword}
              required
              minLength={12}
              maxLength={1024}
              autoComplete="new-password"
              onChange={e => setSetupPassword(e.target.value)}
            />
            <small className="beta-hint">At least 12 characters.</small>
          </label>
          <div className="beta-form-actions beta-form-actions-start">
            <button type="submit" className="beta-btn-small" disabled={token.busy}>Set password</button>
          </div>
        </form>

        <details className="beta-panel beta-entry-details">
          <summary>Register with an invitation</summary>
          <form className="beta-settings-section" onSubmit={handleRegister}>
            {register.error ? <div className="beta-error">{register.error}</div> : null}
            <label className="beta-field">
              <span>Invitation token</span>
              <input id="beta-invite-token" value={invitation.invitationToken} required autoComplete="off"
                onChange={e => setInvitation(v => ({ ...v, invitationToken: e.target.value }))} />
            </label>
            <label className="beta-field">
              <span>Email</span>
              <input id="beta-invite-email" type="email" value={invitation.email} required autoComplete="username"
                onChange={e => setInvitation(v => ({ ...v, email: e.target.value }))} />
            </label>
            <label className="beta-field">
              <span>Display name</span>
              <input id="beta-invite-name" value={invitation.displayName} required maxLength={120} autoComplete="name"
                onChange={e => setInvitation(v => ({ ...v, displayName: e.target.value }))} />
            </label>
            <label className="beta-field">
              <span>Password</span>
              <input id="beta-invite-password" type="password" value={invitation.password} required minLength={12} maxLength={1024}
                autoComplete="new-password" onChange={e => setInvitation(v => ({ ...v, password: e.target.value }))} />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-small" disabled={register.busy}>Register</button>
            </div>
          </form>
        </details>
      </div>
    </div>
  );
}

function ExternalLogin({ onSignedIn }) {
  const { busy, error, run } = useSubmit();
  function handleContinue() {
    run(async () => {
      const result = await apiFetch("/api/auth/external/login", { method: "POST", body: {}, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }
  return (
    <div className="beta-panel beta-settings-section beta-entry-narrow">
      <h3>Single sign-on</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <p className="beta-hint">This Cashflow instance signs you in through your organisation&rsquo;s sign-in provider.</p>
      <div className="beta-form-actions beta-form-actions-start">
        <button type="button" className="beta-btn-primary" disabled={busy} onClick={handleContinue}>Continue with SSO</button>
      </div>
    </div>
  );
}

export function SignInView({ auth, notice, onSignedIn }) {
  const mode = String(auth?.activeMode || "none");
  return (
    <EntryFrame
      title={mode === "none" ? "Choose an account" : "Sign in"}
      subtitle={mode === "none"
        ? "This instance runs without sign-in, so pick an account or create one."
        : mode === "external" ? null : "Sign in with your email and password."}
    >
      {notice ? <div className="beta-error beta-entry-narrow">{notice}</div> : null}
      {mode === "internal" ? <InternalLogin auth={auth} onSignedIn={onSignedIn} />
        : mode === "external" ? <ExternalLogin onSignedIn={onSignedIn} />
          : <AccountPicker onSignedIn={onSignedIn} />}
    </EntryFrame>
  );
}

export function BudgetPickerView({ session, authError = "", onSelected, onSignOut }) {
  const [budgets, setBudgets] = useState(null);
  const [newName, setNewName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [notice, setNotice] = useState("");
  const list = useSubmit();
  const create = useSubmit();
  const invite = useSubmit();

  const loadBudgets = useCallback(() => list.run(async () => {
    const result = await apiFetch("/api/budgets", { cache: "no-store", scoped: false });
    setBudgets(Array.isArray(result.budgets) ? result.budgets : []);
  }), [list.run]);

  useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  async function select(budgetId) {
    const result = await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/select`, { method: "POST", body: {}, scoped: false });
    rememberSession({ ...result, session: { ...(result?.session || {}), budgetId } });
    await onSelected();
  }

  function handleCreate(event) {
    event.preventDefault();
    create.run(async () => {
      const created = await apiFetch("/api/budgets", { method: "POST", body: { displayName: newName.trim() }, scoped: false });
      const id = created?.budget?.id;
      if (!id) throw new Error("The budget was created but no id came back. Reload the page.");
      await select(id);
    });
  }

  function handleAccept(event) {
    event.preventDefault();
    setNotice("");
    invite.run(async () => {
      await apiFetch("/api/invitations/accept", { method: "POST", body: { token: inviteToken.trim() }, scoped: false });
      setInviteToken("");
      setNotice("Invitation accepted. The shared budget is now in your list.");
      await loadBudgets();
    });
  }

  const name = session?.accountDisplayName || session?.displayName || session?.accountId || "";

  return (
    <EntryFrame title="Choose a budget" subtitle={name ? `Signed in as ${name}.` : null} onSignOut={onSignOut}>
      {authError ? <div className="beta-error beta-entry-narrow">{authError}</div> : null}
      <div className="beta-entry-grid">
        <div className="beta-panel">
          <h3>Your budgets</h3>
          {list.error ? <div className="beta-error">{list.error}</div> : null}
          {budgets === null ? <p className="beta-empty">Loading budgets...</p> : null}
          {budgets && !budgets.length ? <p className="beta-empty">No budgets yet. Create one to get started.</p> : null}
          <div className="beta-budget-list">
            {(budgets || []).map(budget => (
              <button
                key={budget.id}
                type="button"
                className="beta-entry-choice"
                disabled={list.busy || budget.status !== "active"}
                onClick={() => list.run(() => select(budget.id))}
              >
                <strong>{budget.display_name || budget.id}</strong>
                <span className="beta-budget-meta">
                  {budget.id} &middot; {budget.role || "viewer"}{budget.status !== "active" ? ` · ${budget.status}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="beta-entry-stack">
          <form className="beta-panel beta-settings-section" onSubmit={handleCreate}>
            <h3>Create budget</h3>
            {create.error ? <div className="beta-error">{create.error}</div> : null}
            <label className="beta-field">
              <span>Budget name</span>
              <input id="beta-new-budget-name" value={newName} required maxLength={120} onChange={e => setNewName(e.target.value)} />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-primary" disabled={create.busy}>Create and continue</button>
            </div>
          </form>

          <form className="beta-panel beta-settings-section" onSubmit={handleAccept}>
            <h3>Accept an invitation</h3>
            {invite.error ? <div className="beta-error">{invite.error}</div> : null}
            {notice ? <div className="beta-success" role="status">{notice}</div> : null}
            <label className="beta-field">
              <span>Invitation token</span>
              <input id="beta-accept-invite-token" value={inviteToken} required autoComplete="off" onChange={e => setInviteToken(e.target.value)} />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-small" disabled={invite.busy}>Accept invitation</button>
            </div>
          </form>
        </div>
      </div>
    </EntryFrame>
  );
}

const AMOUNT_PATTERN = "[0-9]+([.,][0-9]+)?";

export function SetupView({ snapshot, onDone, onSignOut, onSwitchBudget }) {
  const settings = snapshot?.settings || {};
  const locales = Array.isArray(snapshot?.availableLocales) && snapshot.availableLocales.length
    ? snapshot.availableLocales
    : [{ id: "en", label: "English" }];
  const [form, setForm] = useState(() => ({
    ledger_currency: String(settings.ledger_currency || "PLN").toUpperCase(),
    locale: settings.locale || "en",
    timezone: settings.timezone || DEFAULT_TIMEZONE,
    holiday_country: String(settings.holiday_country || "PL").toUpperCase(),
    future_periods: settings.future_periods || 11,
    opening_balance: "0",
    income_enabled: true,
    income_name: "Income",
    income_amount: "0",
    income_anchor_day: 1
  }));
  const { busy, error, run } = useSubmit();

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    run(async () => {
      await apiFetch("/api/setup", {
        method: "POST",
        body: {
          ...form,
          opening_balance: String(form.opening_balance).replace(",", "."),
          income_amount: String(form.income_amount).replace(",", "."),
          future_periods: Number(form.future_periods || 11),
          income_anchor_day: Number(form.income_anchor_day || 1),
          income_enabled: form.income_enabled ? 1 : 0
        }
      });
      await onDone();
    });
  }

  const budgetName = snapshot?.session?.budgetDisplayName || snapshot?.session?.displayName || snapshot?.session?.budgetId || "";

  return (
    <EntryFrame
      title="Set up your budget"
      subtitle={`${budgetName ? `${budgetName}: ` : ""}a few basics before the planner can project your cashflow. You can change all of these later in Settings.`}
      onSignOut={onSignOut}
    >
      <form className="beta-panel beta-settings-section beta-entry-wide" onSubmit={handleSubmit}>
        {error ? <div className="beta-error">{error}</div> : null}

        <fieldset className="beta-admin-fieldset">
          <legend>Money</legend>
          <div className="beta-form-grid">
            <label className="beta-field">
              <span>Ledger currency</span>
              <select id="beta-setup-currency" value={form.ledger_currency} onChange={e => set("ledger_currency", e.target.value)}>
                {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="beta-field">
              <span>Opening balance</span>
              <input id="beta-setup-opening" inputMode="decimal" pattern={AMOUNT_PATTERN} value={form.opening_balance}
                required onChange={e => set("opening_balance", e.target.value)} />
              <small className="beta-hint">What the account holds today, in the ledger currency.</small>
            </label>
          </div>
        </fieldset>

        <fieldset className="beta-admin-fieldset">
          <legend>Regional</legend>
          <div className="beta-form-grid">
            <label className="beta-field">
              <span>Language</span>
              <select id="beta-setup-locale" value={form.locale} onChange={e => set("locale", e.target.value)}>
                {locales.map(l => <option key={l.id} value={l.id}>{l.label || l.id}</option>)}
              </select>
            </label>
            <label className="beta-field">
              <span>Timezone</span>
              <input id="beta-setup-timezone" list="beta-setup-timezones" value={form.timezone} required onChange={e => set("timezone", e.target.value)} />
              <datalist id="beta-setup-timezones">
                {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz} />)}
              </datalist>
            </label>
            <label className="beta-field">
              <span>Holiday country</span>
              <select id="beta-setup-holidays" value={form.holiday_country} onChange={e => set("holiday_country", e.target.value)}>
                {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} &ndash; {c.label}</option>)}
              </select>
              <small className="beta-hint">Payment dates that land on a public holiday move to a working day.</small>
            </label>
            <label className="beta-field">
              <span>Projection horizon (periods)</span>
              <input id="beta-setup-horizon" type="number" min="1" max="60" value={form.future_periods} required
                onChange={e => set("future_periods", e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset className="beta-admin-fieldset">
          <legend>Income</legend>
          <label className="beta-field beta-field-checkbox">
            <input id="beta-setup-income-enabled" type="checkbox" checked={form.income_enabled} onChange={e => set("income_enabled", e.target.checked)} />
            <span>Add a monthly income now</span>
          </label>
          {form.income_enabled ? (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>Income name</span>
                <input id="beta-setup-income-name" value={form.income_name} required maxLength={120} onChange={e => set("income_name", e.target.value)} />
              </label>
              <label className="beta-field">
                <span>Monthly amount</span>
                <input id="beta-setup-income-amount" inputMode="decimal" pattern={AMOUNT_PATTERN} value={form.income_amount} required
                  onChange={e => set("income_amount", e.target.value)} />
              </label>
              <label className="beta-field">
                <span>Pay day</span>
                <input id="beta-setup-income-day" type="number" min="1" max="31" value={form.income_anchor_day} required
                  onChange={e => set("income_anchor_day", e.target.value)} />
                <small className="beta-hint">Day of the month the income arrives.</small>
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="beta-form-actions beta-form-actions-gap">
          {onSwitchBudget ? <button type="button" className="beta-btn-small" onClick={onSwitchBudget} disabled={busy}>Choose another budget</button> : null}
          <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? "Setting up..." : "Complete setup"}</button>
        </div>
      </form>
    </EntryFrame>
  );
}
