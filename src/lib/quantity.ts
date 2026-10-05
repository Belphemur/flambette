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

  // Attached ASCII fraction first: "3/4 cup" is three quarters, not
  // three of something per four. A space-separated one ("2 1/2 cups")
  // falls through to the integer + attached-fraction path below.
  const attachedAscii = s.match(/^(\d+)\s*\/\s*(\d+)/)
  if (attachedAscii) {
    amount = Number(attachedAscii[1]) / Number(attachedAscii[2])
    s = s.slice(attachedAscii[0].length)
    matched = true
  } else {
    // Integer/decimal part
    const numMatch = s.match(/^\d+(?:[.,]\d+)?/)
    if (numMatch) {
      amount = Number(numMatch[0].replace(',', '.'))
      s = s.slice(numMatch[0].length)
      matched = true
    }
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

/** Glyph for `num/den`, for the denominators FRACTION_DENOMINATORS covers. */
const FRACTION_GLYPHS: ReadonlyMap<string, string> = new Map([
  ['1/2', '½'],
  ['1/3', '⅓'],
  ['2/3', '⅔'],
  ['1/4', '¼'],
  ['3/4', '¾'],
  ['1/6', '⅙'],
  ['5/6', '⅚'],
  ['1/8', '⅛'],
  ['3/8', '⅜'],
  ['5/8', '⅝'],
  ['7/8', '⅞'],
])

/** Denominators tried when rendering a fractional amount (ADR-0017). */
const FRACTION_DENOMINATORS = [2, 3, 4, 6, 8] as const

/** Tolerance when snapping a remainder onto an eighth/third/etc. */
const FRACTION_TOLERANCE = 0.02

/**
 * Format a count as a mixed fraction: `1`, `3/2`, `2 ¼`, `⅞`.
 * Grocery container sums keep their exact fraction (`½ (142 g) pkg` twice
 * is a whole package, but a 3-recipe sum may be `1 ½ small bunch`), so this
 * complements `formatAmount`, which flattens everything to 1 decimal.
 *
 * ADR-0057: rendered with the catalog's own UNICODE fraction glyphs — the
 * upstream profiles author `1 ⅓ cups`, `½ (142 g) pkg`, `4 ½ oz`, and the
 * ASCII `a/b` spelling appeared nowhere in any profile.
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
      const glyph = FRACTION_GLYPHS.get(`${num}/${d}`)
      const fracText = glyph ?? `${num}/${d}`
      return `${sign}${whole > 0 ? `${whole} ` : ''}${fracText}`
    }
  }
  return formatAmount(amount)
}

/* ---------- ADR-0057: the upstream profile scaling model ---------- */

/** International avoirdupois ounce, grams (mirrors units.ts). */
const OZ_GRAMS = 28.3495
/** US fluid ounce, millilitres (mirrors units.ts). */
const FL_OZ_ML = 29.5735
/** The cup the upstream profiles quantize volumes to: the US cup proper
 * (236.5882 ml), NOT the 240 ml legal cup — 354 ml is 3 ml off 1 ½ cups
 * and must stay on the fl-oz grid, while 1420 ml sits exactly on 6 cups. */
const CUP_ML = 236.5882

function isMultiple(v: number, step: number): boolean {
  const q = v / step
  return Math.abs(q - Math.round(q)) < 1e-6
}

/** Quantize to a fraction grid: `qzTo(0.984, 0.25)` → `1`. */
function qzTo(v: number, step: number): number {
  return Math.round(v / step) * step
}

/** Same naive singularization containers.ts/grocery.ts use. */
function collapseUnitKey(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.length > 3 && u.endsWith('es')) return u.slice(0, -2)
  if (u.length > 2 && u.endsWith('s')) return u.slice(0, -1)
  return u
}

/**
 * Scale an authored metric amount the way the upstream profiles do
 * (ADR-0057, measured from metric-6 → metric-4/metric-2 pairs):
 *
 * - **g** — the source amount sits on the ½-oz grid (the catalog authors
 *   ounce-derived grams), so re-quantize the source, scale, round to
 *   integer grams (94–99% exact match upstream).
 * - **ml** — a hybrid: ½-tbsp-multiple values divide exactly (the
 *   `67.5 → 22.5` family), values within 0.5 ml of a ¼-cup quantum
 *   quantize through the cup grid, everything else round-trips the fl-oz
 *   grid (97–99% exact).
 * - **kg** — exact gram products stay exact (≤3 dp), everything else
 *   rounds to 2 decimals (97.8% exact).
 * - **tbsp / counts** — exact products stay (halves included), inexact
 *   round to the nearest integer.
 * - **cup** — returned unquantized (the string layer decides whether the
 *   result renders as cups or swaps to ml).
 */
export function scaleMetricAmount(amount: number, factor: number, unit: string): number {
  const key = collapseUnitKey(unit)
  const p = amount * factor
  switch (key) {
    case 'g': {
      // An exact product stays exact (84 g ×⅔ = 56 g, 426 ×⅔ = 284) —
      // the oz round-trip below would bump 56.0 to 57.
      if (Math.abs(p - Math.round(p)) < 1e-6) return Math.round(p)
      return Math.round(qzTo(amount / OZ_GRAMS, 0.5) * factor * OZ_GRAMS)
    }
    case 'ml':
      return scaleMl(amount, factor)
    case 'kg': {
      const grams = p * 1000
      if (Math.abs(grams - Math.round(grams)) < 1e-6) return Math.round(grams) / 1000
      // Upstream preserves the source's precision class: a 2-decimal kg
      // (0.68 kg) scales to 2 decimals, a 3-decimal one (0.341 kg, the
      // ounce-derived stragglers) floors to 3 (0.341 ×⅓ → 0.113 kg).
      const sourceDp = (String(amount).split('.')[1] ?? '').length
      if (sourceDp >= 3) return Math.floor(grams) / 1000
      return Math.round(p * 100) / 100
    }
    case 'cup':
      return p
    case 'tbsp': {
      const q = qzTo(p, 0.25)
      if (Math.abs(q - p) < 0.02) return q
      return Math.round(p)
    }
    default: {
      if (Math.abs(p - Math.round(p)) < 1e-6) return Math.round(p)
      if (Math.abs(p * 2 - Math.round(p * 2)) < 1e-6) return p
      return Math.round(p)
    }
  }
}

/** The ml hybrid: tbsp-clean exact → cup grid (within 0.5 ml) → fl-oz. */
function scaleMl(v: number, f: number): number {
  if (v <= 120 && isMultiple(v, 7.5) && isMultiple(v * f, 2.5)) {
    return Math.round(v * f * 10) / 10
  }
  const cups = v / CUP_ML
  if (Math.abs(cups - qzTo(cups, 0.25)) * CUP_ML <= 0.5) {
    return Math.round(qzTo(qzTo(cups, 0.25) * f, 0.25) * CUP_ML)
  }
  return Math.round((v / FL_OZ_ML) * f * FL_OZ_ML)
}

/**
 * Render a scaled metric amount with the profile's own vocabulary:
 * integer g/ml (½ quanta as glyphs), kg at 2–3 decimals, everything else
 * as fraction glyphs. Falls back to `formatAmount`'s 1-decimal grammar
 * for values that are neither integer nor on a fraction grid.
 */
export function formatMetricAmount(value: number, unit: string): string {
  const key = collapseUnitKey(unit)
  if (key === 'g' || key === 'ml') {
    if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value))
    if (Math.abs(value * 2 - Math.round(value * 2)) < 1e-6) return formatFraction(value)
    return formatAmount(value)
  }
  if (key === 'kg') {
    const grams = value * 1000
    if (Math.abs(grams - Math.round(grams)) < 1e-6) return String(Number((Math.round(grams) / 1000).toFixed(3)))
    return String(Math.round(value * 100) / 100)
  }
  return formatFraction(value)
}

/** True when `frac` sits on a ⅛/⅓/¼ grid within `formatFraction`'s tolerance. */
function isCommonFraction(frac: number): boolean {
  for (const d of [2, 3, 4, 8]) {
    if (Math.abs(Math.round(frac * d) / d - frac) < 0.02) return true
  }
  return false
}

/**
 * Scale a `cup`-unit quantity (ADR-0057, measured over 880 upstream cup
 * pairs): the scaled value STAYS cups — exact common fractions render as
 * glyphs (`1 cup ×⅔ → ⅔ cup`, `2 cups ×⅔ → 1 ⅓ cups`), everything else
 * quantizes to the ⅛ grid (`⅓ cup ×⅔ → ¼ cup`, `¼ cup ×⅔ → ⅛ cup`).
 * Upstream's occasional cup→ml swap (~60/880 pairs) is re-authoring noise
 * and is not mirrored.
 */
function scaleCupQuantity(amount: number, factor: number, unit: string): string {
  const p = amount * factor
  const base = unit.replace(/s$/i, '')
  if (Math.abs(p - Math.round(p)) < 1e-6) {
    const n = Math.round(p)
    return `${n} ${n === 1 ? base : `${base}s`}`
  }
  const frac = p - Math.floor(p)
  const value = isCommonFraction(frac) ? p : qzTo(p, 0.125)
  // Fractional results below a whole cup render singular ('⅔ cup',
  // '¾ cup' — 792 archive pairs), like every other count noun.
  const noun = value <= 1 ? base : `${base}s`
  return `${formatFraction(value)} ${noun}`
}

/**
 * Container nouns whose COUNT the profiles quantize to the nearest ½
 * (ADR-0057, measured): `1 (142 g) pkg ×⅔ → ½ (142 g) pkg`,
 * `1 ½ pkgs ×⅔ → 1 pkg`. Same noun family as ADR-0017's grocery rule,
 * but this is the per-recipe DISPLAY path — no ceil here.
 */
const CONTAINER_COUNT_NOUNS: ReadonlySet<string> = new Set([
  'pkg',
  'package',
  'bunch',
  'head',
  'can',
  'block',
  'bag',
  'jar',
  'log',
  'loaf',
  'bottle',
  'box',
  'tin',
  'carton',
  'ear',
  'stick',
  'crown',
  'heart',
  'cap',
])

/** `2 cloves` ×⅔ renders `1 clove` — the profiles singularize at 1. */
const SINGULAR_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['cloves', 'clove'],
  ['loaves', 'loaf'],
  ['leaves', 'leaf'],
  ['halves', 'half'],
])

function singularizeUnit(unit: string): string {
  const tokens = unit.split(/\s+/)
  const last = tokens[tokens.length - 1]
  const lower = last?.toLowerCase() ?? ''
  if (last && last.length > 3) {
    const exception = SINGULAR_EXCEPTIONS.get(lower)
    if (exception) tokens[tokens.length - 1] = exception
    else if (/(?:ch|sh|x|z)es$/i.test(last)) tokens[tokens.length - 1] = last.slice(0, -2)
    else if (/ies$/i.test(last)) tokens[tokens.length - 1] = `${last.slice(0, -3)}y`
    else if (/s$/i.test(last)) tokens[tokens.length - 1] = last.slice(0, -1)
  }
  return tokens.join(' ')
}

/**
 * Scale a display quantity by a factor. Non-parseable quantities pass
 * through verbatim. The scaling is the ADR-0057 profile model
 * (`scaleMetricAmount`), with the profile's own unit-class grammar on top:
 * cups quantize on the ⅛ grid, container counts on the ½ grid, counts
 * round, and everything singularizes at 1. `2129 ml` at ⅔ is `1420 ml`,
 * not `1419.3 ml`.
 */
export function scaleQuantity(raw: string, factor: number): string {
  const parsed = parseQuantity(raw)
  if (!parsed || factor === 1) return raw
  const unit = parsed.unit
  const nounKey = collapseUnitKey(unit.split(/\s+/).pop() ?? '')
  if (collapseUnitKey(unit) === 'cup' || nounKey === 'cup') {
    return scaleCupQuantity(parsed.amount, factor, unit)
  }
  if (CONTAINER_COUNT_NOUNS.has(nounKey)) {
    const count = qzTo(parsed.amount * factor, 0.5)
    const rendered = formatFraction(count)
    const noun = count <= 1 ? singularizeUnit(unit) : unit
    return unit ? `${rendered} ${noun}` : rendered
  }
  const value = scaleMetricAmount(parsed.amount, factor, unit)
  const rendered = formatMetricAmount(value, unit)
  const singular = value === 1 ? singularizeUnit(unit) : unit
  return unit ? `${rendered} ${singular}` : rendered
}

/** Total "popularity" score (sum over weekdays) for sorting. */
export function popularityScore(popularity: Record<string, number>): number {
  return Object.values(popularity).reduce((a, b) => a + b, 0)
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
