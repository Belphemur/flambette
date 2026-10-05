/**
 * Quantity parsing/formatting for recipe line items and instruction text.
 * See grocery aggregation spec (v1): parse what parses, keep the rest verbatim.
 */

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
}

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('')
const FRACTION_RE = new RegExp(`^[${FRACTION_CHARS}]+`)
const ASCII_FRACTION_RE = /^(\d+)\/(\d+)/

export interface ParsedQuantity {
  amount: number
  /** Rest of the string after the leading amount ('' for bare numbers). */
  unit: string
}

/**
 * Parse a display quantity into (amount, unit).
 * Handles "710 ml", "2 cups", "15 g", "2 ½ cm", "½ tsp", "3/4 cup", "6", "".
 * Returns null when the string has no parseable leading amount.
 */
export function parseQuantity(raw: string): ParsedQuantity | null {
  let s = raw.trim()
  if (!s) return null

  let amount = 0
  let matched = false

  // Integer/decimal part
  const numMatch = s.match(/^\d+(?:[.,]\d+)?/)
  if (numMatch) {
    amount = Number(numMatch[0].replace(',', '.'))
    s = s.slice(numMatch[0].length)
    matched = true
  }

  // Optional attached fraction: "2 ½ cm" or "1/2 cup"
  s = s.trimStart()
  const ascii = s.match(ASCII_FRACTION_RE)
  if (ascii) {
    amount += Number(ascii[1]) / Number(ascii[2])
    s = s.slice(ascii[0].length)
    matched = true
  } else {
    const uni = s.match(FRACTION_RE)
    if (uni) {
      for (const ch of uni[0]) amount += UNICODE_FRACTIONS[ch] ?? 0
      s = s.slice(uni[0].length)
      matched = true
    }
  }

  if (!matched) return null
  return { amount, unit: s.trim() }
}

/** Round to 1 decimal, strip trailing .0. */
export function formatAmount(amount: number): string {
  const rounded = Math.round(amount * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * The string-typed twin of {@link humanizeAmount} for already-composed
 * quantity strings ("2.25 large eggs").
 */
export function humanizeScaledQuantity(raw: string): string {
  const parsed = parseQuantity(raw)
  if (!parsed) return raw
  const rounded = humanizeAmount(parsed.amount, parsed.unit)
  return parsed.unit ? `${rounded} ${parsed.unit}` : rounded
}

/** Denominators tried when rendering a fractional amount (ADR-0017). */
const FRACTION_DENOMINATORS = [2, 3, 4, 6, 8] as const

/** Tolerance when snapping a remainder onto an eighth/third/etc. */
const FRACTION_TOLERANCE = 0.02

/**
 * Format a count as a mixed fraction: `1`, `3/2`, `2 1/4`, `7/8`.
 * Grocery container sums keep their exact fraction (`½ (142 g) pkg` twice
 * is a whole package, but a 3-recipe sum may be `3/2 small bunch`), so this
 * complements `formatAmount`, which flattens everything to 1 decimal.
 */
export function formatFraction(amount: number): string {
  if (!Number.isFinite(amount)) return formatAmount(amount)
  const negative = amount < 0
  const abs = Math.abs(amount)
  const whole = Math.floor(abs + 1e-9)
  const frac = abs - whole
  if (frac < FRACTION_TOLERANCE) return formatAmount(negative ? -whole : whole)
  for (const d of FRACTION_DENOMINATORS) {
    const num = Math.round(frac * d)
    if (num <= 0 || num >= d) continue
    if (Math.abs(num / d - frac) < FRACTION_TOLERANCE) {
      const sign = negative ? '-' : ''
      return `${sign}${whole > 0 ? `${whole} ` : ''}${num}/${d}`
    }
  }
  return formatAmount(amount)
}

/** Total "popularity" score (sum over weekdays) for sorting. */
export function popularityScore(popularity: Record<string, number>): number {
  return Object.values(popularity).reduce((a, b) => a + b, 0)
}

/**
 * The NUMBER-side twin of {@link humanizeScaledQuantity}: round an already
 * scaled amount + unit pair for display. Count-like units round half-down
 * to whole pieces (2.25 eggs -> "2"); everything else keeps formatAmount.
 * Used by the step-detail scaler (recipe.ts), which owns a parsed amount
 * already and shouldn't stringify-then-reparse through the string form.
 */
export function humanizeAmount(amount: number, unit: string): string {
  const u = unit.trim().toLowerCase()
  const isCountLike =
    !u || /^(large |medium |small )?(egg|eggs|clove|cloves|sprig|sprigs|leaf|leaves|slice|slices)\b/.test(u)
  if (isCountLike) {
    const down = amount % 1 === 0.5 ? amount - 0.5 : amount
    return String(Math.round(down))
  }
  // Mass/volume: from ~5 units up the fraction is noise a kitchen scale can't
  // resolve, so round half-down to the integer (26.25 g -> 26 g, 2.3 g keeps
  // its decimal because a small baking-powder amount can genuinely matter).
  // Spoon units keep the decimal (¾ tsp is real).
  const isSpoon = /\b(tsp|tbsp|tablespoon|teaspoon|cup|cups)\b/.test(u)
  if (!isSpoon && Math.abs(amount) >= 5 && amount % 1 !== 0) {
    const down = amount % 1 === 0.5 ? amount - 0.5 : amount
    return String(Math.round(down))
  }
  return formatAmount(amount)
}
