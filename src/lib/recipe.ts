import { humanizeAmount, parseQuantity } from './quantity'
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

/** Substrings that veto a seasoning match ("red bell pepper" etc.). */
const SEASONING_EXCLUSIONS = ['bell']

/** True when `text` (an ingredient name or a step-detail line) is a seasoning. */
export function isSeasoning(text: string): boolean {
  const s = text.toLowerCase()
  if (SEASONING_EXCLUSIONS.some((x) => s.includes(x))) return false
  for (const kw of seasoningNames) {
    if (s.includes(kw)) return true
  }
  return false
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
  const amount = scaleQuantity(parsed.amount, base, target, isSeasoning(line), line)
  // The scaled line goes to a HUMAN: counts round half-down to whole pieces
  // (2.25 eggs -> "2"), everything else keeps formatAmount's grain. The
  // rounding must not crawl back into the math: scaleQuantity stays exact
  // because measured-amount chips and the grocery merge read its numbers.
  const rendered = humanizeAmount(amount, parsed.unit)
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
