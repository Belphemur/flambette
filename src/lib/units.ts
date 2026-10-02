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
 *   pkg`, `½ (142 g) pkg`). `dual` is the IDENTITY: the catalog text IS
 *   today's display, so an install that never touches the control cannot
 *   churn a single existing pin.
 * - `localizeText` — authored PROSE (instruction steps): temperatures and
 *   lengths. `dual` is the identity here too: the catalog writes dual
 *   notation inconsistently (`220°C (425°F)` AND `450°F (232°C)`), so a
 *   reader who wants ONE system asks for it explicitly and a reader who
 *   wants the catalog as authored gets exactly that.
 *
 * Pure lib: no Vue/Pinia imports, unit-tested like the rest of `src/lib`.
 */

import { formatAmount, parseQuantity } from './quantity'

/**
 * The three settings. `dual` — the catalog exactly as authored — is the
 * default: it is the TRUE identity, so every display pin that predates this
 * ADR stays green without touching a single spec.
 */
export type UnitSystem = 'dual' | 'metric' | 'imperial'

/** The three accepted systems, in menu order. */
export const UNIT_SYSTEMS: readonly UnitSystem[] = ['dual', 'metric', 'imperial']

/**
 * The label a shopper thinks in, for BOTH surfaces that offer the setting
 * (the recipe-detail toggle and the Settings card). The units a system
 * actually switches live in the Settings card's per-mode note, so the label
 * stays short and a button never reflows its row. One registry: the two
 * surfaces are the same setting, so they must be the same words too.
 */
export const UNIT_SYSTEM_LABEL: Record<UnitSystem, string> = {
  dual: 'Dual',
  metric: 'Metric',
  imperial: 'Imperial',
}

/**
 * The default an install that never touches the control runs on: the exact
 * authored catalog text.
 */
export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'dual'

/** Type guard for backup validation + a hydrated-value repair. */
export function isUnitSystem(value: unknown): value is UnitSystem {
  return value === 'dual' || value === 'metric' || value === 'imperial'
}

/** True for the two modes that pick ONE system (everything else is dual). */
function isSingleSystem(system: UnitSystem): boolean {
  return system !== 'dual'
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
 * authors in metric are listed; everything else (tbsp, cloves, bunches,
 * pkg…) is already imperial-native or a count and passes through. `cup` is
 * not here either: it is a purchasable VOLUME container, so it keeps its
 * count and gains a volume ANNOTATION instead (see `cupAnnotation`).
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
 * A length mention: `5 cm`, `2 ½ cm`, `1 inch`, `6 inches`.
 *
 * The corpus hyphenates lengths 408 times (`3-inch`, `1 ¼-cm`), so the
 * separator is a space OR a hyphen.
 *
 * There is deliberately NO bare `in` alternative: the catalog writes lengths
 * in full (`inch`/`inches`) and, more importantly, `<number> in` is ordinary
 * ENGLISH (`cut 2 in half`, `cook 3 in batches`). A two-letter unit behind a
 * digit rewrites prose into lengths on every step the app localizes — in
 * METRIC too, since the pass runs in both systems — so the abbreviation is
 * not worth the corpus gain. Corpus check over all 2,759 docs: 0 occurrences
 * of `<number> in`, 0 of `<number>-in`.
 */
const LENGTH_RE = new RegExp(
  `(${LENGTH_AMOUNT})[ \\t]*(?:-[ \\t]*)?(cm|inch(?:es)?)(?![a-z])`,
  'gi',
)

/**
 * A temperature RANGE that writes its degree sign once:
 * `180-200°C`, `350 to 375°F`. Handled BEFORE the lone-token pass, which
 * would otherwise convert only the upper bound and turn `180-200°C` into
 * the wrong `180-392°F`. The degree sign is what makes this safe: `20-25
 * minutes` carries none, so it stays prose.
 */
const TEMP_RANGE_RE =
  /(\d+(?:\.\d+)?)([ \t]*(?:-|–|—|to)[ \t]*)(\d+(?:\.\d+)?)[ \t]*°[ \t]*([CF])/g

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
 * - A range whose degree sign is written once converts BOTH bounds.
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
  // Ranges next, before the lone-token pass: both bounds share one degree
  // sign, so the token pass would convert only the upper one.
  const withRanges = withPairs.replace(
    TEMP_RANGE_RE,
    (
      _match,
      lowRaw: string,
      sep: string,
      highRaw: string,
      from: 'C' | 'F',
    ) =>
      `${convertTemperature(Number(lowRaw), from, system)}${sep}${convertTemperature(
        Number(highRaw),
        from,
        system,
      )}°${unit}`,
  )
  return withRanges.replace(
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
 * `dual` is the IDENTITY — the catalog's own `220°C (425°F)` is exactly
 * what a dual reader wants, and the default must not churn a single display
 * pin. `metric` and `imperial` each collapse the pair to the ONE system the
 * reader asked for. Text with no temperature and no length is returned
 * unchanged in EVERY mode, so a step that mentions nothing measurable is
 * bit-for-bit the authored string.
 */
export function localizeText(text: string, system: UnitSystem): string {
  if (!text || !isSingleSystem(system)) return text
  return localizeLengths(localizeTemperatures(text, system), system)
}

/* ---------- Formatted amounts ---------- */

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

/** US legal cup, millilitres — exact, so metric annotation has no rounding. */
const MILLILITRES_PER_CUP = 240
/** US cup, US fluid ounces. */
const FLUID_OUNCES_PER_CUP = 8

/**
 * The ANNOTATION a purchasable VOLUME container gains in a single-system
 * mode, or `undefined` when it needs none.
 *
 * This is the SAME annotation grammar the catalog already uses for its own
 * container weights (`½ (142 g) pkg`), deliberately not a parallel code
 * path: a `cup` is a purchased object whose volume nobody can see, so a
 * reader who picked ONE system is shown that system in parentheses next to
 * it — `1 cup (240 ml)` in metric (US legal cup, exact), `1 cup (8 fl oz)`
 * in imperial. `dual` passes none: the authored text is `1 cup` and stays
 * that way.
 */
function cupAnnotation(amount: number, system: UnitSystem): string | undefined {
  if (system === 'metric') return `(${formatAmount(amount * MILLILITRES_PER_CUP)} ml)`
  if (system === 'imperial') return `(${formatAmount(amount * FLUID_OUNCES_PER_CUP)} fl oz)`
  return undefined
}

/** A bare `cup` / `cups` token — the one purchasable volume in the catalog. */
function isCupToken(rest: string): boolean {
  return /^cups?$/i.test(rest.trim())
}

/**
 * Localize a FORMATTED quantity string for display: a line item, a
 * container quantity (`½ (142 g) pkg`, `1 (142 g) pkg`) or a grocery /
 * measured-chip line.
 *
 * `dual` is the IDENTITY (ADR-0047 §1: the authored catalog text IS
 * today's display). `imperial` converts the leading unit — or, for a
 * container quantity, the ANNOTATION, which is where the catalog hides its
 * unit (`(142 g)` on a `pkg` line, `(2 ½ cm)` on a `pieces` line).
 * `metric` is the identity for every value the catalog already authors in
 * metric, but still annotates a `cup`, because cup is not itself a metric
 * volume. The container COUNT is a count of purchased objects and never
 * changes in any mode.
 *
 * The string is returned VERBATIM when there is nothing to convert: a
 * free-form custom extra, a count (`6 cloves`), a container phrase
 * (`1 small bunch`) or a unit that is already imperial-native
 * (cups in dual, tbsp, oz, lb, inch).
 */
export function localizeQuantity(raw: string, system: UnitSystem): string {
  if (!isSingleSystem(system)) return raw
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
  // Only a BARE unit converts, and only in IMPERIAL: in metric the catalog's
  // own g/kg/ml values are already the target system and are the IDENTITY.
  // A multi-word phrase is a container noun (`small bunch`, `cm pieces`) or
  // an already-imperial label (`fl oz`); guessing inside it would rewrite
  // prose.
  const conversion =
    system === 'imperial' && rest && tokens.length === 1 && !isCupToken(rest)
      ? METRIC_TO_IMPERIAL.get(unitKey(last))
      : undefined
  if (!conversion) {
    const head = annotation ? `${headText} ${annotation}` : headText
    // A bare `cup` gains the mode's volume through the SAME annotation
    // grammar, never a special-cased rewrite of the count. A line that
    // ALREADY carries an authored annotation has said its volume — adding
    // a second one would double-annotate it.
    const cup =
      !annotation && tokens.length === 1 && isCupToken(rest)
        ? cupAnnotation(amount, system)
        : undefined
    if (cup) return `${head} ${rest} ${cup}`
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
 * Runs in the two SINGLE-system modes: a reader who asked for one system
 * gets one system (`220°C (425°F)` → `220°C` metric / `425°F` imperial).
 * `dual` — the default — returns the authored string untouched. In every
 * mode `localizeText` is a no-op on a step that mentions no temperature and
 * no length, so such a step is always bit-for-bit the authored string.
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
