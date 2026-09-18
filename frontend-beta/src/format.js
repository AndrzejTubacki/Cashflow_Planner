export function formatMoney(amount, currency = "PLN") {
  const num = Number(amount) || 0;
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${formatted} ${currency}`;
}
