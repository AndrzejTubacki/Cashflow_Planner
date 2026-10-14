import { intlLocale } from "./i18n.js";

export function formatMoney(amount, currency = "PLN") {
  const num = Number(amount) || 0;
  const formatted = num.toLocaleString(intlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${formatted} ${currency}`;
}

export function formatDate(value, options = { dateStyle: "medium" }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(intlLocale(), options);
}

export function formatDateTime(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(intlLocale(), options);
}

export function todayIso() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split("T")[0];
}
