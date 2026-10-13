import { useState } from "react";
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
      <h4>How to set it up</h4>
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
      <label htmlFor={id}>Callback URL</label>
      <div className="beta-token-row">
        <input id={id} value={value} required onChange={e => { setCopied(""); onChange(e.target.value); }} />
        <button type="button" className="beta-btn-small" onClick={handleCopy}>{copied === "Copied" ? "Copied" : "Copy"}</button>
      </div>
      <small className="beta-hint">
        Register exactly this address with {guideLabel}. It must match the address people use to open Cashflow.
        {copied && copied !== "Copied" ? ` ${copied}.` : ""}
      </small>
    </div>
  );
}

function ProviderForm({ kind, provider, onSaved, onCancel }) {
  const guide = IDENTITY_PROVIDER_GUIDES[kind] || IDENTITY_PROVIDER_GUIDES.oidc;
  const isExisting = Boolean(provider?.id);
  const config = provider?.config || {};
  const [providerId, setProviderId] = useState(provider?.id || guide.defaultId);
  const [displayName, setDisplayName] = useState(provider?.displayName || (kind === "oidc" ? "" : guide.label));
  const [clientId, setClientId] = useState(provider?.clientId || "");
  const [issuer, setIssuer] = useState(provider?.issuer || "");
  const [redirectUri, setRedirectUri] = useState(config.redirectUri || "");
  const [redirectTouched, setRedirectTouched] = useState(Boolean(config.redirectUri));
  const [secretSource, setSecretSource] = useState("env");
  const [secretValue, setSecretValue] = useState("");
  const [scope, setScope] = useState(config.scope || guide.defaultScope);
  const [enabled, setEnabled] = useState(isExisting ? Boolean(provider.enabled) : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const effectiveRedirect = redirectTouched ? redirectUri : callbackUrlFor(providerId);
  const secretPlaceholder = secretSource === "env"
    ? `CASHFLOW_${(providerId || kind).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`
    : "/run/secrets/cashflow-oidc-client-secret";

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
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
      if (secretValue.trim()) {
        if (secretSource === "env") body.secretEnv = secretValue.trim();
        else body.secretFile = secretValue.trim();
      }
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(providerId.trim().toLowerCase())}`, { method: "PUT", body });
      setSaved(true);
      setSecretValue("");
      await onSaved();
    } catch (err) {
      setError(err.message || "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="beta-settings-section beta-provider-form" onSubmit={handleSubmit}>
      {!isExisting ? <Guide guide={guide} /> : null}
      {error ? <div className="beta-error">{error}</div> : null}
      {saved ? <div className="beta-success" role="status">Provider saved.</div> : null}

      <div className="beta-form-grid">
        <label className="beta-field">
          <span>Provider ID</span>
          <input
            value={providerId}
            readOnly={isExisting}
            required
            maxLength={80}
            pattern={PROVIDER_ID_PATTERN}
            placeholder={kind === "oidc" ? "e.g. authentik" : ""}
            onChange={e => setProviderId(e.target.value.toLowerCase())}
          />
          <small className="beta-hint">{isExisting ? "Part of the callback URL; fixed once saved." : "Lowercase letters, numbers, _ or -. It becomes part of the callback URL."}</small>
        </label>
        <label className="beta-field">
          <span>Button label</span>
          <input value={displayName} required maxLength={120} placeholder={kind === "oidc" ? "e.g. Authentik" : ""} onChange={e => setDisplayName(e.target.value)} />
          <small className="beta-hint">Shown as &ldquo;Continue with {displayName || "…"}&rdquo; on the sign-in page.</small>
        </label>
        {guide.needsIssuer ? (
          <label className="beta-field">
            <span>Issuer URL</span>
            <input type="url" value={issuer} required placeholder="https://auth.example.com/application/o/cashflow/" onChange={e => setIssuer(e.target.value)} />
            <small className="beta-hint">
              Examples: Keycloak <code>https://host/realms/&lt;realm&gt;</code>, Entra ID <code>https://login.microsoftonline.com/&lt;tenant&gt;/v2.0</code>.
            </small>
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
        guideLabel={guide.label === "Other (OpenID Connect)" ? "your provider" : guide.label}
        onChange={value => { setRedirectTouched(true); setRedirectUri(value); }}
      />

      <fieldset className="beta-admin-fieldset beta-fieldset-stack">
        <legend>{guide.secretLabel}</legend>
        <p className="beta-hint">
          Cashflow never stores the secret itself. Put it on the server and tell Cashflow where to find it.
          {isExisting ? (provider.secretConfigured ? " A secret is configured now; leave this empty to keep it." : " No secret is readable right now.") : ""}
        </p>
        <div className="beta-radio-row" role="radiogroup" aria-label={`${guide.secretLabel} source`}>
          <label className="beta-field beta-field-checkbox">
            <input type="radio" name={`secret-source-${providerId || kind}`} checked={secretSource === "env"} onChange={() => setSecretSource("env")} />
            <span>Environment variable</span>
          </label>
          <label className="beta-field beta-field-checkbox">
            <input type="radio" name={`secret-source-${providerId || kind}`} checked={secretSource === "file"} onChange={() => setSecretSource("file")} />
            <span>File on the server</span>
          </label>
        </div>
        <label className="beta-field">
          <span>{secretSource === "env" ? "Variable name" : "Absolute file path"}</span>
          <input value={secretValue} placeholder={secretPlaceholder} autoComplete="off" required={!isExisting && enabled} onChange={e => setSecretValue(e.target.value)} />
          <small className="beta-hint">
            {secretSource === "env"
              ? "Set this variable in Cashflow's environment (for example .env or the container settings) and restart Cashflow so it's picked up."
              : "For example a mounted Docker or Kubernetes secret. The file is read on each sign-in, so no restart is needed."}
          </small>
        </label>
      </fieldset>

      <details className="beta-details">
        <summary>Advanced</summary>
        <label className="beta-field">
          <span>Scopes</span>
          <input value={scope} onChange={e => setScope(e.target.value)} />
          <small className="beta-hint">Default for {guide.label}: <code>{guide.defaultScope}</code></small>
        </label>
      </details>

      <label className="beta-field beta-field-checkbox">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>Show on the sign-in page</span>
      </label>

      <div className="beta-form-actions beta-form-actions-start">
        <button type="submit" className="beta-btn-primary" disabled={busy}>{busy ? "Saving..." : isExisting ? "Save provider" : "Add provider"}</button>
        {onCancel ? <button type="button" className="beta-btn-small" disabled={busy} onClick={onCancel}>Cancel</button> : null}
      </div>
    </form>
  );
}

function ExistingProvider({ provider, onChanged }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const guide = IDENTITY_PROVIDER_GUIDES[provider.kind] || IDENTITY_PROVIDER_GUIDES.oidc;

  async function handleDelete() {
    if (!window.confirm(`Delete the ${provider.displayName || provider.id} sign-in provider? Linked identities stop working.`)) return;
    setError("");
    try {
      await apiFetch(`/api/admin/auth/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to delete provider");
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
          <span className={`beta-pill ${provider.enabled ? "beta-pill-accent" : "beta-pill-muted"}`}>{provider.enabled ? "On sign-in page" : "Hidden"}</span>
          <span className={`beta-pill ${provider.secretConfigured ? "beta-pill-muted" : "beta-pill-pending"}`}>{provider.secretConfigured ? "Secret found" : "Secret missing"}</span>
        </div>
      </button>
      {open ? (
        <div className="beta-admin-account-body">
          {error ? <div className="beta-error">{error}</div> : null}
          <ProviderForm kind={provider.kind} provider={provider} onSaved={onChanged} />
          <details className="beta-details">
            <summary>Setup guide for {guide.label}</summary>
            <Guide guide={guide} />
          </details>
          <div className="beta-form-actions beta-form-actions-start">
            <button type="button" className="beta-btn-small beta-btn-danger" onClick={handleDelete}>Delete provider</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function IdentityProvidersPanel({ providers, onChanged, internalLoginActive }) {
  const [step, setStep] = useState("idle");
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
        <h3>Sign-in providers</h3>
        {step === "idle" ? <button type="button" className="beta-btn-small" onClick={start}>Add sign-in provider</button> : null}
      </div>
      <p className="beta-hint">
        Adds &ldquo;Continue with &hellip;&rdquo; buttons to the sign-in page. They appear only while internal login is the
        active sign-in mode{internalLoginActive ? "" : " (it isn't yet)"}, and each person links the provider to their own
        account under Account settings &gt; Linked sign-ins before it can sign them in.
      </p>

      {providers.length ? (
        <div className="beta-admin-account-list">
          {providers.map(provider => <ExistingProvider key={provider.id} provider={provider} onChanged={onChanged} />)}
        </div>
      ) : step === "idle" ? <p className="beta-empty">No sign-in providers yet.</p> : null}

      {step === "pick" ? (
        <div className="beta-settings-section">
          <h4 className="beta-setup-step">Which provider do you want to add?</h4>
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
            <button type="button" className="beta-btn-small" onClick={() => setStep("idle")}>Cancel</button>
          </div>
        </div>
      ) : null}

      {step === "form" && kind ? (
        <div className="beta-settings-section">
          <div className="beta-panel-head">
            <h4 className="beta-setup-step">Add {IDENTITY_PROVIDER_GUIDES[kind].label}</h4>
            <button type="button" className="beta-btn-small" onClick={() => setStep("pick")}>Choose a different provider</button>
          </div>
          <ProviderForm key={kind} kind={kind} provider={null} onSaved={handleAdded} onCancel={() => setStep("idle")} />
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
      <h4>How to set it up</h4>
      <ol>
        {guide.steps.map(step => <li key={step}>{step}</li>)}
        <li>
          On the Cashflow server, set <code>{secretEnv || "CASHFLOW_EXTERNAL_AUTH_SECRET"}</code> to a long random value
          and have the proxy send that same value in the <code>{secretHeader || "x-cashflow-auth-secret"}</code> header.
          Restart Cashflow after setting it.
        </li>
        <li>Link each person&rsquo;s proxy user ID to their Cashflow account (Account management &gt; External subject), then test and activate.</li>
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
