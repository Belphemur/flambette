import { parseQuantity, formatAmount } from './quantity'
import { bucketFor, type StoreSection } from './sections'
import type { RecipeDoc } from './types'

export interface GroceryLine {
  /** Stable key for the checkbox state: `<normalized name>||<display>` */
  key: string
  /** Formatted amount + unit, or the verbatim unparseable quantity. */
  display: string
}

export interface GroceryItem {
  /** Normalized (lowercase, trimmed) ingredient name. */
  normalized: string
  /** Display name as first seen. */
  name: string
  section: StoreSection
  /** One line per unit of measure (distinct units stay separate). */
  lines: GroceryLine[]
}

interface Group {
  name: string
  /** unit -> summed amount */
  byUnit: Map<string, number>
  /** verbatim quantities that didn't parse (deduped) */
  raw: Set<string>
}

export interface AggregateInput {
  doc: RecipeDoc
  /** planServingsForMeal / recipe.serving_count */
  factor: number
}

/**
 * Aggregate line items across all planned recipes (grocery spec v1):
 * - scale parseable quantities by each meal's serving factor
 * - group by normalized ingredient name (no stemming/plural-merging)
 * - sum amounts sharing the same unit; distinct units stay separate lines
 * - pass unparseable quantities through verbatim
 */
export function aggregateGroceries(inputs: AggregateInput[]): GroceryItem[] {
  const groups = new Map<string, Group>()

  for (const { doc, factor } of inputs) {
    for (const item of doc.line_items) {
      const normalized = item.ingredient_name.trim().toLowerCase()
      if (!normalized) continue
      let group = groups.get(normalized)
      if (!group) {
        group = { name: item.ingredient_name.trim(), byUnit: new Map(), raw: new Set() }
        groups.set(normalized, group)
      }
      const parsed = parseQuantity(item.quantity)
      if (parsed) {
        const current = group.byUnit.get(parsed.unit) ?? 0
        group.byUnit.set(parsed.unit, current + parsed.amount * factor)
      } else {
        // Unparseable or empty quantity — pass through verbatim (may be '').
        group.raw.add(item.quantity.trim())
      }
    }
  }

  const items: GroceryItem[] = []
  for (const [normalized, group] of groups) {
    const lines: GroceryLine[] = []
    for (const [unit, amount] of group.byUnit) {
      const display = unit ? `${formatAmount(amount)} ${unit}` : formatAmount(amount)
      lines.push({ key: `${normalized}||${display}`, display })
    }
    // Sort summed lines numerically for stable, readable output.
    lines.sort((a, b) => {
      const na = parseQuantity(a.display)?.amount ?? 0
      const nb = parseQuantity(b.display)?.amount ?? 0
      return na - nb
    })
    for (const raw of group.raw) {
      lines.push({ key: `${normalized}||raw||${raw}`, display: raw })
    }
    items.push({ normalized, name: group.name, section: bucketFor(group.name), lines })
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}
