export function normalizeDecimalInput(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

export function lowestUnusedPriority(items = []) {
  const used = new Set(items.map(item => Number(item?.priority)).filter(Number.isInteger));
  let priority = 1;
  while (used.has(priority)) priority += 1;
  return priority;
}

export function observedFxCurrencies(snapshot = {}, ledgerCurrency = "PLN") {
  const ledger = String(ledgerCurrency).toUpperCase();
  const rows = [
    ...(snapshot.recurringExpenses || []), ...(snapshot.recurringIncomes || []),
    ...(snapshot.oneOffs || []), ...(snapshot.goals || []), ...(snapshot.flexTransactions || []),
    ...(snapshot.confirmedTransactions || []), ...(snapshot.pendingTransactions || []),
    ...(snapshot.futureTransactions || [])
  ];
  return [...new Set(rows.map(row => String(row?.currency || "").toUpperCase()).filter(currency => currency && currency !== ledger))].sort();
}

export function manualRateForCurrency(rates = {}, currency, ledgerCurrency) {
  return rates[`${currency}/${ledgerCurrency}`] ?? rates[`${currency.toLowerCase()}/${ledgerCurrency.toLowerCase()}`]
    ?? rates[currency] ?? rates[currency.toLowerCase()] ?? "";
}

export function selectedManualRates(rates = {}, currencies = [], ledgerCurrency = "PLN") {
  return Object.fromEntries(currencies.flatMap(currency => {
    const value = Number(String(manualRateForCurrency(rates, currency, ledgerCurrency)).replace(",", "."));
    return Number.isFinite(value) && value > 0 ? [[currency, value]] : [];
  }));
}

export function sortFundingEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const aDate = a.item?.funded_by_date || "";
    const bDate = b.item?.funded_by_date || "";
    if (Boolean(aDate) !== Boolean(bDate)) return aDate ? 1 : -1;
    return aDate.localeCompare(bDate) || String(a.name || "").localeCompare(String(b.name || ""))
      || String(a.item?.id || "").localeCompare(String(b.item?.id || ""));
  });
}

export function parseProjectionFxRates(snapshot = {}, ledgerCurrency = "PLN") {
  let rates = snapshot?.latestProjectionSnapshot?.fx_rates_used || {};
  try { rates = typeof rates === "string" ? JSON.parse(rates) : rates; } catch { rates = {}; }
  return Object.entries(rates || {}).flatMap(([key, raw]) => {
    const rate = Number(raw?.rate ?? raw);
    if (!Number.isFinite(rate) || rate <= 0) return [];
    const pair = key.includes("/") ? key.toUpperCase() : `${key.toUpperCase()}/${String(ledgerCurrency).toUpperCase()}`;
    return [{ pair, rate }];
  }).sort((a, b) => a.pair.localeCompare(b.pair));
}
