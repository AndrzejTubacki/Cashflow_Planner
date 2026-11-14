/** Protocol-defined UTF-16 code-unit order; never depends on host ICU/locale. */
export function compareEngineText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}