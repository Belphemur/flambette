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
  parseQuantity,
} from './quantity'
import { formatContainerQuantity, parseContainerQuantity } from './containers'

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
