import { escapeHtml } from "../utils.js";
import { t } from "./shared.js";

const ROLE_OPTIONS = ["manager", "editor", "viewer"];

function roleOptions(locale, selected = "viewer", { includeOwner = false } = {}) {
  const roles = includeOwner ? ["owner", ...ROLE_OPTIONS] : ROLE_OPTIONS;
  return roles.map(role => `
    <option value="${escapeHtml(role)}"${role === selected ? " selected" : ""}>
      ${escapeHtml(t(locale, role))}
    </option>
  `).join("");
}

function statusLabel(locale, status) {
  return t(locale, status || "active");
}

function canManage(role) {
  return role === "owner" || role === "manager";
}

function canOwn(role) {
  return role === "owner";
}

function renderBudgetRow(locale, budget, currentBudgetId) {
  const role = budget.role || "";
  const isCurrent = budget.id === currentBudgetId;
  const isActive = budget.status === "active";

  return `
    <div class="cashflow-budget-row" data-cashflow-budget-row="${escapeHtml(budget.id)}">
      <div class="cashflow-budget-row__main">
        <strong>${escapeHtml(budget.display_name || budget.id)}</strong>
        <span>${escapeHtml(budget.id)} · ${escapeHtml(t(locale, role || "viewer"))} · ${escapeHtml(statusLabel(locale, budget.status))}</span>
      </div>
      <div class="cashflow-budget-row__edit">
        <input
          value="${escapeHtml(budget.display_name || budget.id)}"
          data-cashflow-budget-name="${escapeHtml(budget.id)}"
          aria-label="${escapeHtml(t(locale, "Budget name"))}"
          ${canManage(role) ? "" : "disabled"}
        >
        ${canManage(role) ? `<button type="button" class="btn-small" data-cashflow-budget-rename="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Rename"))}</button>` : ""}
      </div>
      <div class="cashflow-budget-row__actions">
        ${isActive && !isCurrent ? `<button type="button" class="btn-small" data-cashflow-budget-select="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Switch"))}</button>` : ""}
        ${isCurrent ? `<span class="cashflow-chip">${escapeHtml(t(locale, "Current budget"))}</span>` : ""}
        <button type="button" class="btn-small" data-cashflow-budget-export="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Export"))}</button>
        ${canOwn(role) && isActive ? `<button type="button" class="btn-small" data-cashflow-budget-archive="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Archive"))}</button>` : ""}
        ${canOwn(role) && budget.status === "archived" ? `<button type="button" class="btn-small" data-cashflow-budget-restore="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Restore"))}</button>` : ""}
        ${canOwn(role) && budget.status === "archived" ? `<button type="button" class="btn-small" data-cashflow-budget-purge="${escapeHtml(budget.id)}">${escapeHtml(t(locale, "Purge"))}</button>` : ""}
      </div>
    </div>
  `;
}

function renderMembers(locale, members, currentAccountId, currentRole) {
  if (!canManage(currentRole)) return "";

  return `
    <section class="panel">
      <h3>${escapeHtml(t(locale, "Members"))}</h3>
      <div class="cashflow-table-wrap">
        <table class="cashflow-table cashflow-table--compact">
          <thead>
            <tr>
              <th>${escapeHtml(t(locale, "Account"))}</th>
              <th>${escapeHtml(t(locale, "Role"))}</th>
              <th>${escapeHtml(t(locale, "Status"))}</th>
              <th>${escapeHtml(t(locale, "Actions"))}</th>
            </tr>
          </thead>
          <tbody>
            ${(members || []).map(member => {
              const accountId = member.account_id || member.accountId || member.id;
              const role = member.role || "viewer";
              const isSelf = accountId === currentAccountId;
              const isOwner = role === "owner";
              const managerCanEdit = currentRole === "owner" || (!isOwner && role !== "owner");
              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(member.display_name || accountId)}</strong>
                    <small>${escapeHtml(accountId)}</small>
                  </td>
                  <td>
                    ${isOwner ? escapeHtml(t(locale, "owner")) : `
                      <select
                        data-cashflow-member-role="${escapeHtml(accountId)}"
                        aria-label="${escapeHtml(`${t(locale, "Role")}: ${member.display_name || accountId}`)}"
                        ${managerCanEdit ? "" : "disabled"}
                      >
                        ${roleOptions(locale, role)}
                      </select>
                    `}
                  </td>
                  <td>${escapeHtml(statusLabel(locale, member.status))}</td>
                  <td>
                    ${!isOwner && managerCanEdit ? `<button type="button" class="btn-small" data-cashflow-member-update="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Update"))}</button>` : ""}
                    ${!isOwner && managerCanEdit ? `<button type="button" class="btn-small" data-cashflow-member-remove="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Remove"))}</button>` : ""}
                    ${currentRole === "owner" && !isSelf && !isOwner ? `<button type="button" class="btn-small" data-cashflow-member-transfer="${escapeHtml(accountId)}">${escapeHtml(t(locale, "Transfer ownership"))}</button>` : ""}
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderInvitations(locale, invitations, accounts, lastInvitation, currentRole) {
  if (!canManage(currentRole)) return "";

  return `
    <section class="panel">
      <h3>${escapeHtml(t(locale, "Invitations"))}</h3>
      ${lastInvitation?.token ? `
        <div class="detail-note" data-cashflow-invitation-token>
          <strong>${escapeHtml(t(locale, "Invitation token"))}</strong>
          <input readonly value="${escapeHtml(lastInvitation.token)}" aria-label="${escapeHtml(t(locale, "Invitation token"))}">
        </div>
      ` : ""}
      <form class="cashflow-form-grid" data-cashflow-budget-invite-form>
        <label>
          <span>${escapeHtml(t(locale, "Account"))}</span>
          <select name="accountId">
            <option value="">${escapeHtml(t(locale, "Invite by email"))}</option>
            ${(accounts || []).map(account => `
              <option value="${escapeHtml(account.id)}">${escapeHtml(account.display_name || account.id)} (${escapeHtml(account.id)})</option>
            `).join("")}
          </select>
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Email"))}</span>
          <input name="email" type="email">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Role"))}</span>
          <select name="role">
            ${roleOptions(locale, "viewer")}
          </select>
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Expires in hours"))}</span>
          <input name="expiresInHours" type="number" min="1" max="720" value="168">
        </label>
        <div class="settings-actions">
          <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Create invitation"))}</button>
        </div>
      </form>
      <div class="cashflow-list">
        ${(invitations || []).length ? invitations.map(invitation => `
          <div class="cashflow-budget-row">
            <div class="cashflow-budget-row__main">
              <strong>${escapeHtml(invitation.target_account_id || invitation.target_email || t(locale, "Invitation"))}</strong>
              <span>${escapeHtml(t(locale, invitation.role || "viewer"))} · ${escapeHtml(statusLabel(locale, invitation.status))} · ${escapeHtml(invitation.expires_at || "")}</span>
            </div>
            <div class="cashflow-budget-row__actions">
              ${invitation.status === "pending" ? `<button type="button" class="btn-small" data-cashflow-invitation-revoke="${escapeHtml(invitation.id)}">${escapeHtml(t(locale, "Revoke"))}</button>` : ""}
            </div>
          </div>
        `).join("") : `<p>${escapeHtml(t(locale, "No invitations"))}</p>`}
      </div>
    </section>
  `;
}

export function renderBudgetManagerTab(locale, cashflow = null, budgetManager = {}) {
  const session = cashflow?.session || {};
  const currentBudgetId = session.budgetId || session.userId || "";
  const currentAccountId = session.accountId || "";
  const currentBudget = (budgetManager.budgets || []).find(budget => budget.id === currentBudgetId) || {
    id: currentBudgetId,
    display_name: session.budgetDisplayName || session.displayName || currentBudgetId,
    role: session.budgetRole || "",
    status: "active"
  };
  const currentRole = currentBudget.role || session.budgetRole || "";

  return `
    <div class="cashflow-tab-content" data-cashflow-budget-manager data-current-budget-id="${escapeHtml(currentBudgetId)}">
      <section class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Budgets"))}</h3>
          <form class="cashflow-inline-form" data-cashflow-create-budget-form>
            <input
              name="displayName"
              required
              maxlength="120"
              placeholder="${escapeHtml(t(locale, "New budget name"))}"
              aria-label="${escapeHtml(t(locale, "New budget name"))}"
            >
            <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Create budget"))}</button>
          </form>
        </div>
        <div class="cashflow-list">
          ${(budgetManager.budgets || []).length
            ? budgetManager.budgets.map(budget => renderBudgetRow(locale, budget, currentBudgetId)).join("")
            : `<p>${escapeHtml(t(locale, "No budgets yet"))}</p>`}
        </div>
      </section>

      <section class="panel">
        <h3>${escapeHtml(t(locale, "Current budget"))}</h3>
        <div class="cashflow-budget-row">
          <div class="cashflow-budget-row__main">
            <strong>${escapeHtml(currentBudget.display_name || currentBudget.id || t(locale, "Budget"))}</strong>
            <span>${escapeHtml(currentBudget.id || currentBudgetId)} · ${escapeHtml(t(locale, currentRole || "viewer"))}</span>
          </div>
          <div class="cashflow-budget-row__actions">
            ${currentRole !== "owner" ? `<button type="button" class="btn-small" data-cashflow-budget-leave="${escapeHtml(currentBudgetId)}">${escapeHtml(t(locale, "Leave budget"))}</button>` : ""}
          </div>
        </div>
      </section>

      ${renderMembers(locale, budgetManager.members || [], currentAccountId, currentRole)}
      ${renderInvitations(locale, budgetManager.invitations || [], budgetManager.accounts || [], budgetManager.lastInvitation || null, currentRole)}
    </div>
  `;
}
