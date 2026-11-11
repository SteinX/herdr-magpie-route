const UNITS = ["", "K", "M", "B", "T"];

// Decimal units: token counts and call counts share the same compact notation.
export function compactNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1000; unit++; }
  if (unit === 0) return String(value);
  let digits = value.toFixed(2);
  if (Number(digits) >= 1000 && unit < UNITS.length - 1) {
    unit++;
    digits = (value / 1000).toFixed(2);
  }
  return digits.replace(/\.?0+$/, "") + UNITS[unit];
}

// Keep cents for normal amounts and sub-cent precision for small estimates.
export function compactCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value >= 999.995) return compactNumber(Math.max(1000, value));
  return value.toFixed(value === 0 || Number(value.toFixed(4)) >= 0.01 ? 2 : 4);
}
