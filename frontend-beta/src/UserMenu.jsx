import { formatMessage, t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import { AvatarIcon } from "./AvatarIcons.jsx";

export default function UserMenu({ account, onSelectSettings, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef(null);
  const name = account?.displayName || account?.id || t("Account");

  useEffect(() => {
    if (!open) return undefined;
    function handleClick(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function switchToLegacy() {
    localStorage.setItem("cashflow_preferred_ui", "legacy");
    window.location.href = "/";
  }

  async function handleLogout() {
    setBusy(true);
    setOpen(false);
    await onSignOut();
  }

  return (
    <div className="beta-user-menu" ref={menuRef}>
      <button type="button" className="beta-user-menu-trigger" onClick={() => setOpen(value => !value)}
        aria-haspopup="true" aria-expanded={open} aria-label={formatMessage("Account menu: {name}", { name })} title={name}>
        <AvatarIcon account={account || { id: name }} size={28} />
      </button>
      {open ? (
        <div className="beta-user-menu-panel" role="menu">
          <div className="beta-user-menu-account">
            <AvatarIcon account={account || { id: name }} size={48} />
            <div><strong>{name}</strong>{account?.email ? <span>{account.email}</span> : null}</div>
          </div>
          <div className="beta-user-menu-section">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onSelectSettings(); }}>{t("Settings")}</button>
            <button type="button" role="menuitem" onClick={switchToLegacy}>{t("Switch to legacy UI")}</button>
            <button type="button" role="menuitem" disabled={busy} onClick={handleLogout}>{t("Sign out")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
