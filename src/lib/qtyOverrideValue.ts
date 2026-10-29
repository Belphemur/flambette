/**
 * The quantity-override value grammar (ADR-0100).
 *
 * The override amount is authored by the shopper in the LINE's own unit
 * grammar and travels as a display string. ADR-0037's clamp-once rule
 * governs it: every commit normalizes through the shared quantity
 * parser ONCE — the normalized string is what the store holds AND what
 * the render localizes; display never re-parses or re-clamps.
 *
 * One display vocabulary: the canonical spelling mirrors the grocery
 * aggregation's own format stack (`quantity.ts`) — containers through
 * `formatContainerQuantity`, amounts through `formatMetricAmount` — so
 * an overridden badge reads exactly like a derived one.
 */

import {
  formatMetricAmount,
  OZ_GRAMS,
  parseQuantity,
} from './quantity'
import { formatContainerQuantity, parseContainerQuantity } from './containers'
import {
  CENTIMETRES_PER_INCH,
  KILOGRAMS_PER_POUND,
  MILLILITRES_PER_FLUID_OUNCE,
} from './units'

/** Absolute floor/max for a committed amount (steppers and typed values). */
export const MIN_QTY_OVERRIDE = 0.25
export const MAX_QTY_OVERRIDE = 9999

/**
 * Clamp ONE raw editor draft into the canonical store spelling.
 *
 * - container phrase (`½ (142 g) pkg`) → `formatContainerQuantity`
 * - parseable amount+unit (`3 cups`, `67.5 ml`) → the aggregation
 *   display stack, amount floored/capped
 * - a BARE amount (`3`, `1/2`) inherits the LINE's own unit (`fallbackUnit`)
 *   — the override is authored in the line's grammar (ADR-0100), and a
 *   shopper stepping "3 cloves" to "4" means four cloves, not a unitless 4
 * - anything else (`a pinch`, `to taste`) → trimmed verbatim prose —
 *   there is no grammar to clamp, and dropping the shopper's text would
 *   be a lie.
 *
 * Empty input is NOT a value: the caller treats '' as "drop the
 * override" (the editor's empty Done/commit).
 */
export function normalizeQtyOverrideAmount(raw: string, fallbackUnit = ''): string {
  const s = raw.trim()
  if (!s) return ''
  const container = parseContainerQuantity(s)
  if (container) {
    const count = clampAmount(container.count)
    return formatContainerQuantity(count, container.container, container.annotation)
  }
  // A leading minus has no quantity meaning here: sign it onto the parse
  // result so `−2 cups` clamps to the floor instead of dropping the minus
  // and pretending the shopper asked for +2.
  const negative = s.startsWith('-')
  const candidate = negative ? s.slice(1).trim() : s
  const parsed = parseQuantity(candidate)
  if (parsed) {
    const unit = parsed.unit || fallbackUnit.trim()
    const amount = clampAmount(negative ? -parsed.amount : parsed.amount)
    const body = formatMetricAmount(amount, unit)
    return unit ? `${body} ${unit}` : body
  }
  // Prose: keep the shopper's words verbatim (trimmed, length-capped by
  // the store's own funnel).
  return s
}

function clampAmount(amount: number): number {
  if (!Number.isFinite(amount)) return MIN_QTY_OVERRIDE
  return Math.min(MAX_QTY_OVERRIDE, Math.max(MIN_QTY_OVERRIDE, amount))
}

/**
 * Grams per unit / millilitres per unit for the imperial-native units an
 * imperial-localized draft can carry (the mirror of units.ts's ONE-WAY
 * metric→imperial audience table). The step-back direction — an edited
 * local display value converted back into the line's canonical metric
 * unit before the store write, ADR-0100's round-trip rule.
 */
const IMPERIAL_TO_METRIC: ReadonlyMap<string, readonly [number, string]> = new Map([
  ['lb', [1000 * KILOGRAMS_PER_POUND, 'g']],
  ['lbs', [1000 * KILOGRAMS_PER_POUND, 'g']],
  ['oz', [OZ_GRAMS, 'g']],
  ['ounce', [OZ_GRAMS, 'g']],
  ['ounces', [OZ_GRAMS, 'g']],
  ['fl oz', [MILLILITRES_PER_FLUID_OUNCE, 'ml']],
  ['inch', [CENTIMETRES_PER_INCH, 'cm']],
  ['inches', [CENTIMETRES_PER_INCH, 'cm']],
])

/**
 * Convert one normalized DISPLAY value into the LINE's canonical unit
 * (ADR-0100 round-trip rule, 2026-10-28 review): the shopper edits in
 * the localized display grammar (`4.8 lb` on an imperial device, or a
 * bare amount that inherited the line's localized unit), but the STORE
 * value must stay in the canonical metric grammar all systems agree on —
 * a metric household member can never be handed a raw `4.8 lb`.
 *
 * - a unit that is not imperial-native (counts, cups, tbsp, prose) is
 *   the identity — the catalog authors it the same in every system
 * - a bare amount (no unit) cannot be converted — with no unit and no
 *   conversion target, the canonical unit IS inherited by the caller
 *   passing the display fallback; nothing to do here
 * - the canonical unit must be the metric side of the pair (`g`/`kg`/`ml`) —
 *   a `dual` system's canonical display is already the store value
 * - the converted amount re-normalizes through the SAME adjacent scaling
 *   stack (`formatMetricAmount`), so a stored override reads exactly
 *   like a derived one on every system
 */
export function canonicalQtyOverrideAmount(value: string, canonicalUnit = ''): string {
  const s = value.trim()
  if (!s) return ''
  const canonical = canonicalUnit.trim()
  const parsed = parseQuantity(s)
  if (!parsed || !parsed.unit.trim()) return s
  const conv = IMPERIAL_TO_METRIC.get(localUnitKey(parsed.unit))
  if (!conv) return s
  const [perUnit, metricUnit] = conv
  // Only convert WHEN the line's canonical unit is the metric side of
  // the pair (g/kg for weights, ml for volumes, cm for lengths) — a
  // canonical unit outside the pair is system-invariant and the value
  // already travels correctly.
  if (canonical !== metricUnit && !(metricUnit === 'g' && canonical === 'kg')) return s
  const metricAmount = parsed.amount * perUnit
  const amount = metricUnit === 'g' && canonical === 'kg' ? metricAmount / 1000 : metricAmount
  return `${formatMetricAmount(amount, canonical)} ${canonical}`
}

/** Case-folded unit-key comparison without a trailing period. */
function localUnitKey(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.endsWith('.') && u.length > 1) return u.slice(0, -1)
  return u
}

/**
 * One stepper step over the current draft's leading amount. The step is
 * chosen by the UNIT CLASS (a weight needs a coarser pace than a count):
 * 10 g / 10 ml / 0.05 kg-style volume-weight steps, 1 of everything
 * else. A draft with no parseable amount steps nowhere (prose is not a
 * number) and re-normalizes without change.
 */
export function stepQtyOverrideAmount(raw: string, direction: 1 | -1, fallbackUnit = ''): string {
  const parsed = parseQuantity(raw.trim())
  if (!parsed) return normalizeQtyOverrideAmount(raw, fallbackUnit)
  const key = parsed.unit.trim().toLowerCase()
  const step = key === 'g' || key === 'ml' ? 10 : key === 'kg' ? 0.1 : 1
  const unit = parsed.unit || fallbackUnit.trim()
  const next = `${clampAmount(parsed.amount + direction * step)}${unit ? ` ${unit}` : ''}`
  return normalizeQtyOverrideAmount(next, fallbackUnit)
}
