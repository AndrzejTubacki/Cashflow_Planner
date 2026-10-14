import { formatMessage, formatParts, t } from "./i18n.js";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";

const PROVIDER_ID_PATTERN = "[a-z0-9][a-z0-9_\\-]{0,79}";

// "Sign in with ..." providers. Endpoints for google/github/facebook come from server presets,
// so the form only sends what each provider actually needs.
export const IDENTITY_PROVIDER_GUIDES = {
  google: {
    label: "Google",
    blurb: "Google accounts, including Google Workspace.",
    defaultId: "google",
    clientIdLabel: "Client ID",
    secretLabel: "Client secret",
    defaultScope: "openid email profile",
    links: [
      { href: "https://console.cloud.google.com/apis/credentials", label: "Google Cloud Console: Credentials" },
      { href: "https://developers.google.com/identity/openid-connect/openid-connect", label: "Google OpenID Connect guide" }
    ],
    steps: [
      "In Google Cloud Console, open APIs & Services > Credentials (set up the OAuth consent screen first if Google asks).",
      "Create credentials > OAuth client ID, application type Web application.",
      "Under Authorized redirect URIs, add the callback URL shown below.",
      "Copy the Client ID into the form. Put the client secret on the Cashflow server (see Client secret)."
    ]
  },
  github: {
    label: "GitHub",
    blurb: "GitHub personal accounts.",
    defaultId: "github",
    clientIdLabel: "Client ID",
    secretLabel: "Client secret",
    defaultScope: "read:user user:email",
    links: [
      { href: "https://github.com/settings/applications/new", label: "GitHub: register a new OAuth app" },
      { href: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app", label: "GitHub OAuth app guide" }
    ],
    steps: [
      "On GitHub, open Settings > Developer settings > OAuth Apps > New OAuth App (an organisation's settings work too).",
      "Set Homepage URL to this Cashflow address and Authorization callback URL to the callback URL shown below.",
      "After registering, generate a client secret.",
      "Copy the Client ID into the form. Put the client secret on the Cashflow server (see Client secret)."
    ],
    note: "Cashflow uses the GitHub account's verified primary email (read with the user:email scope), so people need a verified primary email on GitHub to link it."
  },
  facebook: {
    label: "Facebook",
    blurb: "Facebook Login.",
    defaultId: "facebook",
    clientIdLabel: "App ID",
    secretLabel: "App secret",
    defaultScope: "email public_profile",
    links: [
      { href: "https://developers.facebook.com/apps/", label: "Meta for Developers: My Apps" },
      { href: "https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow", label: "Facebook Login manual flow guide" }
    ],
    steps: [
      "In Meta for Developers, create an app and add the Facebook Login product.",
      "In Facebook Login > Settings, add the callback URL shown below to Valid OAuth Redirect URIs.",
      "From App settings > Basic, copy the App ID into the form and keep the App secret for the server.",
      "Put the App secret on the Cashflow server (see App secret)."
    ],
    note: "Facebook doesn't say whether the email it shares is verified, so Cashflow links it as long as an email is shared and records it as unverified."
  },
  oidc: {
    label: "Other (OpenID Connect)",
    blurb: "Authentik, Keycloak, Authelia, Microsoft Entra ID, Okta and other OIDC providers.",
    defaultId: "",
    clientIdLabel: "Client ID",
    secretLabel: "Client secret",
    defaultScope: "openid email profile",
    needsIssuer: true,
    links: [
      { href: "https://docs.goauthentik.io/add-secure-apps/providers/oauth2/", label: "Authentik: OAuth2/OpenID provider" },
      { href: "https://www.keycloak.org/docs/latest/server_admin/index.html", label: "Keycloak: server administration (OIDC clients)" },
      { href: "https://www.authelia.com/configuration/identity-providers/openid-connect/clients/", label: "Authelia: OpenID Connect clients" },
      { href: "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app", label: "Microsoft Entra ID: register an application" }
    ],
    steps: [
      "In your identity provider, create a confidential web client (OAuth2/OpenID Connect) using the authorization code flow.",
      "Add the callback URL shown below as an allowed redirect URI.",
      "Enter the provider's issuer URL: the address that serves /.well-known/openid-configuration.",
      "Copy the Client ID into the form. Put the client secret on the Cashflow server (see Client secret)."
    ]
  }
};

const PROVIDER_ORDER = ["google", "github", "facebook", "oidc"];

function callbackUrlFor(providerId) {
  const id = String(providerId || "").trim().toLowerCase() || "<provider-id>";
  return `${window.location.origin}/api/auth/providers/${id}/callback`;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the manual hint.
  }
  return false;
}

function Guide({ guide }) {
  return (
    <div className="beta-setup-guide">
      <h4>{t("How to set it up")}</h4>
      <ol>
        {guide.steps.map(step => <li key={step}>{step}</li>)}
      </ol>
      {guide.links?.length ? (
        <ul className="beta-setup-links">
          {guide.links.map(link => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {guide.note ? <p className="beta-hint">{guide.note}</p> : null}
    </div>
  );
}

function CallbackField({ id, value, onChange, guideLabel }) {
  const [copied, setCopied] = useState("");
  async function handleCopy() {
    setCopied(await copyToClipboard(value) ? "Copied" : "Select and copy it manually");
  }
  return (
    <div className="beta-field">
      <label htmlFor={id}>{t("Callback URL")}</label>
      <div className="beta-token-row">
        <input id={id} value={value} required onChange={e => { setCopied(""); onChange(e.target.value); }} />
        <button type="button" className="beta-btn-small" onClick={handleCopy}>{copied === "Copied" ? t("Copied") : t("Copy")}</button>
      </div>
      <small className="beta-hint">{formatMessage("Register exactly this address with {provider}. It must match the address people use to open Cashflow.", { provider: guideLabel })}{copied && copied !== "Copied" ? ` ${copied}.` : ""}
      </small>
    </div>
  );
}

function describeStorage(targets) {
  const kubernetes = targets?.find(target => target.kind === "kubernetes");
  if (kubernetes) return `Cashflow will try to save it in Kubernetes Secret ${kubernetes.secretName} (namespace ${kubernetes.namespace}).`;
  const dotenv = targets?.find(target => target.kind === "dotenv");
  if (dotenv?.writable) return `Cashflow will save it in ${dotenv.path}.`;
  if (dotenv?.present) return `Cashflow can't write to ${dotenv.path}, so you'll get steps to add it yourself.`;
  return "Cashflow has nowhere to save it automatically here, so you'll get steps to add it yourself.";
}

function CopyBlock({ label, text }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="beta-copy-block">
      <div className="beta-copy-block-head">
        <span>{label}</span>
        <button type="button" className="beta-btn-small" onClick={async () => setCopied(await copyToClipboard(text))}>
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function RestartSteps({ restart }) {
  if (!restart || typeof restart !== "object") return null;
  return (
    <div className="beta-restart-steps">
      <h4>{t("2. Restart Cashflow")}</h4>
      <p className="beta-hint">{t("Cashflow reads environment variables only when it starts, so the new secret is used after a restart.")} {restart.summary}
      </p>
      {(restart.commands || []).map(item => <CopyBlock key={item.command} label={item.label} text={item.command} />)}
      {restart.after ? <p className="beta-hint">{restart.after}</p> : null}
    </div>
  );
}

function SecretStoreResult({ result }) {
  if (!result) return null;
  if (result.stored) {
    const where = result.target === "kubernetes" ? "the Kubernetes Secret" : "Cashflow's .env file";
    return (
      <div className="beta-success" role="status">{formatMessage("Secret saved in {location}. It works now on this server; other Cashflow replicas pick it up after a restart.", { location: where })}</div>
    );
  }
  const manual = result.manual || {};
  const forbidden = (result.attempts || []).some(attempt => attempt.reason === "forbidden");
  return (
    <div className="beta-secret-manual" role="status">
      <div className="beta-error">
        <strong>{t("Automatic saving didn’t work.")}</strong>
        <ul className="beta-check-list">
          {(result.attempts || []).map(attempt => <li key={attempt.target}>{attempt.message}</li>)}
        </ul>
      </div>
      <p className="beta-hint">{t("Add it yourself instead:")}</p>
      {manual.kind === "kubernetes" ? (
        <>
          <CopyBlock label="1. Add the secret: run this, replacing the placeholder with the secret" text={manual.command} />
          <RestartSteps restart={manual.restart} />
          <details className="beta-details">
            <summary>{forbidden ? t("Let Cashflow save secrets automatically next time") : t("Permissions for automatic saving")}</summary>
            <p className="beta-hint">{formatParts("Apply this Role and RoleBinding. It lets Cashflow’s service account ({serviceAccount}) update only the {secretName} Secret.", {
              serviceAccount: <code>{manual.serviceAccount}</code>,
              secretName: <code>{manual.secretName}</code>
            })}</p>
            <CopyBlock label={t("RBAC")} text={manual.rbac} />
          </details>
        </>
      ) : (
        <>
          <CopyBlock label={manual.envFile ? `1. Add the secret to ${manual.envFile} or the container's environment` : t("1. Add the secret to Cashflow's environment")} text={manual.line} />
          <RestartSteps restart={manual.restart} />
        </>
      )}
    </div>
  );
}

function ProviderForm({ kind, provider, storageTargets, onSaved, onCancel }) {
  const guide = IDENTITY_PROVIDER_GUIDES[kind] || IDENTITY_PROVIDER_GUIDES.oidc;
  const isExisting = Boolean(provider?.id);
  const config = provider?.config || {};
  const [providerId, setProviderId] = useState(provider?.id || guide.defaultId);
  const [displayName, setDisplayName] = useState(provider?.displayName || (kind === "oidc" ? "" : guide.label));
  const [clientId, setClientId] = useState(provider?.clientId || "");
  const [issuer, setIssuer] = useState(provider?.issuer || "");
  const [redirectUri, setRedirectUri] = useState(config.redirectUri || "");
  const [redirectTouched, setRedirectTouched] = useState(Boolean(config.redirectUri));
  const [secretSource, setSecretSource] = useState(provider?.secretSource || "env");
  const [secretValue, setSecretValue] = useState(provider?.secretLocation || "");
  const [secretTouched, setSecretTouched] = useState(Boolean(provider?.secretLocation));
  const [scope, setScope] = useState(config.scope || guide.defaultScope);
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState(config.authorizationEndpoint || "");
  const [tokenEndpoint, setTokenEndpoint] = useState(config.tokenEndpoint || "");
  const [userInfoEndpoint, setUserInfoEndpoint] = useState(config.userInfoEndpoint || "");
  const [enabled, setEnabled] = useState(isExisting ? Boolean(provider.enabled) : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [secretToStore, setSecretToStore] = useState("");
  const [storeResult, setStoreResult] = useState(null);

  const effectiveRedirect = redirectTouched ? redirectUri : callbackUrlFor(providerId);
  const secretDefault = secretSource === "env"
    ? `CASHFLOW_${(providerId || kind).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`
    : `/run/secrets/cashflow-${(providerId || kind).toLowerCase()}-client-secret`;
  const effectiveSecret = secretTouched ? secretValue : secretDefault;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    setStoreResult(null);
    try {
      const body = {
        kind,
        displayName: displayName.trim(),
        enabled: enabled ? 1 : 0,
        clientId: clientId.trim(),
        redirectUri: effectiveRedirect.trim(),
        scope: scope.trim()
      };
      if (guide.needsIssuer) body.issuer = issuer.trim();
      if (authorizationEndpoint.trim()) body.authorizationEndpoint = authorizationEndpoint.trim();
      if (tokenEndpoint.trim()) body.tokenEndpoint = tokenEndpoint.trim();
      if (userInfoEndpoint.trim()) body.userInfoEndpoint = userInfoEndpoint.trim();
      if (effectiveSecret.trim()) {
        if (secretSource === "env") body.secretEnv = effectiveSecret.trim();
        else body.secretFile = effectiveSecret.trim();
      }
      // Save the secret before the provider so an enabled provider never points at a missing value.
      let stored = null;
      if (secretSource === "env" && secretToStore) {
        stored = await apiFetch("/api/admin/auth/secrets", {
          method: "POST",
          body: { name: effectiveSecret.trim(), value: secretToStore }
        });
        setStoreResult(stored);
        setSecretToStore("");
      }
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(providerId.trim().toLowerCase())}`, { method: "PUT", body });
      setSaved(true);
      // Keep a new provider's form open while it shows manual steps; "Done" closes it.
      if (!isExisting && stored && !stored.stored) return;
      await onSaved();
    } catch (err) {
      setError(err.message || t("Failed to save provider"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-settings-section beta-provider-form" onSubmit={handleSubmit}>
      {!isExisting ? <Guide guide={guide} /> : null}
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">{t("Provider saved.")}</div> : null}

      <div className="beta-form-grid">
        <label className="beta-field">
          <span>{t("Provider ID")}</span>
          <input
            value={providerId}
            readOnly={isExisting}
            required
            maxLength={80}
            pattern={PROVIDER_ID_PATTERN}
            placeholder={kind === "oidc" ? "e.g. authentik" : ""}
            onChange={e => setProviderId(e.target.value.toLowerCase())}
          />
          <small className="beta-hint">{isExisting ? t("Part of the callback URL; fixed once saved.") : t("Lowercase letters, numbers, _ or -. It becomes part of the callback URL.")}</small>
        </label>
        <label className="beta-field">
          <span>{t("Button label")}</span>
          <input value={displayName} required maxLength={120} placeholder={kind === "oidc" ? "e.g. Authentik" : ""} onChange={e => setDisplayName(e.target.value)} />
          <small className="beta-hint">{formatMessage("Shown as “Continue with {label}” on the sign-in page.", { label: displayName || "…" })}</small>
        </label>
        {guide.needsIssuer ? (
          <label className="beta-field">
            <span>{t("Issuer URL")}</span>
            <input type="url" value={issuer} required placeholder="https://auth.example.com/application/o/cashflow/" onChange={e => setIssuer(e.target.value)} />
            <small className="beta-hint">{formatParts("Examples: Keycloak {keycloakUrl}, Entra ID {entraUrl}.", {
              keycloakUrl: <code>{"https://host/realms/<realm>"}</code>,
              entraUrl: <code>{"https://login.microsoftonline.com/<tenant>/v2.0"}</code>
            })}</small>
          </label>
        ) : null}
        <label className="beta-field">
          <span>{guide.clientIdLabel}</span>
          <input value={clientId} required={enabled} autoComplete="off" onChange={e => setClientId(e.target.value)} />
        </label>
      </div>

      <CallbackField
        id={`beta-provider-callback-${provider?.id || "new"}`}
        value={effectiveRedirect}
        guideLabel={guide.label === "Other (OpenID Connect)" ? t("Your provider") : guide.label}
        onChange={value => { setRedirectTouched(true); setRedirectUri(value); }}
      />

      <fieldset className="beta-admin-fieldset beta-fieldset-stack">
        <legend>{guide.secretLabel}</legend>
        <p className="beta-hint">{t("The secret lives on the server, outside Cashflow’s database. Tell Cashflow where to read it, and optionally let Cashflow put it there for you.")} {isExisting ? (provider.secretConfigured ? t("Cashflow can read the secret right now.") : t("Cashflow can't read a secret from this location yet.")) : ""}
        </p>
        <div className="beta-radio-row" role="radiogroup" aria-label={`${guide.secretLabel} source`}>
          <label className="beta-field beta-field-checkbox">
            <input type="radio" name={`secret-source-${providerId || kind}`} checked={secretSource === "env"} onChange={() => { setSecretSource("env"); setSecretTouched(false); }} />
            <span>{t("Environment variable")}</span>
          </label>
          <label className="beta-field beta-field-checkbox">
            <input type="radio" name={`secret-source-${providerId || kind}`} checked={secretSource === "file"} onChange={() => { setSecretSource("file"); setSecretTouched(false); }} />
            <span>{t("File on the server")}</span>
          </label>
        </div>
        <label className="beta-field">
          <span>{secretSource === "env" ? t("Variable name") : t("Absolute file path")}</span>
          <input
            value={effectiveSecret}
            autoComplete="off"
            required={enabled}
            onChange={e => { setSecretTouched(true); setSecretValue(e.target.value); }}
          />
          <small className="beta-hint">
            {secretSource === "env"
              ? t("The environment variable Cashflow reads the secret from.")
              : t("For example a mounted Docker or Kubernetes secret. The file is read on each sign-in, so no restart is needed. Cashflow can't write it for you.")}
          </small>
        </label>
        {secretSource === "env" ? (
          <label className="beta-field">
            <span>{formatMessage("Value for {label} (optional)", { label: guide.secretLabel })}</span>
            <input
              type="password"
              value={secretToStore}
              autoComplete="new-password"
              placeholder={isExisting && provider.secretConfigured ? t("Leave empty to keep the current secret") : t("Paste the secret to have Cashflow save it")}
              onChange={e => setSecretToStore(e.target.value)}
            />
            <small className="beta-hint">{describeStorage(storageTargets)} {t("It is never shown again.")}</small>
          </label>
        ) : null}
        <SecretStoreResult result={storeResult} />
      </fieldset>

      <details className="beta-details">
        <summary>{t("Advanced")}</summary>
        <label className="beta-field">
          <span>{t("Scopes")}</span>
          <input value={scope} onChange={e => setScope(e.target.value)} />
          <small className="beta-hint">{t("Default for")} {guide.label}: <code>{guide.defaultScope}</code></small>
        </label>
        <div className="beta-form-grid">
          <label className="beta-field">
            <span>{t("Authorization endpoint override")}</span>
            <input type="url" value={authorizationEndpoint} placeholder={t("Leave empty to use provider discovery")} onChange={e => setAuthorizationEndpoint(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Token endpoint override")}</span>
            <input type="url" value={tokenEndpoint} placeholder={t("Leave empty to use provider discovery")} onChange={e => setTokenEndpoint(e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("User-info endpoint override")}</span>
            <input type="url" value={userInfoEndpoint} placeholder={t("Leave empty to use provider discovery")} onChange={e => setUserInfoEndpoint(e.target.value)} />
          </label>
        </div>
      </details>

      <label className="beta-field beta-field-checkbox">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>{t("Show on the sign-in page")}</span>
      </label>

      <div className="beta-form-actions beta-form-actions-start">
        {!isExisting && saved && storeResult && !storeResult.stored ? (
          <button type="button" className="beta-btn-primary" onClick={() => onSaved()}>{t("Done")}</button>
        ) : (
          <>
            <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? t("Saving...") : isExisting ? t("Save provider") : t("Add provider")}</button>
            {onCancel ? <button type="button" className="beta-btn-small" disabled={busy} onClick={onCancel}>{t("Cancel")}</button> : null}
          </>
        )}
      </div>
    </form>
  );
}

function ExistingProvider({ provider, storageTargets, onChanged }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const guide = IDENTITY_PROVIDER_GUIDES[provider.kind] || IDENTITY_PROVIDER_GUIDES.oidc;

  async function handleDelete() {
    if (!window.confirm(formatMessage("Delete the {provider} sign-in provider? Linked identities will stop working.", { provider: provider.displayName || provider.id }))) return;
    setError("");
    try {
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(err.message || t("Failed to delete provider"));
    }
  }

  return (
    <article className="beta-admin-account-card">
      <button type="button" className="beta-admin-account-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="beta-admin-account-head-chevron">{open ? "⌄" : "›"}</span>
        <div className="beta-admin-account-head-main">
          <strong>{provider.displayName || provider.id}</strong>
          <span className="beta-budget-meta">{provider.id} &middot; {guide.label}</span>
        </div>
        <div className="beta-admin-account-badges">
          <span className={`beta-pill ${provider.enabled ? "beta-pill-accent" : "beta-pill-muted"}`}>{provider.enabled ? t("On sign-in page") : t("Hidden")}</span>
          <span className={`beta-pill ${provider.secretConfigured ? "beta-pill-muted" : "beta-pill-pending"}`}>{provider.secretConfigured ? t("Secret found") : t("Secret missing")}</span>
        </div>
      </button>
      {open ? (
        <div className="beta-admin-account-body">
          {error ? <div className="beta-error">{error}</div> : null}
          <ProviderForm kind={provider.kind} provider={provider} storageTargets={storageTargets} onSaved={onChanged} />
          <details className="beta-details">
            <summary>{t("Setup guide for")} {guide.label}</summary>
            <Guide guide={guide} />
          </details>
          <div className="beta-form-actions beta-form-actions-start">
            <button type="button" className="beta-btn-small beta-btn-danger" onClick={handleDelete}>{t("Delete provider")}</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function IdentityProvidersPanel({ providers, onChanged, internalLoginActive }) {
  const [step, setStep] = useState("idle");
  const [storageTargets, setStorageTargets] = useState(null);

  useEffect(() => {
    apiFetch("/api/admin/auth/secret-storage", { cache: "no-store", scoped: false })
      .then(result => setStorageTargets(Array.isArray(result?.targets) ? result.targets : []))
      .catch(() => setStorageTargets([]));
  }, []);
  const [kind, setKind] = useState("");

  function start() {
    setKind("");
    setStep("pick");
  }

  async function handleAdded() {
    setStep("idle");
    setKind("");
    await onChanged();
  }

  return (
    <div className="beta-panel beta-settings-section">
      <div className="beta-panel-head">
        <h3>{t("Sign-in providers")}</h3>
        {step === "idle" ? <button type="button" className="beta-btn-small" onClick={start}>{t("Add sign-in provider")}</button> : null}
      </div>
      <p className="beta-hint">{internalLoginActive
        ? t("Adds “Continue with …” buttons to the sign-in page. Each person must link the provider to their own account under Account settings > Linked sign-ins before it can sign them in.")
        : t("Adds “Continue with …” buttons to the sign-in page once Cashflow sign-in is active. Each person must then link the provider to their own account under Account settings > Linked sign-ins before it can sign them in.")}</p>

      {providers.length ? (
        <div className="beta-admin-account-list">
          {providers.map(provider => <ExistingProvider key={provider.id} provider={provider} storageTargets={storageTargets} onChanged={onChanged} />)}
        </div>
      ) : step === "idle" ? <p className="beta-empty">{t("No sign-in providers yet.")}</p> : null}

      {step === "pick" ? (
        <div className="beta-settings-section">
          <h4 className="beta-setup-step">{t("Which provider do you want to add?")}</h4>
          <div className="beta-setup-choices">
            {PROVIDER_ORDER.map(id => {
              const guide = IDENTITY_PROVIDER_GUIDES[id];
              return (
                <button key={id} type="button" className="beta-entry-choice" onClick={() => { setKind(id); setStep("form"); }}>
                  <strong>{guide.label}</strong>
                  <span className="beta-budget-meta">{guide.blurb}</span>
                </button>
              );
            })}
          </div>
          <div className="beta-form-actions beta-form-actions-start">
            <button type="button" className="beta-btn-small" onClick={() => setStep("idle")}>{t("Cancel")}</button>
          </div>
        </div>
      ) : null}

      {step === "form" && kind ? (
        <div className="beta-settings-section">
          <div className="beta-panel-head">
            <h4 className="beta-setup-step">{t("Add")} {IDENTITY_PROVIDER_GUIDES[kind].label}</h4>
            <button type="button" className="beta-btn-small" onClick={() => setStep("pick")}>{t("Choose a different provider")}</button>
          </div>
          <ProviderForm key={kind} kind={kind} provider={null} storageTargets={storageTargets} onSaved={handleAdded} onCancel={() => setStep("idle")} />
        </div>
      ) : null}
    </div>
  );
}

// Reverse proxies that sign people in before requests reach Cashflow (external mode).
export const PROXY_GUIDES = {
  "oauth2-proxy": {
    label: "oauth2-proxy",
    headers: {
      subjectHeader: "x-auth-request-user",
      emailHeader: "x-auth-request-email",
      displayNameHeader: "x-auth-request-preferred-username",
      groupsHeader: "x-auth-request-groups"
    },
    steps: [
      "Run oauth2-proxy with --set-xauthrequest so it returns the X-Auth-Request-* headers to your reverse proxy.",
      "In the reverse proxy, authenticate requests with oauth2-proxy (forward auth / auth_request) and copy those headers to Cashflow.",
      "Strip any X-Auth-Request-* and X-Cashflow-Auth-Secret headers sent by browsers, then add the assertion secret header below.",
      "Make sure the Cashflow port itself isn't reachable except through the proxy."
    ],
    links: [
      { href: "https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview", label: "oauth2-proxy configuration" }
    ]
  },
  authelia: {
    label: "Authelia",
    headers: {
      subjectHeader: "remote-user",
      emailHeader: "remote-email",
      displayNameHeader: "remote-name",
      groupsHeader: "remote-groups"
    },
    steps: [
      "Put Authelia in front of Cashflow as forward auth (Traefik ForwardAuth, Caddy forward_auth, nginx auth_request).",
      "Pass Authelia's Remote-User, Remote-Email, Remote-Name and Remote-Groups response headers on to Cashflow.",
      "Strip those headers and X-Cashflow-Auth-Secret from browser requests, then add the assertion secret header below.",
      "Make sure the Cashflow port itself isn't reachable except through the proxy."
    ],
    links: [
      { href: "https://www.authelia.com/integration/proxies/introduction/", label: "Authelia: proxy integration" },
      { href: "https://www.authelia.com/integration/trusted-header-sso/introduction/", label: "Authelia: trusted header SSO" }
    ]
  },
  authentik: {
    label: "Authentik",
    headers: {
      subjectHeader: "x-authentik-uid",
      emailHeader: "x-authentik-email",
      displayNameHeader: "x-authentik-name",
      groupsHeader: ""
    },
    steps: [
      "Create a Proxy provider in Authentik (forward auth mode) for Cashflow and attach it to an outpost.",
      "Configure the reverse proxy to authenticate through the outpost and pass the X-authentik-* headers on to Cashflow.",
      "Strip those headers and X-Cashflow-Auth-Secret from browser requests, then add the assertion secret header below.",
      "Make sure the Cashflow port itself isn't reachable except through the proxy."
    ],
    note: "Authentik separates groups with |, which Cashflow doesn't split, so the groups header is left empty. Grant admin rights per account instead of through admin groups.",
    links: [
      { href: "https://docs.goauthentik.io/add-secure-apps/providers/proxy/", label: "Authentik: Proxy provider" }
    ]
  },
  custom: {
    label: "Other proxy",
    headers: null,
    steps: [
      "Authenticate people in your reverse proxy before requests reach Cashflow.",
      "Pass a stable user ID header (and optionally email, display name and comma-separated groups) to Cashflow, and enter the header names below.",
      "Strip those headers and X-Cashflow-Auth-Secret from browser requests, then add the assertion secret header below.",
      "Make sure the Cashflow port itself isn't reachable except through the proxy."
    ],
    links: []
  }
};

export function detectProxyPreset(external = {}) {
  const subject = String(external.subjectHeader || "").toLowerCase();
  for (const [id, guide] of Object.entries(PROXY_GUIDES)) {
    if (guide.headers && guide.headers.subjectHeader === subject) return id;
  }
  return subject ? "custom" : "";
}

export function ProxyGuide({ presetId, secretHeader, secretEnv }) {
  const guide = PROXY_GUIDES[presetId];
  if (!guide) return null;
  return (
    <div className="beta-setup-guide">
      <h4>{t("How to set it up")}</h4>
      <ol>
        {guide.steps.map(step => <li key={step}>{step}</li>)}
        <li>{formatParts("On the Cashflow server, set {environmentVariable} to a long random value and have the proxy send that same value in the {headerName} header. Restart Cashflow after setting it.", {
          environmentVariable: <code>{secretEnv || "CASHFLOW_EXTERNAL_AUTH_SECRET"}</code>,
          headerName: <code>{secretHeader || "x-cashflow-auth-secret"}</code>
        })}</li>
        <li>{t("Link each person’s proxy user ID to their Cashflow account (Account management > External subject), then test and activate.")}</li>
      </ol>
      {guide.links.length ? (
        <ul className="beta-setup-links">
          {guide.links.map(link => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {guide.note ? <p className="beta-hint">{guide.note}</p> : null}
    </div>
  );
}
