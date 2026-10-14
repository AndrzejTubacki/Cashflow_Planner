import { formatMessage, t } from "./i18n.js";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { formatDate } from "./format.js";
import { applyUiPreferences, loadUiPreferences, saveUiPreferences, UI_DENSITY_OPTIONS, UI_DEFAULT_TAB_OPTIONS, UI_THEME_OPTIONS } from "./uiPreferences.js";
import { AvatarIcon, AVATAR_IDS, AVATAR_LABELS } from "./AvatarIcons.jsx";
import { resolvedAvatarId } from "./avatar.js";

const PASSWORD_MIN_LENGTH = 12;

function ProfilePanel({ account, onSaved }) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [email, setEmail] = useState(account.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const externalMode = account.authMode === "external";
  const emailChanged = email.trim().toLowerCase() !== String(account.email || "").toLowerCase();
  const needsCurrentPassword = emailChanged && account.hasPasswordCredential;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const body = { displayName };
      if (emailChanged && !externalMode) {
        body.email = email.trim();
        if (needsCurrentPassword) body.currentPassword = currentPassword;
      }
      const result = await apiFetch("/api/account", { method: "PUT", body });
      setCurrentPassword("");
      setSaved(true);
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || t("Failed to save your profile"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-panel beta-settings-section" onSubmit={handleSubmit}>
      <h3>{t("Profile")}</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">{t("Profile saved.")}</div> : null}
      <div className="beta-form-grid">
        <label className="beta-field">
          <span>{t("Display name")}</span>
          <input id="beta-account-display-name" value={displayName} required maxLength={120} onChange={e => setDisplayName(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>{t("Email")}</span>
          <input
            id="beta-account-email"
            type="email"
            value={email}
            disabled={externalMode}
            autoComplete="email"
            onChange={e => setEmail(e.target.value)}
          />
          <small className="beta-hint">
            {externalMode
              ? t("Your email is managed by your sign-in provider.")
              : t("Used to sign in when Cashflow sign-in is active.")}
          </small>
        </label>
        {needsCurrentPassword ? (
          <label className="beta-field">
            <span>{t("Current password")}</span>
            <input
              id="beta-account-email-current-password"
              type="password"
              value={currentPassword}
              required
              autoComplete="current-password"
              onChange={e => setCurrentPassword(e.target.value)}
            />
            <small className="beta-hint">{t("Needed to change the email you sign in with.")}</small>
          </label>
        ) : null}
      </div>
      <div className="beta-field">
        <span>{t("Account ID")}</span>
        <strong className="beta-mono">{account.id}</strong>
        <small className="beta-hint">{t("Fixed when the account was created.")}</small>
      </div>
      <div className="beta-form-actions beta-form-actions-start">
        <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? t("Saving...") : t("Save profile")}</button>
      </div>
    </form>
  );
}

function AppearancePanel({ account, onSaved }) {
  const [prefs, setPrefs] = useState(() => loadUiPreferences(account.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = resolvedAvatarId(account);

  function updatePrefs(change) {
    const next = saveUiPreferences(account.id, { ...prefs, ...change });
    setPrefs(next);
    applyUiPreferences(next);
  }

  async function chooseAvatar(avatar) {
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/account", { method: "PUT", body: { avatar } });
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || t("Could not save your account icon"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-panel beta-settings-section">
      <h3>{t("Appearance")}</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      <div className="beta-avatar-picker" role="radiogroup" aria-label={t("Account icon")}>
        {AVATAR_IDS.map(id => (
          <button key={id} type="button" role="radio" aria-checked={selected === id}
            className={`beta-avatar-choice${selected === id ? " is-selected" : ""}`}
            aria-label={t(AVATAR_LABELS[id])} title={t(AVATAR_LABELS[id])} disabled={busy}
            onClick={() => chooseAvatar(id)}>
            <AvatarIcon id={id} size={52} />
          </button>
        ))}
      </div>
      <div className="beta-form-grid beta-form-grid-wide">
        <label className="beta-field">
          <span>{t("Theme")}</span>
          <select value={prefs.theme} onChange={event => updatePrefs({ theme: event.target.value })}>
            {UI_THEME_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.label)}</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>{t("Density")}</span>
          <select value={prefs.density} onChange={event => updatePrefs({ density: event.target.value })}>
            {UI_DENSITY_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.label)}</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>{t("Default landing page")}</span>
          <select value={prefs.defaultTab} onChange={event => updatePrefs({ defaultTab: event.target.value })}>
            {UI_DEFAULT_TAB_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.label)}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function PasswordPanel({ account, onSaved }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const hasPassword = account.hasPasswordCredential;

  if (account.authMode === "external") {
    return (
      <div className="beta-panel">
        <h3>{t("Password")}</h3>
        <p className="beta-empty">{t("Your password is managed by your sign-in provider.")}</p>
      </div>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaved("");
    if (newPassword !== confirmPassword) {
      setError(t("The new passwords don't match."));
      return;
    }
    setBusy(true);
    try {
      const body = { newPassword };
      if (hasPassword) body.currentPassword = currentPassword;
      const result = await apiFetch("/api/account/password", { method: "POST", body });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSaved(hasPassword
        ? "Password changed. Your other sessions were signed out."
        : "Password set.");
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || t("Failed to save your password"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-panel beta-settings-section" onSubmit={handleSubmit}>
      <h3>{t("Password")}</h3>
      <p className="beta-hint">
        {!hasPassword && (account.identities || []).length
          ? t("Password sign-in is off; you sign in with your linked provider. Set a password to turn it back on.")
          : hasPassword
          ? t("Changing your password signs you out everywhere except this browser.")
          : account.email
            ? t("You don't have a password yet. Set one to be able to sign in once Cashflow sign-in is active.")
            : t("Add an email in your profile first. You sign in with your email and this password.")}
      </p>
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">{saved}</div> : null}
      <div className="beta-form-grid">
        {hasPassword ? (
          <label className="beta-field">
            <span>{t("Current password")}</span>
            <input
              id="beta-account-current-password"
              type="password"
              value={currentPassword}
              required
              autoComplete="current-password"
              onChange={e => setCurrentPassword(e.target.value)}
            />
          </label>
        ) : null}
        <label className="beta-field">
          <span>{t("New password")}</span>
          <input
            id="beta-account-new-password"
            type="password"
            value={newPassword}
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={1024}
            autoComplete="new-password"
            disabled={!account.email}
            onChange={e => setNewPassword(e.target.value)}
          />
          <small className="beta-hint">{formatMessage("At least {count} characters.", { count: PASSWORD_MIN_LENGTH })}</small>
        </label>
        <label className="beta-field">
          <span>{t("Confirm new password")}</span>
          <input
            id="beta-account-confirm-password"
            type="password"
            value={confirmPassword}
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={1024}
            autoComplete="new-password"
            disabled={!account.email}
            onChange={e => setConfirmPassword(e.target.value)}
          />
        </label>
      </div>
      <div className="beta-form-actions beta-form-actions-start">
        <button type="submit" className="beta-btn-primary" disabled={busy || !account.email}>
          {busy ? t("Saving...") : hasPassword ? t("Change password") : t("Set password")}
        </button>
      </div>
    </form>
  );
}

function formatWhen(value) {
  return formatDate(value);
}

function LinkedSignInsPanel({ account, onSaved }) {
  const [providers, setProviders] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/auth/config", { cache: "no-store", scoped: false })
      .then(result => setProviders(Array.isArray(result?.auth?.internal?.providers) ? result.auth.internal.providers : []))
      .catch(() => setProviders([]));
  }, []);

  const identities = account.identities || [];
  const nameFor = id => providers?.find(provider => provider.id === id)?.displayName || id;
  const internalActive = account.authMode === "internal";

  if (account.authMode === "external") return null;
  if (providers && !providers.length && !identities.length) return null;

  async function link(providerId) {
    setBusy(providerId);
    setError("");
    try {
      const result = await apiFetch(`/api/auth/providers/${encodeURIComponent(providerId)}/link/start`, {
        method: "POST",
        body: {},
        scoped: false
      });
      if (!result?.authorizationUrl) throw new Error(t("The provider didn't return a sign-in address."));
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err.message || t("Couldn't start linking"));
      setBusy("");
    }
  }

  async function unlink(identity) {
    if (!window.confirm(formatMessage("Unlink {provider}{email}? You won’t be able to sign in with it any more.", {
      provider: nameFor(identity.providerId), email: identity.email ? ` (${identity.email})` : ""
    }))) return;
    setBusy(identity.id);
    setError("");
    try {
      const result = await apiFetch(`/api/account/identities/${encodeURIComponent(identity.id)}`, { method: "DELETE", scoped: false });
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || t("Couldn't unlink"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="beta-panel beta-settings-section">
      <h3>{t("Linked sign-ins")}</h3>
      <p className="beta-hint">
        {internalActive
          ? t("Link a provider to sign in with it instead of your password. You'll be sent to the provider and brought back here.")
          : t("Linking becomes available once Cashflow sign-in is the active sign-in mode.")}
      </p>
      {error ? <div className="beta-error">{error}</div> : null}
      {identities.length ? (
        <div className="beta-budget-list">
          {identities.map(identity => (
            <div className="beta-budget-row" key={identity.id}>
              <div className="beta-budget-row-main">
                <strong>{nameFor(identity.providerId)}</strong>
                <span className="beta-budget-meta">
                  {identity.email && !identity.emailVerified
                    ? formatMessage("Email {email} is not verified by the provider", { email: identity.email })
                    : identity.email || t("No email shared")}
                  {identity.linkedAt ? ` · linked ${formatWhen(identity.linkedAt)}` : ""}
                  {identity.lastUsedAt ? ` · last used ${formatWhen(identity.lastUsedAt)}` : ""}
                </span>
              </div>
              <div className="beta-budget-row-actions">
                <button type="button" className="beta-btn-small beta-btn-danger" disabled={Boolean(busy)} onClick={() => unlink(identity)}>
                  {busy === identity.id ? t("Unlinking...") : t("Unlink")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="beta-empty">{t("No sign-ins linked yet.")}</p>}
      {internalActive && providers?.length ? (
        <div className="beta-form-actions beta-form-actions-start">
          {providers.map(provider => (
            <button key={provider.id} type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => link(provider.id)}>
              {busy === provider.id ? t("Opening...") : `Link ${provider.displayName || provider.id}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PasswordOffPanel({ account, onSaved }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const linked = (account.identities || []).length > 0;

  if (account.authMode === "external" || !account.hasPasswordCredential) return null;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!window.confirm(t("Turn off password sign-in? You'll sign in with your linked provider only. You can set a password again at any time."))) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch("/api/account/password", { method: "DELETE", body: { currentPassword }, scoped: false });
      setCurrentPassword("");
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || t("Couldn't turn off password sign-in"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-panel beta-settings-section" onSubmit={handleSubmit}>
      <h3>{t("Sign in without a password")}</h3>
      <p className="beta-hint">
        {linked
          ? t("Prefer to sign in only with your linked provider? Turn off your password. Setting a new password turns it back on.")
          : t("Link a sign-in provider below first; then you can turn off your password and sign in with the provider only.")}
      </p>
      {error ? <div className="beta-error">{error}</div> : null}
      {linked ? (
        <>
          <label className="beta-field beta-entry-narrow">
            <span>{t("Current password")}</span>
            <input id="beta-account-off-password" type="password" value={currentPassword} required autoComplete="current-password"
              onChange={e => setCurrentPassword(e.target.value)} />
          </label>
          <div className="beta-form-actions beta-form-actions-start">
            <button type="submit" className="beta-btn-small beta-btn-danger" disabled={busy}>{busy ? t("Turning off...") : t("Turn off password sign-in")}</button>
          </div>
        </>
      ) : null}
    </form>
  );
}

export default function AccountView({ onRefresh, notice = null, onDismissNotice = () => {}, embedded = false }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiFetch("/api/account", { cache: "no-store", scoped: false });
      setAccount(result.account);
      setError("");
    } catch (err) {
      setError(err.message || t("Could not load your account"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = useCallback(async next => {
    setAccount(next);
    await onRefresh();
  }, [onRefresh]);

  return (
    <section className="beta-view">
      {!embedded ? <div className="beta-view-head">
        <h1>{t("Account settings")}</h1>
        <p>{t("Your own profile and sign-in details. Settings for the current budget are under Budget settings in the account menu.")}</p>
      </div> : null}
      {notice ? (
        <div className={notice.kind === "error" ? "beta-error beta-notice" : "beta-success beta-notice"} role="status">
          <span>{notice.message}</span>
          <button type="button" className="beta-modal-close" aria-label={t("Dismiss")} onClick={onDismissNotice}>&times;</button>
        </div>
      ) : null}
      {error ? <div className="beta-error">{error}</div> : null}
      {account ? (
        <>
          <AppearancePanel account={account} onSaved={handleSaved} />
          <ProfilePanel account={account} onSaved={handleSaved} />
          <PasswordPanel account={account} onSaved={handleSaved} />
          <LinkedSignInsPanel account={account} onSaved={handleSaved} />
          <PasswordOffPanel account={account} onSaved={handleSaved} />
        </>
      ) : !error ? <p className="beta-empty">{t("Loading your account...")}</p> : null}
    </section>
  );
}
