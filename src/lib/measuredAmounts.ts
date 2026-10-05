/**
 * Measured amounts under the cooking step text (ADR-0022).
 *
 * The step text is authored prose: "juice of ¾ lemon", "zest and juice
 * from 1 ½ lemon", "about 3 tbsp extra virgin olive oil". When the
 * step's own quantity cannot be parsed as a leading amount, the MEASURED
 * quantity lives in `doc.line_items` (e.g. `3 lemons`) — that is the
 * "it just says *a potato*" fix, surfaced as a subdued chip instead of
 * invented prose.
 *
 * Hard rules:
 * - NEVER invent a quantity. A detail line with no parseable quantity
 *   prefix and no matching line item simply shows nothing.
 * - Container units take ADR-0017's path (ceil-merged, not divided);
 *   spoon/count units keep ADR-0009's linear (seasoning-aware) scaling.
 *   Both are imported, never re-implemented here.
 */

import { containerContribution, formatContainerQuantity, parseContainerQuantity } from './containers'
import { nameKey } from './grocery'
import { formatMetricAmount, parseQuantity } from './quantity'
import { isSeasoning, scaleQuantity } from './recipe'
import { localizeQuantity, type UnitSystem } from './units'
import type { LineItem, RecipeDoc } from './types'

export interface MeasuredChip {
  /** Index of the step's detail line this chip belongs to. */
  lineIndex: number
  /** `measured: 3 lemons` */
  label: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `name` is mentioned in `line` at a word boundary, compared
 * through `nameKey` so "lemon"/"lemons" and "tomato"/"tomatoes" match.
 *
 * The pattern is plural-tolerant on BOTH sides (qodo phase 18):
 * nameKey singularizes the ingredient name, but the authored step line
 * may still carry the plural — "juice of 2 lemons" must match a line
 * item named "lemon" (key `lemon`, pattern `\blemon(?:e?s)?\b`). The
 * optional `(?:e?s)?` never widens the match past a word boundary, so
 * "chick" still does not match "chicken".
 */
export function mentionsIngredient(line: string, name: string): boolean {
  const key = nameKey(name)
  if (key.length < 2) return false
  return new RegExp(`\\b${escapeRegExp(key)}(?:e?s)?\\b`, 'i').test(line)
}

/**
 * A detail line is "imprecise" when it does NOT start with a parseable
 * amount — "juice of ¾ lemon" (a real measurement, just not a leading
 * one, is still precise enough to read on its own) versus
 * "zest and juice from 1 ½ lemon" (the number is not the quantity).
 */
function isImpreciseLine(line: string): boolean {
  return parseQuantity(line) === null
}

/** The head noun of an ingredient name ("russet potato" → "potato"). */
function headNoun(name: string): string {
  const key = nameKey(name)
  const parts = key.split(/\s+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

/**
 * The line items a detail line refers to, deduplicated by ingredient.
 * Full name matches win; a head noun ("a potato" → "russet potato") is
 * only accepted when UNAMBIGUOUS — otherwise we would attribute a number
 * to the wrong ingredient.
 */
export function matchLineItems(line: string, items: LineItem[]): LineItem[] {
  const usable = items.filter((i) => i.quantity.trim() && parseQuantity(i.quantity))
  const dedupe = (list: LineItem[]) => {
    const seen = new Map<string, LineItem>()
    for (const item of list) seen.set(nameKey(item.ingredient_name), item)
    return [...seen.values()]
  }
  const exact = usable.filter((i) => mentionsIngredient(line, i.ingredient_name))
  if (exact.length > 0) return dedupe(exact)
  // Head-noun fallback, only when exactly ONE line item carries it.
  const byHead = new Map<string, LineItem | null>()
  for (const item of usable) {
    const head = headNoun(item.ingredient_name)
    if (head.length < 3 || !mentionsIngredient(line, head)) continue
    byHead.set(head, byHead.has(head) ? null : item)
  }
  return [...byHead.values()].filter((i): i is LineItem => i !== null)
}

/**
 * A line item's measured quantity at the current servings factor. At the
 * authored servings the AUTHORED text is kept verbatim (ADR-0017); above
 * it, container units are ceil-merged and other units scale linearly
 * (seasoning-aware, ADR-0009).
 */
export function measuredQuantity(item: LineItem, factor: number, base: number): string | null {
  const container = parseContainerQuantity(item.quantity)
  if (container) {
    if (factor === 1) return item.quantity.trim()
    return formatContainerQuantity(
      containerContribution(container.count, factor),
      container.container,
      container.annotation,
    )
  }
  const parsed = parseQuantity(item.quantity)
  if (!parsed) return null
  if (factor === 1) return item.quantity.trim()
  const scaled = scaleQuantity(
    parsed.amount,
    base,
    base * factor,
    isSeasoning(item.ingredient_name),
    item.ingredient_name,
  )
  // ADR-0054: unit-aware rendering — integer ml/g, fraction glyphs.
  const rendered = formatMetricAmount(scaled, parsed.unit)
  return parsed.unit ? `${rendered} ${parsed.unit}` : rendered
}

/**
 * Chips for one step view: every imprecise detail line that names an
 * ingredient with a measured line item. Detail lines keep their order,
 * and a line naming TWO imprecise ingredients yields two chips.
 *
 * `system` (ADR-0047) localizes the chip's quantity for DISPLAY only — the
 * quantity itself is derived from `doc.line_items`, which stays canonical
 * metric. `dual` (the default) keeps the transform the identity.
 */
export function measuredChipsForLines(
  doc: RecipeDoc,
  detailLines: readonly string[],
  factor: number,
  system: UnitSystem = 'dual',
): MeasuredChip[] {
  const items = doc.line_items ?? []
  if (items.length === 0) return []
  const chips: MeasuredChip[] = []
  detailLines.forEach((line, lineIndex) => {
    const text = line.trim()
    if (!text || !isImpreciseLine(text)) return
    for (const item of matchLineItems(text, items)) {
      const quantity = measuredQuantity(item, factor, doc.serving_count)
      if (!quantity) continue
      chips.push({
        lineIndex,
        label: `measured: ${localizeQuantity(quantity, system)} ${item.ingredient_name.trim()}`,
      })
    }
  })
  return chips
}
