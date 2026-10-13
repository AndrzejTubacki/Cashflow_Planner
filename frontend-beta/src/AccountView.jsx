import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api.js";

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
      setError(err.message || "Failed to save your profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-panel beta-settings-section" onSubmit={handleSubmit}>
      <h3>Profile</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">Profile saved.</div> : null}
      <div className="beta-form-grid">
        <label className="beta-field">
          <span>Display name</span>
          <input id="beta-account-display-name" value={displayName} required maxLength={120} onChange={e => setDisplayName(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>Email</span>
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
              ? "Your email is managed by your sign-in provider."
              : "Used to sign in when internal login is active."}
          </small>
        </label>
        {needsCurrentPassword ? (
          <label className="beta-field">
            <span>Current password</span>
            <input
              id="beta-account-email-current-password"
              type="password"
              value={currentPassword}
              required
              autoComplete="current-password"
              onChange={e => setCurrentPassword(e.target.value)}
            />
            <small className="beta-hint">Needed to change the email you sign in with.</small>
          </label>
        ) : null}
      </div>
      <div className="beta-field">
        <span>Account ID</span>
        <strong className="beta-mono">{account.id}</strong>
        <small className="beta-hint">Fixed when the account was created.</small>
      </div>
      <div className="beta-form-actions beta-form-actions-start">
        <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? "Saving..." : "Save profile"}</button>
      </div>
    </form>
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
        <h3>Password</h3>
        <p className="beta-empty">Your password is managed by your sign-in provider.</p>
      </div>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaved("");
    if (newPassword !== confirmPassword) {
      setError("The new passwords don't match.");
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
      setError(err.message || "Failed to save your password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-panel beta-settings-section" onSubmit={handleSubmit}>
      <h3>Password</h3>
      <p className="beta-hint">
        {hasPassword
          ? "Changing your password signs you out everywhere except this browser."
          : account.email
            ? "You don't have a password yet. Set one to be able to sign in once internal login is active."
            : "Add an email in your profile first. You sign in with your email and this password."}
      </p>
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">{saved}</div> : null}
      <div className="beta-form-grid">
        {hasPassword ? (
          <label className="beta-field">
            <span>Current password</span>
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
          <span>New password</span>
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
          <small className="beta-hint">At least {PASSWORD_MIN_LENGTH} characters.</small>
        </label>
        <label className="beta-field">
          <span>Confirm new password</span>
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
          {busy ? "Saving..." : hasPassword ? "Change password" : "Set password"}
        </button>
      </div>
    </form>
  );
}

function formatWhen(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" });
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
      if (!result?.authorizationUrl) throw new Error("The provider didn't return a sign-in address.");
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err.message || "Couldn't start linking");
      setBusy("");
    }
  }

  async function unlink(identity) {
    if (!window.confirm(`Unlink ${nameFor(identity.providerId)}${identity.email ? ` (${identity.email})` : ""}? You won't be able to sign in with it any more.`)) return;
    setBusy(identity.id);
    setError("");
    try {
      const result = await apiFetch(`/api/account/identities/${encodeURIComponent(identity.id)}`, { method: "DELETE", scoped: false });
      await onSaved(result.account);
    } catch (err) {
      setError(err.message || "Couldn't unlink");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="beta-panel beta-settings-section">
      <h3>Linked sign-ins</h3>
      <p className="beta-hint">
        {internalActive
          ? "Link a provider to sign in with it instead of your password. You'll be sent to the provider and brought back here."
          : "Linking becomes available once internal login is the active sign-in mode."}
      </p>
      {error ? <div className="beta-error">{error}</div> : null}
      {identities.length ? (
        <div className="beta-budget-list">
          {identities.map(identity => (
            <div className="beta-budget-row" key={identity.id}>
              <div className="beta-budget-row-main">
                <strong>{nameFor(identity.providerId)}</strong>
                <span className="beta-budget-meta">
                  {identity.email || "No email shared"}
                  {identity.email && !identity.emailVerified ? " (not verified by the provider)" : ""}
                  {identity.linkedAt ? ` · linked ${formatWhen(identity.linkedAt)}` : ""}
                  {identity.lastUsedAt ? ` · last used ${formatWhen(identity.lastUsedAt)}` : ""}
                </span>
              </div>
              <div className="beta-budget-row-actions">
                <button type="button" className="beta-btn-small beta-btn-danger" disabled={Boolean(busy)} onClick={() => unlink(identity)}>
                  {busy === identity.id ? "Unlinking..." : "Unlink"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="beta-empty">No sign-ins linked yet.</p>}
      {internalActive && providers?.length ? (
        <div className="beta-form-actions beta-form-actions-start">
          {providers.map(provider => (
            <button key={provider.id} type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => link(provider.id)}>
              {busy === provider.id ? "Opening..." : `Link ${provider.displayName || provider.id}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function AccountView({ onRefresh, notice = null, onDismissNotice = () => {} }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiFetch("/api/account", { cache: "no-store", scoped: false });
      setAccount(result.account);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load your account");
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
      <div className="beta-view-head">
        <h1>Account settings</h1>
        <p>Your own profile and sign-in details. Settings for the current budget are under Budget settings in the account menu.</p>
      </div>
      {notice ? (
        <div className={notice.kind === "error" ? "beta-error beta-notice" : "beta-success beta-notice"} role="status">
          <span>{notice.message}</span>
          <button type="button" className="beta-modal-close" aria-label="Dismiss" onClick={onDismissNotice}>&times;</button>
        </div>
      ) : null}
      {error ? <div className="beta-error">{error}</div> : null}
      {account ? (
        <>
          <ProfilePanel account={account} onSaved={handleSaved} />
          <PasswordPanel account={account} onSaved={handleSaved} />
          <LinkedSignInsPanel account={account} onSaved={handleSaved} />
        </>
      ) : !error ? <p className="beta-empty">Loading your account...</p> : null}
    </section>
  );
}
