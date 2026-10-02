/**
 * Unit system (metric/imperial) — ADR-0047.
 *
 * The frozen catalog is authored metric (`units: "Metric"` on all 2,759
 * docs), so METRIC IS THE CANONICAL FORM: the docs, the pack index and every
 * persisted store (plan entries, grocery `checked` keys, cleared keys) keep
 * metric numbers forever. Everything in this module is a DISPLAY-TIME
 * transform, the same way container units are formatted but never
 * re-authored (ADR-0017): flip the setting and the text changes; the
 * storage never does.
 *
 * Two transforms, deliberately separate:
 *
 * - `localizeQuantity` — a formatted amount + unit (`450 g`, `1.5 (142 g)
 *   pkg`, `½ (142 g) pkg`). Metric is the IDENTITY: the catalog's metric
 *   quantity is today's display, so an install that never touches the
 *   control cannot churn a single existing pin.
 * - `localizeText` — authored PROSE (instruction steps): temperatures and
 *   lengths. Metric is NOT the identity here: the catalog writes dual
 *   notation inconsistently (`220°C (425°F)` AND `450°F (232°C)`), so
 *   neither system reads clean until one of them is dropped.
 *
 * Pure lib: no Vue/Pinia imports, unit-tested like the rest of `src/lib`.
 */

import { formatAmount, parseQuantity } from './quantity'

export type UnitSystem = 'metric' | 'imperial'

/** The two accepted systems, in menu order. */
export const UNIT_SYSTEMS: readonly UnitSystem[] = ['metric', 'imperial']

/**
 * The default an install that never touches the control runs on. Metric is
 * the catalog's own system, so the default is the identity transform.
 */
export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'metric'

/** Type guard for backup validation + a hydrated-value repair. */
export function isUnitSystem(value: unknown): value is UnitSystem {
  return value === 'metric' || value === 'imperial'
}

/* ---------- Exact-ish conversion factors ---------- */

/** International avoirdupois ounce, grams. */
export const GRAMS_PER_OUNCE = 28.3495
/** Kilogram per pound. */
export const KILOGRAMS_PER_POUND = 0.453592
/** US fluid ounce, millilitres. */
export const MILLILITRES_PER_FLUID_OUNCE = 29.5735
/** Centimetres per inch. */
export const CENTIMETRES_PER_INCH = 2.54

/** °C → °F, nearest integer (the oven-rounding grammar of the catalog). */
export function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32)
}

/** °F → °C, nearest integer. */
export function fahrenheitToCelsius(f: number): number {
  return Math.round((f - 32) * 5 / 9)
}

/**
 * How far apart two authored notations of "the same" temperature may sit
 * (in °C) before we stop believing they are a restatement of each other.
 *
 * The catalog's own pairs are sloppy: `220°C (425°F)` is 2.2° apart in
 * Celsius terms, `200°C (400°F)` 4.4°, and the single worst authored pair
 * in the corpus is 6.7° — every real dual-notation pair in 2,759 recipes
 * is inside 7. A tolerance of 7 therefore collapses EVERY genuine
 * restatement while still converting a parenthetical that genuinely states
 * a different temperature independently (see `localizeText`).
 */
const PAIR_TOLERANCE_C = 7

/* ---------- Unit tables ---------- */

/**
 * Metric unit → imperial factor + label. Only the four units the catalog
 * authors in metric are listed; everything else (cups, tbsp, cloves,
 * bunches, pkg…) is already imperial-native or a count and passes through
 * in BOTH systems (ADR-0047, Alternatives: converting cups would churn
 * every existing pin for no user need).
 */
const METRIC_TO_IMPERIAL: ReadonlyMap<string, readonly [number, string]> = new Map([
  ['kg', [1 / KILOGRAMS_PER_POUND, 'lb']],
  ['g', [1 / GRAMS_PER_OUNCE, 'oz']],
  ['ml', [1 / MILLILITRES_PER_FLUID_OUNCE, 'fl oz']],
  ['cm', [1 / CENTIMETRES_PER_INCH, 'inch']],
])

/** Lower-cased lookup key: the unit token, plurals collapsed. */
function unitKey(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.endsWith('.') && u.length > 1) return u.slice(0, -1)
  return u
}

/* ---------- Temperatures and lengths in prose ---------- */

/** `220°C`, `450 °F`, `205.5°C`. The catalog always writes the degree sign. */
const TEMP_RE = /(\d+(?:\.\d+)?)\s*°\s*([CF])/g

/** A dual-notation pair: `220°C (425°F)` or `450°F (232°C)`. */
const TEMP_PAIR_RE = /(\d+(?:\.\d+)?)\s*°\s*([CF])[ \t]*\([ \t]*(\d+(?:\.\d+)?)[ \t]*°[ \t]*([CF])[ \t]*\)/g

/** A leading amount with an optional fraction: `5`, `2 ½`, `3/4`. */
const LENGTH_AMOUNT = String.raw`\d+(?:[.,]\d+)?(?:\s+[¼½¾⅓⅔⅛⅜⅝⅞])?(?:\s*\/\s*\d+)?`

/**
 * A length mention: `5 cm`, `2 ½ cm`, `1 inch`, `6 inches`, `2 in`.
 * `in` is guarded against longer words so "into"/"inch" stay prose.
 */
const LENGTH_RE = new RegExp(
  `(${LENGTH_AMOUNT})[ \\t]*(cm|inch(?:es)?|in)(?![a-z])`,
  'gi',
)

/** `inch` / `inches` by magnitude, so a converted length reads naturally. */
function inchLabel(amount: number): string {
  return Math.abs(amount) <= 1 ? 'inch' : 'inches'
}

function convertTemperature(value: number, from: 'C' | 'F', system: UnitSystem): number {
  const to = system === 'imperial' ? 'F' : 'C'
  if (from === to) return value
  return to === 'F' ? celsiusToFahrenheit(value) : fahrenheitToCelsius(value)
}

/**
 * The temperature pass over authored prose.
 *
 * - A token already in the target system is left alone.
 * - A dual-notation pair that agrees within `PAIR_TOLERANCE_C` is ONE
 *   temperature and renders as one token, preferring the notation the
 *   author already wrote in the target system (`220°C (425°F)` → `220°C`
 *   in metric, `425°F` in imperial; `450°F (232°C)` → `232°C` / `450°F`).
 * - A parenthetical that states a genuinely DIFFERENT temperature is never
 *   dropped: both notations convert, independently.
 * - A lone temperature converts.
 */
function localizeTemperatures(text: string, system: UnitSystem): string {
  const unit = system === 'imperial' ? 'F' : 'C'
  const withPairs = text.replace(
    TEMP_PAIR_RE,
    (_match, aRaw: string, aUnit: 'C' | 'F', bRaw: string, bUnit: 'C' | 'F') => {
      const a = Number(aRaw)
      const b = Number(bRaw)
      const aC = aUnit === 'C' ? a : (a - 32) * 5 / 9
      const bC = bUnit === 'C' ? b : (b - 32) * 5 / 9
      if (Math.abs(aC - bC) <= PAIR_TOLERANCE_C) {
        // A restatement: keep ONE token, preferring what the author wrote
        // in the target system so the catalog's own rounding survives.
        const kept = aUnit === unit ? a : bUnit === unit ? b : undefined
        const value = kept ?? (unit === 'F' ? celsiusToFahrenheit(aC) : aC)
        return `${Math.round(value)}°${unit}`
      }
      // Different temperatures: convert each, keep both.
      const av = convertTemperature(a, aUnit, system)
      const bv = convertTemperature(b, bUnit, system)
      return `${av}°${unit} (${bv}°${unit})`
    },
  )
  return withPairs.replace(
    TEMP_RE,
    (_match, raw: string, from: 'C' | 'F') => `${convertTemperature(Number(raw), from, system)}°${unit}`,
  )
}

/** The length pass: `5 cm` ↔ `1 inch`, fractions included. */
function localizeLengths(text: string, system: UnitSystem): string {
  return text.replace(LENGTH_RE, (match, amountRaw: string, unitRaw: string) => {
    const parsed = parseQuantity(amountRaw)
    if (!parsed || !(parsed.amount > 0)) return match
    const u = unitRaw.toLowerCase()
    if (u === 'cm') {
      if (system === 'metric') return match
      const inches = parsed.amount / CENTIMETRES_PER_INCH
      return `${formatAmount(inches)} ${inchLabel(inches)}`
    }
    // inch / in
    if (system === 'imperial') return match
    return `${formatAmount(parsed.amount * CENTIMETRES_PER_INCH)} cm`
  })
}

/**
 * Localize AUTHORED PROSE for display: instruction steps and any other
 * sentence. Temperatures first (a dropped parenthetical must not take a
 * length with it), then lengths.
 *
 * Metric is not the identity here — the catalog's dual notation reads
 * badly in BOTH systems, and collapsing it to the target system is the
 * whole point of the setting. Text with no temperature and no length is
 * returned unchanged, so a step that mentions nothing measurable is
 * bit-for-bit the authored string.
 */
export function localizeText(text: string, system: UnitSystem): string {
  if (!text) return text
  return localizeLengths(localizeTemperatures(text, system), system)
}

/* ---------- Formatted amounts ---------- */

/**
 * Localize a FORMATTED quantity string for display: a line item, a
 * container quantity (`½ (142 g) pkg`, `1 (142 g) pkg`) or a grocery /
 * measured-chip line.
 *
 * Metric is the IDENTITY (ADR-0047 §1: the catalog's metric quantity IS
 * today's display). Imperial converts the leading unit — or, for a
 * container quantity, the ANNOTATION, which is where the catalog hides its
 * unit (`(142 g)` on a `pkg` line, `(2 ½ cm)` on a `pieces` line). The
 * container COUNT is a count of purchased objects and never changes.
 *
 * The string is returned VERBATIM when there is nothing to convert: a
 * free-form custom extra, a count (`6 cloves`), a container phrase
 * (`1 small bunch`) or a unit that is already imperial-native
 * (cups, tbsp, oz, lb, inch).
 */
/**
 * The authored LEADING AMOUNT, matched as a SPAN so it can be preserved
 * verbatim. `parseQuantity` sums a fraction into a float (`½` → 0.5) and
 * discards how it was spelled, so re-formatting its `amount` would reflow
 * an authored `½` into `0.5` and a mixed `1 ½` into `1.5` whenever a
 * sibling token (a container annotation, say) was the thing that actually
 * converted. Re-running the parse on the span instead also picks up the
 * ASCII-fraction form (`3/4 kg`) that `parseQuantity` reads as amount `3`
 * plus a unit of `/4 kg`.
 */
const LEADING_AMOUNT_RE = new RegExp(
  '^(\\d+\\s*[¼½¾⅓⅔⅛⅜⅝⅞]+|\\d+(?:[.,]\\d+)?(?:\\s*/\\s*\\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞]+)',
)

export function localizeQuantity(raw: string, system: UnitSystem): string {
  if (system === 'metric') return raw
  const parsed = parseQuantity(raw)
  if (!parsed) {
    // Free-form text (`a pinch`, `to taste`) — nothing to convert, but a
    // stray temperature still localizes.
    return localizeText(raw, system)
  }
  const trimmed = raw.trim()
  const span = trimmed.match(LEADING_AMOUNT_RE)
  const headText = span ? span[0] : formatAmount(parsed.amount)
  // Re-parse the SPAN so an ASCII fraction scales as the fraction it is.
  const amount = (span ? parseQuantity(span[0])?.amount : null) ?? parsed.amount
  let rest = trimmed.slice(headText.length).trim()
  let annotation = ''
  const ann = rest.match(/^(\([^)]*\))\s*/)
  if (ann) {
    // The annotation carries the unit in container quantities: localize
    // its INNER text and keep the parentheses verbatim.
    const inner = ann[1].slice(1, -1).trim()
    annotation = `(${localizeQuantity(inner, system)})`
    rest = rest.slice(ann[0].length).trim()
  }

  const tokens = rest.split(/\s+/).filter(Boolean)
  const last = tokens[tokens.length - 1]
  // Only a BARE unit converts. A multi-word phrase is a container noun
  // (`small bunch`, `cm pieces`) or an already-imperial label (`fl oz`);
  // guessing inside it would rewrite prose.
  const conversion = rest ? METRIC_TO_IMPERIAL.get(unitKey(last)) : undefined
  if (!conversion) {
    const head = annotation ? `${headText} ${annotation}` : headText
    return rest ? `${head} ${rest}` : head
  }
  const [factor, label] = conversion
  const converted = amount * factor
  const head = formatAmount(converted)
  const noun = label === 'inch' ? inchLabel(converted) : label
  // `rest` IS the bare token that converted, so the rendered noun replaces
  // it — never both, or an imperial line would read `8 oz lb`.
  return annotation ? `${head} ${annotation} ${noun}` : `${head} ${noun}`
}

/**
 * The grocery/measured-chip entry point: a DISPLAY STRING that may hold an
 * amount, a container annotation and a unit. Same transform as
 * `localizeQuantity`, named for its call site so a reader knows the
 * canonical key basis is deliberately NOT what this touches.
 */
export const localizeLine = localizeQuantity

/**
 * Localize scaled instruction steps for display. ONE helper, called by
 * both RecipeDetail and CookingView, so the two surfaces cannot drift.
 *
 * Runs in BOTH systems: the catalog's dual notation reads badly in metric
 * too (`220°C (425°F)`), and collapsing it to the target system is the
 * point of the setting. `localizeText` is a no-op on a step that mentions
 * no temperature and no length, so such a step is still bit-for-bit the
 * authored string.
 *
 * Structural on purpose: the caller owns its `ScaledStep` type, and this
 * module stays free of a runtime import of `recipe.ts`.
 */
export function localizeSteps<T extends { primary: string; details: string[] }>(
  steps: readonly T[],
  system: UnitSystem,
): T[] {
  return steps.map((step) => ({
    ...step,
    primary: localizeText(step.primary, system),
    details: step.details.map((line) => localizeText(line, system)),
  }))
}
