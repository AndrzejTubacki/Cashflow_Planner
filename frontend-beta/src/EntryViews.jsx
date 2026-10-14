import { formatMessage, t } from "./i18n.js";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, setCsrfToken } from "./api.js";
import ProviderButton from "./ProviderButton.jsx";
import { DEFAULT_TIMEZONE, HOLIDAY_COUNTRIES, SUPPORTED_FX_CURRENCIES, TIMEZONE_OPTIONS } from "./constants.js";

const ACCOUNT_ID_PATTERN = "[A-Za-z0-9_\\-]{1,64}";

function EntryFrame({ title, subtitle, onSignOut, centered = false, children }) {
  return (
    <div className={centered ? "beta-entry beta-entry--centered" : "beta-entry"}>
      <header className="beta-entry-head">
        <div className="beta-wordmark">
          <span className="beta-mark">&#8353;</span>{t("Cashflow")}<span className="beta-badge">{t("BETA")}</span>
        </div>
        {onSignOut ? (
          <button type="button" className="beta-btn-small" onClick={onSignOut}>{t("Sign out")}</button>
        ) : null}
      </header>
      <div className="beta-entry-title">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children}
      <p className="beta-entry-foot">
        <a href="/?ui=legacy" onClick={() => localStorage.setItem("cashflow_preferred_ui", "legacy")}>{t("Use the legacy app instead")}</a>
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
      setError(err.message || t("Something went wrong"));
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
        <h3>{t("Accounts")}</h3>
        {accounts === null ? <p className="beta-empty">{t("Loading accounts...")}</p> : null}
        {accounts !== null && !visibleAccounts.length && !showLegacyUsers ? (
          <p className="beta-empty">{t("No accounts yet. Create the first one to get started — it becomes the administrator.")}</p>
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
                {(account.globalRoles || []).includes("system_admin")
                  ? formatMessage("Account {id} · administrator", { id: account.id })
                  : account.id}
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
        <h3>{t("Create account")}</h3>
        {error ? <div className="beta-error">{error}</div> : null}
        <label className="beta-field">
          <span>{t("Account ID")}</span>
          <input
            id="beta-create-account-id"
            value={userId}
            required
            maxLength={64}
            pattern={ACCOUNT_ID_PATTERN}
            autoComplete="username"
            onChange={e => setUserId(e.target.value)}
          />
          <small className="beta-hint">{t("Letters, numbers, underscores or hyphens. It can’t be changed later.")}</small>
        </label>
        <label className="beta-field">
          <span>{t("Display name")}</span>
          <input id="beta-create-account-name" value={displayName} maxLength={120} onChange={e => setDisplayName(e.target.value)} />
        </label>
        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>{t("Create and continue")}</button>
        </div>
      </form>
    </div>
  );
}

function InternalLogin({ auth, onSignedIn, onRegister, onPasswordSetup }) {
  const providers = Array.isArray(auth?.internal?.providers) ? auth.internal.providers : [];
  const passwordLogin = auth?.internal?.allowPasswordLogin !== false;
  const login = useSubmit();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function handleLogin(event) {
    event.preventDefault();
    login.run(async () => {
      const result = await apiFetch("/api/auth/internal/login", { method: "POST", body: { email, password }, scoped: false });
      if (result?.passwordSetupRequired) {
        onPasswordSetup({ email: email.trim(), token: password, purpose: result.purpose });
        return;
      }
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
      if (!result?.authorizationUrl) throw new Error(t("Provider login did not return an authorization URL"));
      window.location.assign(result.authorizationUrl);
    });
  }

  return (
    <div className="beta-panel beta-settings-section beta-signin-card">
      {login.error ? <div className="beta-error">{login.error}</div> : null}
      {passwordLogin ? (
        <form className="beta-settings-section beta-signin-form" onSubmit={handleLogin}>
          <label className="beta-field">
            <span>{t("Email")}</span>
            <input id="beta-login-email" type="email" value={email} required autoComplete="username" onChange={e => setEmail(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Password")}</span>
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
            <small className="beta-hint">{t("Got a password token from an administrator? Paste it here to choose your password.")}</small>
          </label>
          <button type="submit" className="beta-btn-primary beta-signin-submit" disabled={login.busy}>
            {login.busy ? t("Signing in...") : t("Sign in")}
          </button>
        </form>
      ) : null}

      {passwordLogin && providers.length ? <div className="beta-signin-divider" role="separator"><span>{t("or")}</span></div> : null}

      {providers.length ? (
        <div className="beta-signin-providers">
          {providers.map(provider => (
            <ProviderButton key={provider.id} provider={provider} disabled={login.busy} onClick={() => startProvider(provider.id)} />
          ))}
        </div>
      ) : null}

      <p className="beta-signin-foot">{t("Have an invitation?")}{" "}
        <button type="button" className="beta-link-btn" onClick={onRegister}>{t("Create your account")}</button>
      </p>
    </div>
  );
}

function RegisterView({ onSignedIn, onBack }) {
  const register = useSubmit();
  const [form, setForm] = useState({ invitationToken: "", email: "", displayName: "", password: "", confirm: "" });
  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  function handleSubmit(event) {
    event.preventDefault();
    if (form.password !== form.confirm) {
      register.setError(t("The passwords don't match."));
      return;
    }
    register.run(async () => {
      const { confirm: _confirm, ...body } = form;
      const result = await apiFetch("/api/auth/internal/register", { method: "POST", body, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  return (
    <form className="beta-panel beta-settings-section beta-signin-card" onSubmit={handleSubmit}>
      {register.error ? <div className="beta-error">{register.error}</div> : null}
      <label className="beta-field">
        <span>{t("Invitation token")}</span>
        <input id="beta-invite-token" value={form.invitationToken} required autoComplete="off" onChange={e => set("invitationToken", e.target.value)} />
        <small className="beta-hint">{t("From the invitation someone sent you.")}</small>
      </label>
      <label className="beta-field">
        <span>{t("Email")}</span>
        <input id="beta-invite-email" type="email" value={form.email} required autoComplete="username" onChange={e => set("email", e.target.value)} />
      </label>
      <label className="beta-field">
        <span>{t("Display name")}</span>
        <input id="beta-invite-name" value={form.displayName} required maxLength={120} autoComplete="name" onChange={e => set("displayName", e.target.value)} />
      </label>
      <label className="beta-field">
        <span>{t("Password")}</span>
        <input id="beta-invite-password" type="password" value={form.password} required minLength={12} maxLength={1024}
          autoComplete="new-password" onChange={e => set("password", e.target.value)} />
        <small className="beta-hint">{t("At least 12 characters.")}</small>
      </label>
      <label className="beta-field">
        <span>{t("Confirm password")}</span>
        <input id="beta-invite-confirm" type="password" value={form.confirm} required minLength={12} maxLength={1024}
          autoComplete="new-password" onChange={e => set("confirm", e.target.value)} />
      </label>
      <button type="submit" className="beta-btn-primary beta-signin-submit" disabled={register.busy}>
        {register.busy ? t("Creating...") : t("Create account")}
      </button>
      <p className="beta-signin-foot">{t("Already have an account?")} <button type="button" className="beta-link-btn" onClick={onBack}>{t("Sign in")}</button>
      </p>
    </form>
  );
}

function PasswordSetupView({ email, token, purpose, onSignedIn, onBack }) {
  const setup = useSubmit();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    if (password !== confirm) {
      setup.setError(t("The passwords don't match."));
      return;
    }
    setup.run(async () => {
      await apiFetch("/api/auth/internal/password", { method: "POST", body: { token, password }, scoped: false });
      const result = await apiFetch("/api/auth/internal/login", { method: "POST", body: { email, password }, scoped: false });
      rememberSession(result);
      await onSignedIn();
    });
  }

  return (
    <form className="beta-panel beta-settings-section beta-signin-card" onSubmit={handleSubmit}>
      <p className="beta-hint">
        {purpose === "password_reset"
          ? t("Your administrator reset your password. Choose a new one; this signs you out everywhere else.")
          : t("Choose the password you'll sign in with.")}
      </p>
      {setup.error ? <div className="beta-error">{setup.error}</div> : null}
      <div className="beta-field">
        <span>{t("Email")}</span>
        <strong>{email}</strong>
      </div>
      <label className="beta-field">
        <span>{t("New password")}</span>
        <input id="beta-setup-new-password" type="password" value={password} required minLength={12} maxLength={1024}
          autoComplete="new-password" autoFocus onChange={e => setPassword(e.target.value)} />
        <small className="beta-hint">{t("At least 12 characters.")}</small>
      </label>
      <label className="beta-field">
        <span>{t("Confirm new password")}</span>
        <input id="beta-setup-confirm-password" type="password" value={confirm} required minLength={12} maxLength={1024}
          autoComplete="new-password" onChange={e => setConfirm(e.target.value)} />
      </label>
      <button type="submit" className="beta-btn-primary beta-signin-submit" disabled={setup.busy}>
        {setup.busy ? t("Saving...") : t("Save password and sign in")}
      </button>
      <p className="beta-signin-foot">
        <button type="button" className="beta-link-btn" onClick={onBack}>{t("Back to sign in")}</button>
      </p>
    </form>
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
      <h3>{t("Single sign-on")}</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <p className="beta-hint">{t("This Cashflow instance signs you in through your organisation’s sign-in provider.")}</p>
      <div className="beta-form-actions beta-form-actions-start">
        <button type="button" className="beta-btn-primary" disabled={busy} onClick={handleContinue}>{t("Continue with SSO")}</button>
      </div>
    </div>
  );
}

export function SignInView({ auth, notice, onSignedIn }) {
  const mode = String(auth?.activeMode || "none");
  const [screen, setScreen] = useState({ name: "login" });

  if (mode === "internal" && screen.name === "register") {
    return (
      <EntryFrame centered title={t("Create your account")} subtitle={t("Use the invitation you were sent.")}>
        <RegisterView onSignedIn={onSignedIn} onBack={() => setScreen({ name: "login" })} />
      </EntryFrame>
    );
  }
  if (mode === "internal" && screen.name === "set-password") {
    return (
      <EntryFrame centered title={screen.purpose === "password_reset" ? t("Reset your password") : t("Create your password")}>
        <PasswordSetupView
          email={screen.email}
          token={screen.token}
          purpose={screen.purpose}
          onSignedIn={onSignedIn}
          onBack={() => setScreen({ name: "login" })}
        />
      </EntryFrame>
    );
  }

  return (
    <EntryFrame
      centered={mode !== "none"}
      title={mode === "none" ? t("Choose an account") : t("Sign in")}
      subtitle={mode === "none" ? t("This instance runs without sign-in, so pick an account or create one.") : null}
    >
      {notice ? <div className="beta-error beta-entry-narrow">{notice}</div> : null}
      {mode === "internal" ? (
        <InternalLogin
          auth={auth}
          onSignedIn={onSignedIn}
          onRegister={() => setScreen({ name: "register" })}
          onPasswordSetup={details => setScreen({ name: "set-password", ...details })}
        />
      ) : mode === "external" ? <ExternalLogin onSignedIn={onSignedIn} />
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
      if (!id) throw new Error(t("The budget was created but no id came back. Reload the page."));
      await select(id);
    });
  }

  function handleAccept(event) {
    event.preventDefault();
    setNotice("");
    invite.run(async () => {
      await apiFetch("/api/invitations/accept", { method: "POST", body: { token: inviteToken.trim() }, scoped: false });
      setInviteToken("");
      setNotice(t("Invitation accepted. The shared budget is now in your list."));
      await loadBudgets();
    });
  }

  const name = session?.accountDisplayName || session?.displayName || session?.accountId || "";

  return (
    <EntryFrame title={t("Choose a budget")} subtitle={name ? `Signed in as ${name}.` : null} onSignOut={onSignOut}>
      {authError ? <div className="beta-error beta-entry-narrow">{authError}</div> : null}
      <div className="beta-entry-grid">
        <div className="beta-panel">
          <h3>{t("Your budgets")}</h3>
          {list.error ? <div className="beta-error">{list.error}</div> : null}
          {budgets === null ? <p className="beta-empty">{t("Loading budgets...")}</p> : null}
          {budgets && !budgets.length ? <p className="beta-empty">{t("No budgets yet. Create one to get started.")}</p> : null}
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
                  {budget.id} &middot; {t(budget.role || "viewer")}{budget.status !== "active" ? ` · ${t(budget.status)}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="beta-entry-stack">
          <form className="beta-panel beta-settings-section" onSubmit={handleCreate}>
            <h3>{t("Create budget")}</h3>
            {create.error ? <div className="beta-error">{create.error}</div> : null}
            <label className="beta-field">
              <span>{t("Budget name")}</span>
              <input id="beta-new-budget-name" value={newName} required maxLength={120} onChange={e => setNewName(e.target.value)} />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-primary" disabled={create.busy}>{t("Create and continue")}</button>
            </div>
          </form>

          <form className="beta-panel beta-settings-section" onSubmit={handleAccept}>
            <h3>{t("Accept an invitation")}</h3>
            {invite.error ? <div className="beta-error">{invite.error}</div> : null}
            {notice ? <div className="beta-success" role="status">{notice}</div> : null}
            <label className="beta-field">
              <span>{t("Invitation token")}</span>
              <input id="beta-accept-invite-token" value={inviteToken} required autoComplete="off" onChange={e => setInviteToken(e.target.value)} />
            </label>
            <div className="beta-form-actions beta-form-actions-start">
              <button type="submit" className="beta-btn-small" disabled={invite.busy}>{t("Accept invitation")}</button>
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
      title={t("Set up your budget")}
      subtitle={`${budgetName ? `${budgetName}: ` : ""}a few basics before the planner can project your cashflow. You can change all of these later in Settings.`}
      onSignOut={onSignOut}
    >
      <form className="beta-panel beta-settings-section beta-entry-wide" onSubmit={handleSubmit}>
        {error ? <div className="beta-error">{error}</div> : null}

        <fieldset className="beta-admin-fieldset">
          <legend>{t("Money")}</legend>
          <div className="beta-form-grid">
            <label className="beta-field">
              <span>{t("Ledger currency")}</span>
              <select id="beta-setup-currency" value={form.ledger_currency} onChange={e => set("ledger_currency", e.target.value)}>
                {SUPPORTED_FX_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="beta-field">
              <span>{t("Opening balance")}</span>
              <input id="beta-setup-opening" inputMode="decimal" pattern={AMOUNT_PATTERN} value={form.opening_balance}
                required onChange={e => set("opening_balance", e.target.value)} />
              <small className="beta-hint">{t("What the account holds today, in the ledger currency.")}</small>
            </label>
          </div>
        </fieldset>

        <fieldset className="beta-admin-fieldset">
          <legend>{t("Regional")}</legend>
          <div className="beta-form-grid">
            <label className="beta-field">
              <span>{t("Language")}</span>
              <select id="beta-setup-locale" value={form.locale} onChange={e => set("locale", e.target.value)}>
                {locales.map(l => <option key={l.id} value={l.id}>{l.label || l.id}</option>)}
              </select>
            </label>
            <label className="beta-field">
              <span>{t("Timezone")}</span>
              <input id="beta-setup-timezone" list="beta-setup-timezones" value={form.timezone} required onChange={e => set("timezone", e.target.value)} />
              <datalist id="beta-setup-timezones">
                {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz} />)}
              </datalist>
            </label>
            <label className="beta-field">
              <span>{t("Holiday country")}</span>
              <select id="beta-setup-holidays" value={form.holiday_country} onChange={e => set("holiday_country", e.target.value)}>
                {HOLIDAY_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.code} &ndash; {t(c.label)}</option>)}
              </select>
              <small className="beta-hint">{t("Payment dates that land on a public holiday move to a working day.")}</small>
            </label>
            <label className="beta-field">
              <span>{t("Projection horizon (periods)")}</span>
              <input id="beta-setup-horizon" type="number" min="1" max="60" value={form.future_periods} required
                onChange={e => set("future_periods", e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset className="beta-admin-fieldset">
          <legend>{t("Income")}</legend>
          <label className="beta-field beta-field-checkbox">
            <input id="beta-setup-income-enabled" type="checkbox" checked={form.income_enabled} onChange={e => set("income_enabled", e.target.checked)} />
            <span>{t("Add a monthly income now")}</span>
          </label>
          {form.income_enabled ? (
            <div className="beta-form-grid">
              <label className="beta-field">
                <span>{t("Income name")}</span>
                <input id="beta-setup-income-name" value={form.income_name} required maxLength={120} onChange={e => set("income_name", e.target.value)} />
              </label>
              <label className="beta-field">
                <span>{t("Monthly amount")}</span>
                <input id="beta-setup-income-amount" inputMode="decimal" pattern={AMOUNT_PATTERN} value={form.income_amount} required
                  onChange={e => set("income_amount", e.target.value)} />
              </label>
              <label className="beta-field">
                <span>{t("Pay day")}</span>
                <input id="beta-setup-income-day" type="number" min="1" max="31" value={form.income_anchor_day} required
                  onChange={e => set("income_anchor_day", e.target.value)} />
                <small className="beta-hint">{t("Day of the month the income arrives.")}</small>
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="beta-form-actions beta-form-actions-gap">
          {onSwitchBudget ? <button type="button" className="beta-btn-small" onClick={onSwitchBudget} disabled={busy}>{t("Choose another budget")}</button> : null}
          <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? t("Setting up...") : t("Complete setup")}</button>
        </div>
      </form>
    </EntryFrame>
  );
}
