import { escapeHtml } from "../utils.js";
import {
  AUTH_MODES,
  AUTH_PROVIDER_KINDS,
  AUTH_PROVISIONING_MODES,
  DEFAULT_LEDGER_CURRENCY,
  DEFAULT_TIMEZONE,
  FX_PROVIDER_OPTIONS,
  HOLIDAY_COUNTRIES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";
import { t } from "./shared.js";

function renderCurrencyOptions(selected) {
  return SUPPORTED_FX_CURRENCIES.map(currency => `
    <option value="${escapeHtml(currency)}"${currency === selected ? " selected" : ""}>
      ${escapeHtml(currency)}
    </option>
  `).join("");
}

function isSystemAdmin(account) {
  return Array.isArray(account?.globalRoles) && account.globalRoles.includes("system_admin");
}

function renderStatus(locale, status) {
  return t(locale, status || "active");
}

function renderAccountSessions(locale, account) {
  const sessions = Array.isArray(account?.sessions) ? account.sessions : [];
  if (!sessions.length) {
    return `<small>${escapeHtml(t(locale, "No active sessions"))}</small>`;
  }

  return `
    <div class="cashflow-list">
      ${sessions.map(session => `
        <div class="cashflow-budget-row">
          <div class="cashflow-budget-row__main">
            <strong>${escapeHtml(session.auth_method || "none")}</strong>
            <span>${escapeHtml(session.id)} · ${escapeHtml(session.last_seen_at || session.created_at || "")}</span>
          </div>
          <div class="cashflow-budget-row__actions">
            <button
              type="button"
              class="btn-small"
              data-cashflow-admin-session-revoke="${escapeHtml(account.id)}"
              data-session-id="${escapeHtml(session.id)}"
            >
              ${escapeHtml(t(locale, "Revoke session"))}
            </button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAdminAccounts(locale, accounts = []) {
  return `
    <section class="panel" data-cashflow-admin-accounts>
      <h3>${escapeHtml(t(locale, "Admin accounts"))}</h3>
      <p class="detail-note">${escapeHtml(t(locale, "Admin accounts manage who can sign in, who can administer Cashflow, and which active sessions can be revoked. Budget access is still controlled by budget membership."))}</p>
      ${(accounts || []).length ? `
        <div class="cashflow-admin-account-list">
          ${accounts.map(account => {
            const accountId = account.id || "";
            const status = account.status || "active";
            const admin = isSystemAdmin(account);
            const deleted = status === "deleted";
            const externalIdentity = (account.identities || []).find(identity => String(identity.provider_id || "").startsWith("external_")) || null;
            return `
              <article class="cashflow-admin-account-card" data-cashflow-admin-account-row="${escapeHtml(accountId)}">
                <header class="cashflow-admin-account-card__header">
                  <div>
                    <strong>${escapeHtml(account.display_name || accountId)}</strong>
                    <span>${escapeHtml(accountId)}</span>
                  </div>
                  <div class="cashflow-admin-account-card__badges">
                    <span>${escapeHtml(renderStatus(locale, status))}</span>
                    <span>${admin ? escapeHtml(t(locale, "System admin")) : escapeHtml(t(locale, "Budget member"))}</span>
                  </div>
                </header>

                <div class="cashflow-admin-account-grid">
                  <label>
                    <span>${escapeHtml(t(locale, "Display name"))}</span>
                    <input
                      value="${escapeHtml(account.display_name || accountId)}"
                      data-cashflow-admin-account-name="${escapeHtml(accountId)}"
                      aria-label="${escapeHtml(`${t(locale, "Display name")}: ${account.display_name || accountId}`)}"
                      ${deleted ? "disabled" : ""}
                    >
                  </label>
                  <label>
                    <span>${escapeHtml(t(locale, "Email"))}</span>
                    <input
                      value="${escapeHtml(account.email || "")}"
                      data-cashflow-admin-account-email="${escapeHtml(accountId)}"
                      aria-label="${escapeHtml(`${t(locale, "Email")}: ${account.email || accountId}`)}"
                      ${deleted ? "disabled" : ""}
                    >
                  </label>
                  <label>
                    <span>${escapeHtml(t(locale, "External subject"))}</span>
                    <input
                      value="${escapeHtml(externalIdentity?.subject || "")}"
                      data-cashflow-admin-external-subject="${escapeHtml(accountId)}"
                      aria-label="${escapeHtml(`${t(locale, "External subject")}: ${externalIdentity?.subject || accountId}`)}"
                      ${deleted ? "disabled" : ""}
                    >
                    <small>${escapeHtml(externalIdentity?.provider_id || t(locale, "No external identity"))}</small>
                  </label>
                  <div class="cashflow-admin-account-stat">
                    <span>${escapeHtml(t(locale, "Internal password"))}</span>
                    <strong>${account.hasPasswordCredential ? escapeHtml(t(locale, "Configured")) : escapeHtml(t(locale, "Not configured"))}</strong>
                    <small data-cashflow-admin-password-token-output="${escapeHtml(accountId)}"></small>
                  </div>
                  <div class="cashflow-admin-account-stat">
                    <span>${escapeHtml(t(locale, "Budgets"))}</span>
                    <strong>${escapeHtml(String(account.ownedBudgetCount ?? 0))} / ${escapeHtml(String(account.membershipCount ?? 0))}</strong>
                    <small>${escapeHtml(t(locale, "Owned / memberships"))}</small>
                  </div>
                  <div class="cashflow-admin-account-stat cashflow-admin-account-stat--sessions">
                    <span>${escapeHtml(t(locale, "Active sessions"))}</span>
                    ${renderAccountSessions(locale, account)}
                  </div>
                </div>

                <div class="cashflow-row-actions cashflow-row-actions--wrap">
                  ${!deleted ? `<button type="button" class="btn-small" data-cashflow-admin-account-rename="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Save account"))}</button>` : ""}
                  ${!deleted && !account.hasPasswordCredential ? `<button type="button" class="btn-small" data-cashflow-admin-password-token="${escapeHtml(accountId)}" data-purpose="password_setup">${escapeHtml(t(locale, "Create password setup token"))}</button>` : ""}
                  ${!deleted && account.hasPasswordCredential ? `<button type="button" class="btn-small" data-cashflow-admin-password-token="${escapeHtml(accountId)}" data-purpose="password_reset">${escapeHtml(t(locale, "Create password reset token"))}</button>` : ""}
                  ${!deleted ? `<button type="button" class="btn-small" data-cashflow-admin-external-link="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Link external identity"))}</button>` : ""}
                  ${!deleted && status === "active" ? `<button type="button" class="btn-small" data-cashflow-admin-account-status="${escapeHtml(accountId)}" data-next-status="disabled">${escapeHtml(t(locale, "Disable account"))}</button>` : ""}
                  ${!deleted && status === "disabled" ? `<button type="button" class="btn-small" data-cashflow-admin-account-status="${escapeHtml(accountId)}" data-next-status="active">${escapeHtml(t(locale, "Enable account"))}</button>` : ""}
                  ${!deleted && admin ? `<button type="button" class="btn-small" data-cashflow-admin-account-admin="${escapeHtml(accountId)}" data-enabled="0">${escapeHtml(t(locale, "Revoke admin"))}</button>` : ""}
                  ${!deleted && !admin ? `<button type="button" class="btn-small" data-cashflow-admin-account-admin="${escapeHtml(accountId)}" data-enabled="1">${escapeHtml(t(locale, "Grant admin"))}</button>` : ""}
                  ${!deleted ? `<button type="button" class="btn-small" data-cashflow-admin-account-delete="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Delete account"))}</button>` : ""}
                </div>
              </article>
            `;
          }).join("")}
        </div>
      ` : `<p>${escapeHtml(t(locale, "No accounts yet"))}</p>`}
    </section>
  `;
}

function renderAuthModeOptions(locale, selected = "none") {
  return AUTH_MODES.map(mode => `
    <option value="${escapeHtml(mode)}"${mode === selected ? " selected" : ""}>
      ${escapeHtml(t(locale, `auth_mode_${mode}`))}
    </option>
  `).join("");
}

function renderProvisioningOptions(locale, selected = "deny_unknown") {
  return AUTH_PROVISIONING_MODES.map(mode => `
    <option value="${escapeHtml(mode)}"${mode === selected ? " selected" : ""}>
      ${escapeHtml(t(locale, `auth_provisioning_${mode}`))}
    </option>
  `).join("");
}

function renderProviderKindOptions(selected = "oidc") {
  return AUTH_PROVIDER_KINDS.map(kind => `
    <option value="${escapeHtml(kind)}"${kind === selected ? " selected" : ""}>
      ${escapeHtml(kind)}
    </option>
  `).join("");
}

function renderAuthProviderForm(locale, provider = null) {
  const isExisting = Boolean(provider?.id);
  const config = provider?.config || {};
  const providerId = provider?.id || "";
  return `
    <form class="cashflow-settings-grid cashflow-auth-provider-form" data-cashflow-admin-provider-form>
      <fieldset>
        <legend>${escapeHtml(provider?.displayName || t(locale, "New provider"))}</legend>
        <label>
          <span>${escapeHtml(t(locale, "Provider ID"))}</span>
          <input name="providerId" value="${escapeHtml(providerId)}" required maxlength="80" ${isExisting ? "readonly" : ""}>
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Provider type"))}</span>
          <select name="kind">
            ${renderProviderKindOptions(provider?.kind || "oidc")}
          </select>
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Display name"))}</span>
          <input name="displayName" value="${escapeHtml(provider?.displayName || "")}" required maxlength="120">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Enabled"))}</span>
          <input type="checkbox" name="enabled"${provider?.enabled ? " checked" : ""}>
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Issuer"))}</span>
          <input name="issuer" value="${escapeHtml(provider?.issuer || "")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Client ID"))}</span>
          <input name="clientId" value="${escapeHtml(provider?.clientId || "")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Client secret env"))}</span>
          <input name="secretEnv" placeholder="${escapeHtml(provider?.secretConfigured ? t(locale, "Configured") : "CASHFLOW_OIDC_CLIENT_SECRET")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Redirect URI"))}</span>
          <input name="redirectUri" value="${escapeHtml(config.redirectUri || "")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Scope"))}</span>
          <input name="scope" value="${escapeHtml(config.scope || "openid email profile")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Authorization endpoint"))}</span>
          <input name="authorizationEndpoint" value="${escapeHtml(config.authorizationEndpoint || "")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Token endpoint"))}</span>
          <input name="tokenEndpoint" value="${escapeHtml(config.tokenEndpoint || "")}">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Userinfo endpoint"))}</span>
          <input name="userInfoEndpoint" value="${escapeHtml(config.userInfoEndpoint || "")}">
        </label>
      </fieldset>
      <div class="settings-actions">
        <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Save provider"))}</button>
        ${isExisting ? `<button type="button" class="btn-secondary" data-cashflow-admin-provider-delete="${escapeHtml(providerId)}">${escapeHtml(t(locale, "Delete provider"))}</button>` : ""}
      </div>
    </form>
  `;
}

function renderAdminAuthProviders(locale, providers = []) {
  return `
    <section class="panel" data-cashflow-admin-auth-providers>
      <h3>${escapeHtml(t(locale, "Identity providers"))}</h3>
      ${(providers || []).length ? providers.map(provider => `
        <div class="cashflow-budget-row">
          <div class="cashflow-budget-row__main">
            <strong>${escapeHtml(provider.displayName || provider.id)}</strong>
            <span>${escapeHtml(provider.id)} · ${escapeHtml(provider.kind)} · ${escapeHtml(provider.enabled ? t(locale, "Enabled") : t(locale, "Disabled"))} · ${escapeHtml(provider.secretConfigured ? t(locale, "Secret configured") : t(locale, "Secret missing"))}</span>
          </div>
        </div>
        ${renderAuthProviderForm(locale, provider)}
      `).join("") : `<p>${escapeHtml(t(locale, "No identity providers configured"))}</p>`}
      ${renderAuthProviderForm(locale)}
    </section>
  `;
}

function renderAdminAuthConfig(locale, authConfig = null) {
  const config = authConfig || {};
  const draft = config.draftConfig || {};
  const external = draft.external || {};
  const internal = draft.internal || {};
  const draftMode = String(config.draftMode || "none");
  const activeMode = String(config.activeMode || "none");

  return `
    <section class="panel" data-cashflow-admin-auth>
      <h3>${escapeHtml(t(locale, "Authentication"))}</h3>
      <form class="cashflow-settings-grid" data-cashflow-admin-auth-form>
        <fieldset>
          <legend>${escapeHtml(t(locale, "Authentication modes"))}</legend>
          <div class="cashflow-readonly-field">
            <span>${escapeHtml(t(locale, "Active authentication mode"))}</span>
            <strong>${escapeHtml(t(locale, `auth_mode_${activeMode}`))}</strong>
            <small>${escapeHtml(t(locale, "The active mode is changed only by activating a tested draft."))}</small>
          </div>
          <label>
            <span>${escapeHtml(t(locale, "Draft authentication mode"))}</span>
            <select name="draftMode">
              ${renderAuthModeOptions(locale, draftMode)}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Session idle timeout (minutes)"))}</span>
            <input name="sessionIdleMinutes" type="number" min="5" max="10080" value="${escapeHtml(String(config.sessionIdleMinutes || 720))}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Session absolute timeout (minutes)"))}</span>
            <input name="sessionAbsoluteMinutes" type="number" min="5" max="43200" value="${escapeHtml(String(config.sessionAbsoluteMinutes || 10080))}">
          </label>
        </fieldset>

        <fieldset>
          <legend>${escapeHtml(t(locale, "External SSO draft"))}</legend>
          <label>
            <span>${escapeHtml(t(locale, "Subject header"))}</span>
            <input name="external.subjectHeader" value="${escapeHtml(external.subjectHeader || "x-auth-request-user")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Assertion secret header"))}</span>
            <input name="external.assertionSecretHeader" value="${escapeHtml(external.assertionSecretHeader || "x-cashflow-auth-secret")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Assertion secret environment variable"))}</span>
            <input name="external.assertionSecretEnv" value="${escapeHtml(external.assertionSecretEnv || "CASHFLOW_EXTERNAL_AUTH_SECRET")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Email header"))}</span>
            <input name="external.emailHeader" value="${escapeHtml(external.emailHeader || "")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Display name header"))}</span>
            <input name="external.displayNameHeader" value="${escapeHtml(external.displayNameHeader || "")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Groups header"))}</span>
            <input name="external.groupsHeader" value="${escapeHtml(external.groupsHeader || "")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Trusted issuer"))}</span>
            <input name="external.trustedIssuer" value="${escapeHtml(external.trustedIssuer || "")}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Provisioning mode"))}</span>
            <select name="external.provisioningMode">
              ${renderProvisioningOptions(locale, external.provisioningMode || "deny_unknown")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Allowed domains"))}</span>
            <input name="external.allowedDomains" value="${escapeHtml((external.allowedDomains || []).join(", "))}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Admin groups"))}</span>
            <input name="external.adminGroups" value="${escapeHtml((external.adminGroups || []).join(", "))}">
          </label>
        </fieldset>

        <fieldset>
          <legend>${escapeHtml(t(locale, "Internal login draft"))}</legend>
          <label>
            <span>${escapeHtml(t(locale, "Password login"))}</span>
            <input type="checkbox" name="internal.allowPasswordLogin"${internal.allowPasswordLogin === false ? "" : " checked"}>
          </label>
        </fieldset>

        <div class="settings-actions">
          <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Save auth draft"))}</button>
          <button type="button" class="btn-secondary" data-cashflow-admin-auth-test>${escapeHtml(t(locale, "Test auth draft"))}</button>
          <button type="button" class="btn-secondary" data-cashflow-admin-auth-activate>${escapeHtml(t(locale, "Activate auth draft"))}</button>
        </div>
        <small>${escapeHtml(t(locale, "Internal activation requires a system administrator with an email/password credential or linked enabled provider. External activation requires an assertion secret and linked administrator identity."))}</small>
      </form>
    </section>
  `;
}

export function renderAdminTab(locale, cashflow = null) {
  const options = cashflow?.admin?.options || {};
  const accounts = Array.isArray(cashflow?.admin?.accounts) ? cashflow.admin.accounts : [];
  const authConfig = cashflow?.admin?.authConfig || null;
  const providers = Array.isArray(cashflow?.admin?.providers) ? cashflow.admin.providers : [];
  const availableLocales = Array.isArray(cashflow?.availableLocales) && cashflow.availableLocales.length
    ? cashflow.availableLocales
    : [{ id: "en", label: "English" }];
  const selectedCurrency = String(options.ledger_currency || DEFAULT_LEDGER_CURRENCY).toUpperCase();
  const selectedLocale = String(options.locale || "en");
  const selectedProvider = String(options.fx_provider || "nbp");
  const selectedHolidayCountry = String(options.holiday_country || "PL").toUpperCase();

  return `
    <div class="cashflow-tab-content">
      ${renderAdminAccounts(locale, accounts)}
      ${renderAdminAuthConfig(locale, authConfig)}
      ${renderAdminAuthProviders(locale, providers)}
      <form class="cashflow-settings-grid" data-cashflow-admin-options-form>
        <fieldset>
          <legend>${escapeHtml(t(locale, "Global options"))}</legend>
          <label>
            <span>${escapeHtml(t(locale, "Default ledger currency"))}</span>
            <select name="ledger_currency">
              ${renderCurrencyOptions(selectedCurrency)}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default language"))}</span>
            <select name="locale">
              ${availableLocales.map(option => `
                <option value="${escapeHtml(option.id)}"${option.id === selectedLocale ? " selected" : ""}>
                  ${escapeHtml(option.label || option.id)}
                </option>
              `).join("")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default timezone"))}</span>
            <input name="timezone" value="${escapeHtml(options.timezone || DEFAULT_TIMEZONE)}" list="cashflow-admin-timezones">
            <datalist id="cashflow-admin-timezones">
              ${TIMEZONE_OPTIONS.map(timezone => `<option value="${escapeHtml(timezone)}"></option>`).join("")}
            </datalist>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default holiday country"))}</span>
            <select name="holiday_country">
              ${HOLIDAY_COUNTRIES.map(country => `
                <option value="${escapeHtml(country.code)}"${country.code === selectedHolidayCountry ? " selected" : ""}>
                  ${escapeHtml(country.code)} - ${escapeHtml(t(locale, country.labelKey))}
                </option>
              `).join("")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default projection horizon"))}</span>
            <input type="number" name="future_periods" value="${escapeHtml(String(options.future_periods || 11))}" min="1" max="60">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default FX provider"))}</span>
            <select name="fx_provider">
              ${FX_PROVIDER_OPTIONS.map(provider => `
                <option value="${escapeHtml(provider.id)}"${provider.id === selectedProvider ? " selected" : ""}>
                  ${escapeHtml(t(locale, provider.labelKey))}
                </option>
              `).join("")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default FX buffer (%)"))}</span>
            <input type="number" name="fx_buffer_percent" value="${escapeHtml(String(options.fx_buffer_percent ?? 0))}" min="0" max="100" step="0.5">
          </label>
        </fieldset>

        <div class="settings-actions">
          <button type="submit" class="btn-primary">
            ${escapeHtml(t(locale, "Save global options"))}
          </button>
        </div>
      </form>
    </div>
  `;
}
