import {
  formatMetricAmount,
  parseQuantity,
  quantizeSpoons,
  scaleMetricAmount,
} from './quantity'
import type { RecipeDoc } from './types'

/** One instruction step, scaled to the target servings. */
export interface ScaledStep {
  primary: string
  details: string[]
  /**
   * True when the step opens with "Meanwhile" — it is meant to run
   * concurrently with the previous step (ADR-0010).
   */
  concurrent: boolean
}

/* ---------- Seasoning classification (ADR-0009) ---------- */

/**
 * Keywords that mark an ingredient/line as a seasoning: more servings do
 * NOT need proportionally more salt/spices, so these scale sub-linearly
 * and are capped. Case-insensitive substring match on the name (or the
 * whole step-detail line, which embeds the name after the quantity).
 *
 * Curation notes (deviations from the raw keyword list, for correctness):
 * - bare "pepper" is NOT a keyword: "green/bell pepper" scale linearly.
 *   Use "black pepper" / "white pepper" / "red pepper" (covers "red pepper
 *   flakes" and "crushed red pepper"); a 'bell' exclusion guards hybrids.
 * - bare "cloves" is NOT a keyword: "6 cloves garlic" is a vegetable
 *   amount. The spice only appears as "ground cloves" / "whole cloves".
 */
export const seasoningNames: ReadonlySet<string> = new Set([
  'salt',
  'black pepper',
  'white pepper',
  'red pepper',
  'cayenne',
  'paprika',
  'cumin',
  'chili',
  'curry',
  'turmeric',
  'cinnamon',
  'ginger',
  'nutmeg',
  'ground cloves',
  'whole cloves',
  'oregano',
  'basil',
  'thyme',
  'rosemary',
  'bay leaf',
  'garlic powder',
  'onion powder',
])

/**
 * Substrings that veto a seasoning match — a season DESCRIBES, it never
 * IS, when embedded in a longer name (ADR-0009, ADR-0057):
 *
 * - `bell` — "red bell pepper" is a vegetable.
 * - `ginger root` — the fresh root scales LINEARLY upstream (302/306
 *   archived metric-6 → metric-2 pairs scale exactly ×⅓; measured
 *   2026-10-05). It is the root, not the spice.
 * - `sesame ginger dressing` — a measured dressing scales linearly
 *   (¾ cup → ½ → ¼ in the archive), however much ginger it name-drops.
 */
const SEASONING_EXCLUSIONS = ['bell', 'ginger root', 'sesame ginger dressing']

/**
 * The keyword list compiled to WORD-BOUNDARY regexes (plural-tolerant).
 * Substring matching matched `unsalted` for `salt` (460 line items wrong:
 * butter and roasted nuts are not seasonings) — the boundary is what makes
 * `\bsalt\b` fail inside `unsalted`. The census over all 2,759 docs shows
 * the ONLY verdicts that change are the four unsalted names; every
 * legitimate match ("sea salt", "chilies", "red pepper flakes") still
 * matches, so the sub-linear rule's coverage is unchanged.
 */
const KEYWORD_RES: ReadonlyArray<RegExp> = [...seasoningNames].map((kw) => {
  if (kw === 'bay leaf') return /\bbay (?:leaves|leafs?)\b/
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  return new RegExp(`\\b${escaped}(?:e?s)?\\b`)
})

/** True when `text` (an ingredient name or a step-detail line) is a seasoning. */
export function isSeasoning(text: string): boolean {
  const s = text.toLowerCase()
  if (SEASONING_EXCLUSIONS.some((x) => s.includes(x))) return false
  return KEYWORD_RES.some((re) => re.test(s))
}

/**
 * Absolute per-recipe caps for seasonings, expressed in the ingredient's
 * OWN unit, keyed by name fragment (most specific fragment wins). A
 * single recipe can never be oversalted beyond this, even at huge serving
 * counts. Ingredients without an entry default to 2× the authored amount.
 */
export const servingCaps: Record<string, number> = {
  salt: 4,
  'black pepper': 2,
  'red pepper': 2,
  cayenne: 1,
  chili: 2,
  'garlic powder': 2,
  'onion powder': 2,
}

/** Default cap: this multiple of the authored amount. */
const DEFAULT_CAP_MULTIPLE = 2

/** Sub-linear growth exponent for seasonings. */
const SEASONING_EXPONENT = 0.75

function capFor(name: string | undefined): number | undefined {
  if (!name) return undefined
  const s = name.toLowerCase()
  const keys = Object.keys(servingCaps).sort((a, b) => b.length - a.length)
  for (const k of keys) {
    if (s.includes(k)) return servingCaps[k]
  }
  return undefined
}

/** Round to 3 decimals (kills float drift before display formatting). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Scale an authored quantity from `base` to `target` servings.
 *
 * - Non-seasonings scale linearly (unchanged behaviour, ADR-0009).
 * - Seasonings scale sub-linearly (`ratio ** 0.75`) and are capped: the
 *   named `servingCaps` entry when one matches, otherwise 2× the authored
 *   amount — so a single recipe can't be oversalted at 36 servings.
 *
 * Returns a 3-decimal number; callers format for display.
 */
export function scaleQuantity(
  q: number,
  base: number,
  target: number,
  isSeasoning: boolean,
  name?: string,
): number {
  if (base <= 0 || target <= 0) return round3(q)
  const ratio = target / base
  if (!isSeasoning) return round3(q * ratio)
  const scaled = q * ratio ** SEASONING_EXPONENT
  const cap = Math.min(capFor(name) ?? Infinity, q * DEFAULT_CAP_MULTIPLE)
  return round3(Math.min(scaled, cap))
}

/* ---------- Instruction-step scaling ---------- */

/**
 * Scale one secondary_message detail line (e.g. "¾ tsp salt") to the
 * target servings, applying the seasoning rules when the line names a
 * seasoning. Unparseable lines and the unscaled case (factor === 1) pass
 * through verbatim, exactly like the pre-ADR behaviour.
 */
function scaleStepLine(line: string, base: number, target: number, factor: number): string {
  const parsed = parseQuantity(line)
  if (!parsed || factor === 1) return line
  // ADR-0055: ONE scaling vocabulary on every surface. The line, the chip
  // under it (measuredAmounts) and the grocery sum all use the same model —
  // seasonings keep `scaleQuantity`'s sub-linear rule, everything else
  // scales through `scaleMetricAmount`'s quantized grammar — and the render
  // is `formatMetricAmount` (unicode fraction glyphs, integer g/ml), so
  // `2129 ml ×⅔` reads `1420 ml` here too, never `1419 ml`.
  const amount = isSeasoning(line)
    ? quantizeSpoons(scaleQuantity(parsed.amount, base, target, true, line), parsed.unit)
    : scaleMetricAmount(parsed.amount, factor, parsed.unit)
  // The seasoning result joins the SAME spoon vocabulary: upstream never
  // authors a decimal spoon, so `2.523 tsp` reads `2 ½ tsp` — the ⅛-grid
  // glyph the grocery sum and the measured chip render for the same
  // ingredient (ADR-0055, one vocabulary on every surface).
  const rendered = formatMetricAmount(amount, parsed.unit)
  return parsed.unit ? `${rendered} ${parsed.unit}` : rendered
}

/**
 * Scale a recipe's instruction steps by a servings factor. Shared by the
 * detail sheet and the cooking view so both render identical step text.
 * Each newline of `secondary_message` becomes a detail line (scaled, empty
 * lines dropped).
 */
export function scaleSteps(doc: RecipeDoc, factor: number): ScaledStep[] {
  const base = doc.serving_count
  const target = base * factor
  return doc.instructions.map((step) => ({
    primary: step.primary_message,
    concurrent: step.primary_message.trim().toLowerCase().startsWith('meanwhile'),
    details: (step.secondary_message ?? '')
      .split('\n')
      .map((line) => scaleStepLine(line, base, target, factor))
      .filter((line) => line.trim().length > 0),
  }))
}
