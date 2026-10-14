import { formatMessage, formatParts, t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import { formatDateTime } from "./format.js";

const EXPIRY_OPTIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" }
];

// navigator.clipboard only exists in secure contexts; plain-http LAN installs need the legacy path.
async function copyText(text, input) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy.
    }
  }
  input?.focus();
  input?.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function formatExpiry(expiresAt) {
  return formatDateTime(expiresAt) || String(expiresAt || "");
}

export default function PasswordTokenModal({ account, purpose, internalLoginActive, isSelf, onClose }) {
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copyStatus, setCopyStatus] = useState("");
  const tokenRef = useRef(null);

  const label = account.display_name || account.id;
  const title = purpose === "password_setup" ? "Create password setup token" : "Create password reset token";

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleCreate(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/password-reset-token`, {
        method: "POST",
        body: { purpose, expiresInHours: Number(expiresInHours) }
      });
      setResult(created);
    } catch (err) {
      setError(err.message || t("Failed to create password token"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    const copied = await copyText(result.token, tokenRef.current);
    setCopyStatus(copied ? "copied" : "failed");
  }

  const email = result?.account?.email || account.email || "";

  return (
    <div className="beta-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="beta-modal" role="dialog" aria-modal="true" aria-labelledby="beta-token-title">
        <div className="beta-modal-head">
          <h2 id="beta-token-title">{title}</h2>
          <button type="button" className="beta-modal-close" onClick={onClose} aria-label={t("Close")}>&times;</button>
        </div>

        {!result ? (
          <form className="beta-modal-form" onSubmit={handleCreate}>
            {error ? <div className="beta-error">{error}</div> : null}
            <p className="beta-token-copy-line">{t("Account:")} <strong>{label}</strong></p>
            <label className="beta-field">
              <span>{t("Token expires after")}</span>
              <select id="beta-token-expiry" value={expiresInHours} onChange={e => setExpiresInHours(e.target.value)}>
                {EXPIRY_OPTIONS.map(o => <option key={o.hours} value={o.hours}>{t(o.label)}</option>)}
              </select>
            </label>
            <p className="beta-hint">{t("Creating a token cancels any earlier unused token for this account.")}</p>
            <div className="beta-form-actions beta-form-actions-gap">
              <button type="button" className="beta-btn-small" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
              <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? t("Creating...") : t("Create token")}</button>
            </div>
          </form>
        ) : (
          <div className="beta-modal-form">
            <div className="beta-field">
              <label htmlFor="beta-token-value">{t("Password token")}</label>
              <div className="beta-token-row">
                <input
                  id="beta-token-value"
                  ref={tokenRef}
                  readOnly
                  value={result.token || ""}
                  onFocus={e => e.target.select()}
                />
                <button type="button" className="beta-btn-primary" onClick={handleCopy}>
                  {copyStatus === "copied" ? t("Copied") : t("Copy")}
                </button>
              </div>
            </div>
            {copyStatus === "copied" ? <p className="beta-success" role="status">{t("Copied to clipboard.")}</p> : null}
            {copyStatus === "failed" ? (
              <p className="beta-error" role="status">{t("Copy failed. Select the token and copy it manually.")}</p>
            ) : null}

            <p className="beta-token-copy-line">{formatParts("Valid until {date}. It can be used once.", {
              date: <strong>{formatExpiry(result.expiresAt)}</strong>
            })}</p>

            {!internalLoginActive ? (
              <div className="beta-error">{t("Cashflow sign-in isn’t the active sign-in mode yet, so the token can’t be used on the sign-in page.")}{" "}
                {isSelf
                  ? t("To set your own password now, use Account settings in the account menu instead.")
                  : t("Activate Cashflow sign-in under Authentication before sending this token.")}
              </div>
            ) : null}

            <div className="beta-token-steps">
              <h3>{t("How to use it")}</h3>
              <ol>
                <li>{formatMessage("Send the token to {account} privately. Anyone who has it can set this account’s password.", { account: label })}</li>
                <li>{formatParts("They open Cashflow, enter {email} on the sign-in page, paste the token into the password field and select Sign in.", {
                  email: <strong>{email || t("Their email")}</strong>
                })}</li>
                <li>{t("Cashflow asks them to choose a password of at least 12 characters, then signs them in.")}</li>
              </ol>
              {(result.purpose || purpose) === "password_reset" ? (
                <p className="beta-hint">{t("Setting the new password signs this account out of every existing session.")}</p>
              ) : null}
              <p className="beta-hint">{t("This is the only time the token is shown. If it is lost, create a new one.")}</p>
            </div>

            <div className="beta-form-actions">
              <button type="button" className="beta-btn-primary" onClick={onClose}>{t("Done")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
