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

import { formatAmount, formatFraction, parseQuantity } from './quantity'

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

/** A length mention: `5 cm`, `2 ½ cm`, `6-mm`, `1 inch`, `6 inches`.
 *
 * The corpus hyphenates lengths 408 times (`3-inch`, `1 ¼-cm`), so the
 * separator is a space OR a hyphen — and it is CAPTURED (group 2) so the
 * conversion preserves the authoring style (`6-mm` → `¼-inch`). The mm
 * alternative closes the ADR-0047 known gap: the corpus spells
 * millimetres ONLY hyphenated-after-a-number (`6-mm`, 166 prose steps).
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
  `(${LENGTH_AMOUNT})([ \\t]*(?:-[ \\t]*)?)(cm|mm|inch(?:es)?)(?![a-z])`,
  'gi',
)

/**
 * A temperature RANGE that writes its degree sign once:
 * `180-200°C`, `350 to 375°F`. Handled BEFORE the lone-token pass, which
 * would otherwise convert only the upper bound and turn `180-200°C` into
 * the wrong `180-392°F`. The degree sign is what makes this safe: `20-25
 * minutes` carries none, so it stays prose.
 *
 * The degree sign alone is NOT sufficient, though: prose pairs a lone
 * small number with a real temperature the same way (`Cook 2 to 350°F`,
 * `at step 3 - 200°C`), and the low bound of such a match is a step
 * number, not a temperature. `isPlausibleTempRange` is what tells the two
 * apart.
 */
const TEMP_RANGE_RE =
  /(\d+(?:\.\d+)?)([ \t]*(?:-|–|—|to)[ \t]*)(\d+(?:\.\d+)?)[ \t]*°[ \t]*([CF])/g

/**
 * The floor below which no cooking setpoint in this catalog lives.
 *
 * 60 °C is the highest of the two thresholds expressed in Celsius (60 °C
 * is 140 °F), and it sits UNDER the lowest authored temperature mention in
 * the frozen corpus — 65 °C / 145 °F, which is a slow-roast / sous-vide
 * low end. Nothing below that is an oven, a bain-marie or a probe setpoint
 * here, so a lower bound is prose, not a temperature.
 *
 * Stated as a floor on the LOW bound only: the upper bound is unconstrained
 * (baking goes to 260 °C / 500 °F) because the range reads low→high, so an
 * ordering check already rejects an upper bound below the floor.
 */
const MIN_PLAUSIBLE_RANGE_C = 60

/** The same floor in Fahrenheit (60 °C == 140 °F). */
const MIN_PLAUSIBLE_RANGE_F = 140

/**
 * Does `<low><sep><high> °<unit>` actually read as a temperature range?
 *
 * Two checks, both in the SOURCE unit so the answer never depends on which
 * system the reader asked for:
 * 1. the low bound is at or above the catalog's floor — this is what
 *    rejects `Cook 2 to 350°F` and `step 3 - 200°C`, whose low bounds are
 *    an unrelated prose number;
 * 2. the bounds ascend — a descending pair is prose order, not a range.
 *
 * Both bounds are then genuinely temperatures, because the ascending check
 * puts the high bound at or above the low bound.
 */
function isPlausibleTempRange(low: number, high: number, from: 'C' | 'F'): boolean {
  const floor = from === 'C' ? MIN_PLAUSIBLE_RANGE_C : MIN_PLAUSIBLE_RANGE_F
  return low >= floor && low < high
}

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
 * - A range whose degree sign is written once converts BOTH bounds — but
 *   only when both bounds are PLAUSIBLE temperatures (see
 *   `isPlausibleTempRange`); otherwise the match is prose and falls through
 *   to the lone-token pass, which still converts the real temperature in it.
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
  //
  // A REJECTED range is returned verbatim, which is what lets the lone-token
  // pass do its own (correct) thing on the one genuine temperature in the
  // match: `Cook 2 to 350°F` keeps its prose `2 to` and converts only
  // `350°F`.
  const withRanges = withPairs.replace(
    TEMP_RANGE_RE,
    (
      match,
      lowRaw: string,
      sep: string,
      highRaw: string,
      from: 'C' | 'F',
    ) => {
      const low = Number(lowRaw)
      const high = Number(highRaw)
      if (!isPlausibleTempRange(low, high, from)) return match
      return `${convertTemperature(low, from, system)}${sep}${convertTemperature(
        high,
        from,
        system,
      )}°${unit}`
    },
  )
  return withRanges.replace(
    TEMP_RE,
    (_match, raw: string, from: 'C' | 'F') => `${convertTemperature(Number(raw), from, system)}°${unit}`,
  )
}

/** The length pass: `5 cm` ↔ `2 inches`, fractions included, mm now covered.
 *
 * ADR-0057: converted lengths quantize to the ¼-inch grid and render as
 * fraction glyphs (`6-mm` → `¼-inch`, NOT `0.2 inch`), and the authoring
 * separator is preserved — a hyphenated source stays hyphenated.
 */
function localizeLengths(text: string, system: UnitSystem): string {
  return text.replace(LENGTH_RE, (match, amountRaw: string, sep: string, unitRaw: string) => {
    const parsed = parseQuantity(amountRaw)
    if (!parsed || !(parsed.amount > 0)) return match
    const glue = sep.includes('-') ? '-' : ' '
    const u = unitRaw.toLowerCase()
    if (u === 'cm' || u === 'mm') {
      // Upstream AUTHORS fractions in every metric profile (`2 ½ cm`,
      // `1 ¼-cm-thick`, all static across 2/4/6 servings) — metric mode is
      // the IDENTITY for authored spans, exactly like dual.
      if (system === 'metric') return match
      const cm = u === 'mm' ? parsed.amount / 10 : parsed.amount
      const inches = inchRender(cm)
      return `${formatFraction(inches)}${glue}${inchLabel(inches)}`
    }
    // inch / in
    if (system === 'imperial') return match
    return `${formatAmount(parsed.amount * CENTIMETRES_PER_INCH)}${glue}cm`
  })
}

/**
 * cm/mm → inch, ADR-0057 measured (652 joined step rows, 99.7%): nearest ⅛
 * below 2 inches (`6 mm → ¼-inch`, `3 mm → ⅛-inch`, `2 cm → ¾-inch`,
 * `2 ½ cm → 1-inch` — upstream metricates inches at 2.5 cm/inch), whole
 * inches at 2 and above (`5 cm → 2`, `15 cm → 6`). Floored at ⅛ — zero is
 * never an inch span.
 */
function inchRender(cm: number): number {
  const inches = cm / CENTIMETRES_PER_INCH
  if (inches >= 2) return Math.round(inches)
  return Math.max(0.125, Math.round(inches * 8) / 8)
}

/**
 * kg → lb, ADR-0057 measured (1,760 joined line rows, 99.6%): an exact
 * third-product keeps the third (`0.15 kg → ⅓ lb`, 7/7 — 0.3307 sits
 * within tolerance of ⅓), everything else quantizes to the nearest ¼ lb
 * floored there — upstream never renders less than `¼ lb`.
 */
function kgLbRender(kg: number): number {
  const pounds = kg / KILOGRAMS_PER_POUND
  for (const d of [3, 4]) {
    if (Math.abs(pounds * d - Math.round(pounds * d)) < 0.02) return Math.round(pounds * d) / d
  }
  return Math.max(0.25, Math.round(pounds * 4) / 4)
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

/** Quantize to a fraction grid: `qzTo(15.87, 0.5)` → `16`. */
function qzTo(v: number, step: number): number {
  return Math.round(v / step) * step
}

function isMultiple(v: number, step: number): boolean {
  const q = v / step
  return Math.abs(q - Math.round(q)) < 1e-6
}

/**
 * Spoon-scale ml the us profile keeps AS ml (ADR-0057, measured): `90 ml`
 * (69×), `135 ml` (33×), `45 ml` (15×), `30 ml` (5×), `270 ml` and `720 ml`
 * all stay ml in us-6. Above the spoon scale a tbsp multiple converts
 * anyway (`1065 ml` → `36 fl oz`), so the ceiling is where the evidence
 * ends: 720 ml.
 */
function keepsMillilitres(amount: number): boolean {
  return isMultiple(amount, 15) && amount <= 720
}

/**
 * The canned-good sizes the us profile renders in NET-WEIGHT-style oz
 * rather than arithmetic fl oz (ADR-0057, measured): us-6 authors
 * `(398 ml)` as `(14.5 oz)`/`(15 oz)`, `(213 ml)` as `(8 oz)`, `(170 ml)`
 * as `(6 oz)`, `(284 ml)` as `(10 oz)`. Annotation context only — a bare
 * `398 ml` line converts arithmetically.
 */
const CAN_SIZE_OZ: ReadonlyMap<number, string> = new Map([
  [398, '15'],
  [213, '8'],
  [170, '6'],
  [284, '10'],
])

/**
 * Line-level fl oz quantization (ADR-0057, measured): below 6 fl oz the
 * ¼ grid applies (`67 ml` → `2 ¼ fl oz`, `133 ml` → `4 ½ fl oz` — the only
 * fractional values the us profile authors); at 6 fl oz and above the us
 * profile renders whole numbers (`708 ml` → `24`, `2124 ml` → `72`,
 * `1230 ml` → `42` — every fractional candidate above 6 rounds out).
 */
function flOzQuantized(amount: number): number {
  const fl = amount / MILLILITRES_PER_FLUID_OUNCE
  // A ¼-fl-oz floor like every sibling converter: upstream's smallest
  // fl-oz rendering is ¾ (us-2 census), zero is never authored.
  return fl >= 6 ? Math.round(fl) : Math.max(0.25, qzTo(fl, 0.25))
}

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
export function localizeQuantity(
  raw: string,
  system: UnitSystem,
  options?: { readonly annotationContext?: boolean },
): string {
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
    // its INNER text and keep the parentheses verbatim. Upstream authors
    // annotations in plain decimals (`(8.5 fl oz)`), so the inner pass is
    // told it is annotation context (decimal rendering, can-size table).
    const inner = ann[1].slice(1, -1).trim()
    annotation = `(${localizeQuantity(inner, system, { annotationContext: true })})`
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
  const key = unitKey(last)
  // The us profile keeps spoon-scale ml verbatim ('90 ml' → '90 ml').
  if (key === 'ml' && keepsMillilitres(amount)) {
    return rest ? `${headText} ${rest}` : headText
  }
  // Annotations render the way the us profile authors them: plain decimals
  // (`(3.8 oz)`, `(8 fl oz)`), can sizes in oz, no quantization.
  if (options?.annotationContext) {
    if (key === 'ml') {
      const can = CAN_SIZE_OZ.get(amount)
      if (can !== undefined) return `${can} oz`
    }
    const converted = amount * factor
    const head = formatAmount(converted)
    const noun = label === 'inch' ? inchLabel(converted) : label
    return annotation ? `${head} ${annotation} ${noun}` : `${head} ${noun}`
  }
  // ADR-0057: the quantization grids the us profile actually authors —
  // ½ oz for grams (floored at ½ oz: `14 g → ½ oz`, never `0 oz`), ¼ lb
  // for kilograms, ¼ fl oz below 6 for millilitres, ⅛ inch for
  // centimetres — rendered as fraction glyphs (`2 ¼ fl oz`, `4 ½ oz`,
  // `2 ¼ lb`).
  const converted =
    key === 'g'
      ? Math.max(0.5, qzTo(amount / GRAMS_PER_OUNCE, 0.5))
      : key === 'kg'
        ? kgLbRender(amount)
        : key === 'ml'
          ? flOzQuantized(amount)
          : key === 'cm'
            ? inchRender(amount)
            : amount * factor
  const head = formatFraction(converted)
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
