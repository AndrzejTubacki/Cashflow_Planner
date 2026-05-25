import { escapeHtml } from "../utils.js";
import { asNumber, formatMoney, formatPercent, t } from "./shared.js";

const EMPTY_VALUE = "-";

function fundingParts(item) {
  const target = asNumber(item.target_ledger_amount ?? item.amount, 0);
  const confirmed = asNumber(item.already_funded_ledger ?? item.already_funded, 0);
  const pending = asNumber(item.pending_allocated_ledger ?? item.pending_allocated, 0);
  const future = asNumber(item.future_allocated_ledger ?? item.future_allocated, 0);
  const planned = confirmed + pending + future;
  const remaining = Math.max(0, asNumber(item.remaining_ledger ?? item.remaining, Math.max(0, target - planned)));

  return {
    target,
    confirmed,
    pending,
    future,
    planned,
    remaining
  };
}

function fundingDateClass(parts) {
  if (parts.remaining > 0.0001) return "cashflow-funding-card__date--missing";
  if (parts.future > 0.0001) return "cashflow-funding-card__date--future";
  if (parts.pending > 0.0001) return "cashflow-funding-card__date--pending";
  return "";
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = (angleDeg - 90) * Math.PI / 180;

  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad)
  };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M", start.x, start.y,
    "A", r, r, 0, largeArcFlag, 0, end.x, end.y
  ].join(" ");
}

function renderDonutSegment({ cx, cy, r, strokeWidth, startAngle, endAngle, className }) {
  if (endAngle <= startAngle) return "";

  // Full circles cannot be represented cleanly as one SVG arc.
  if (endAngle - startAngle >= 359.999) {
    return `
      <circle
        cx="${cx}"
        cy="${cy}"
        r="${r}"
        fill="none"
        stroke-width="${strokeWidth}"
        class="${escapeHtml(className)}"
      ></circle>
    `;
  }

  return `
    <path
      d="${describeArc(cx, cy, r, startAngle, endAngle)}"
      fill="none"
      stroke-width="${strokeWidth}"
      stroke-linecap="butt"
      class="${escapeHtml(className)}"
    ></path>
  `;
}

function renderFundingPie(locale, item, label) {
  const parts = fundingParts(item);
  const total = Math.max(parts.target, parts.confirmed + parts.pending + parts.future + parts.remaining, 0.0001);

  const segments = [
    {
      key: "confirmed",
      label: t(locale, "Confirmed"),
      value: Math.max(0, parts.confirmed),
      className: "cashflow-donut__segment cashflow-donut__segment--confirmed"
    },
    {
      key: "pending",
      label: t(locale, "Pending"),
      value: Math.max(0, parts.pending),
      className: "cashflow-donut__segment cashflow-donut__segment--pending"
    },
    {
      key: "future",
      label: t(locale, "Future"),
      value: Math.max(0, parts.future),
      className: "cashflow-donut__segment cashflow-donut__segment--future"
    },
    {
      key: "missing",
      label: t(locale, "Missing"),
      value: Math.max(0, parts.remaining),
      className: "cashflow-donut__segment cashflow-donut__segment--missing"
    }
  ].filter(segment => segment.value > 0.0001);

  let angle = 0;
  const renderedSegments = segments.map(segment => {
    const span = (segment.value / total) * 360;
    const startAngle = angle;
    const endAngle = angle + span;
    angle = endAngle;

    return renderDonutSegment({
      cx: 50,
      cy: 50,
      r: 36,
      strokeWidth: 18,
      startAngle,
      endAngle,
      className: segment.className
    });
  }).join("");

  const fundedPct = Math.min(100, ((parts.confirmed + parts.pending + parts.future) / total) * 100);
  const fundedByDate = item.funded_by_date || null;
  const dateClass = fundingDateClass(parts);

  return `
    <div class="cashflow-funding-card">
      <div class="cashflow-donut-wrap">
        <svg class="cashflow-donut" viewBox="0 0 100 100" role="img" aria-label="${escapeHtml(label)}">
          <circle
            cx="50"
            cy="50"
            r="36"
            fill="none"
            stroke-width="18"
            class="cashflow-donut__track"
          ></circle>
          ${renderedSegments}
        </svg>

        <div class="cashflow-donut__center">
          <strong>${escapeHtml(formatPercent(fundedPct, locale))}</strong>
        </div>
      </div>

      <div class="cashflow-funding-card__body">
        <div class="cashflow-funding-card__header">
          <strong title="${escapeHtml(label)}">${escapeHtml(label)}</strong>
          <span class="${escapeHtml(dateClass)}">${escapeHtml(fundedByDate || t(locale, "No date"))}</span>
        </div>

        <div class="cashflow-funding-legend">
          <span class="cashflow-funding-metric">
            <i class="cashflow-legend-dot cashflow-legend-dot--confirmed"></i>
            <span>${escapeHtml(t(locale, "Confirmed"))}</span>
            <strong>${formatMoney(parts.confirmed, "PLN", locale)}</strong>
          </span>
          <span class="cashflow-funding-metric">
            <i class="cashflow-legend-dot cashflow-legend-dot--pending"></i>
            <span>${escapeHtml(t(locale, "Pending"))}</span>
            <strong>${formatMoney(parts.pending, "PLN", locale)}</strong>
          </span>
          <span class="cashflow-funding-metric">
            <i class="cashflow-legend-dot cashflow-legend-dot--future"></i>
            <span>${escapeHtml(t(locale, "Future"))}</span>
            <strong>${formatMoney(parts.future, "PLN", locale)}</strong>
          </span>
          <span class="cashflow-funding-metric">
            <i class="cashflow-legend-dot cashflow-legend-dot--missing"></i>
            <span>${escapeHtml(t(locale, "Missing"))}</span>
            <strong>${formatMoney(parts.remaining, "PLN", locale)}</strong>
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderFundingOverview(locale, cashflow) {
  const goals = cashflow?.goals || [];
  const flex = cashflow?.flexTransactions || [];

  const goalCards = goals.map(goal =>
    renderFundingPie(locale, goal, `${t(locale, "Goal")}: ${goal.name || EMPTY_VALUE}`)
  );

  const flexCards = flex.map(item =>
    renderFundingPie(locale, item, `${t(locale, "Flex")}: ${item.name || EMPTY_VALUE}`)
  );

  if (!goalCards.length && !flexCards.length) return "";

  return `
    <div class="cashflow-funding-overview">
      ${goalCards.join("")}
      ${flexCards.join("")}
    </div>
  `;
}

export { renderFundingOverview };
