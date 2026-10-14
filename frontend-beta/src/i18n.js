import english from "../../public/app/cashflow/locales/en.js";
import polish from "../../public/app/cashflow/locales/pl.js";
import { cloneElement, isValidElement } from "react";

const dictionaries = new Map([[english.id, english], [polish.id, polish]]);

function supportedLocale(value) {
  const id = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return dictionaries.has(id) ? id : "en";
}

let activeLocale = supportedLocale(typeof navigator === "undefined" ? "en" : navigator.language);

export function setLocale(value) {
  activeLocale = supportedLocale(value);
  if (typeof document !== "undefined") document.documentElement.lang = activeLocale;
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function availableLocales() {
  return [...dictionaries.values()].map(({ id, label }) => ({ id, label }));
}

export function t(key, fallback = "") {
  const normalizedKey = String(fallback || key || "");
  return dictionaries.get(activeLocale)?.strings?.[normalizedKey]
    || english.strings?.[normalizedKey]
    || normalizedKey;
}

export function formatMessage(key, params = {}, fallback = "") {
  return t(key, fallback || key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function formatParts(key, params = {}, fallback = "") {
  const message = t(key, fallback || key);
  const parts = message.split(/(\{[a-zA-Z0-9_]+\})/g);
  return parts.filter(Boolean).map((part, index) => {
    const match = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    if (!match) return part;
    const value = params[match[1]];
    if (value === undefined || value === null) return "";
    return isValidElement(value) ? cloneElement(value, { key: `${match[1]}-${index}` }) : String(value);
  });
}

export function intlLocale() {
  return activeLocale === "pl" ? "pl-PL" : "en-US";
}

setLocale(activeLocale);
