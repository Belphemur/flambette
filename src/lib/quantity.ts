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
 * Scale a display quantity by a factor. Non-parseable quantities pass
 * through verbatim.
 */
export function scaleQuantity(raw: string, factor: number): string {
  const parsed = parseQuantity(raw)
  if (!parsed || factor === 1) return raw
  const scaled = formatAmount(parsed.amount * factor)
  return parsed.unit ? `${scaled} ${parsed.unit}` : scaled
}

/** Total "popularity" score (sum over weekdays) for sorting. */
export function popularityScore(popularity: Record<string, number>): number {
  return Object.values(popularity).reduce((a, b) => a + b, 0)
}
