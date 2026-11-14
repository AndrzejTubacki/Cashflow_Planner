export function normalizePriority(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
