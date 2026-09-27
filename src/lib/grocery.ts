import { parseQuantity, formatAmount } from './quantity'
import { isSeasoning, scaleQuantity } from './recipe'
import { bucketFor, type StoreSection } from './sections'
import type { RecipeDoc } from './types'

export interface GroceryLine {
  /** Stable key for the checkbox state: `<normalized name>||<display>` */
  key: string
  /** Formatted amount + unit, or the verbatim unparseable quantity. */
  display: string
}

export interface GroceryItem {
  /** Singularized, lowercased merge key for the ingredient name. */
  normalized: string
  /** Display name as first seen. */
  name: string
  section: StoreSection
  /** Names of the planned meals that use this ingredient (insertion order). */
  recipes: string[]
  /** One line per unit of measure (distinct units stay separate). */
  lines: GroceryLine[]
}

/**
 * Collapse unit spellings that denote the same measure so "2 cloves" and
 * "1 clove" merge: lowercase + naive singularization (strip trailing 'es'/'s').
 * "cups"→"cup", "bunches"→"bunch", "pkgs"→"pkg"; short units ("g", "ml") and
 * already-singular forms are untouched.
 */
function unitKey(unit: string): string {
  const u = unit.trim().toLowerCase()
  if (u.length > 3 && u.endsWith('es')) return u.slice(0, -2)
  if (u.length > 2 && u.endsWith('s')) return u.slice(0, -1)
  return u
}

/**
 * Same idea for ingredient NAMES, so "carrot" and "carrots" group together.
 * Handles English plural classes verified in the catalog data:
 * -oes (potatoes→potato), -ses/-xes/-zes/-ches/-shes (bunches→bunch), plain -s
 * (carrots→carrot). Merge key only — display keeps the first-seen spelling.
 */
export function nameKey(name: string): string {
  const s = name.trim().toLowerCase()
  if (s.length > 3 && s.endsWith('oes')) return s.slice(0, -2)
  if (
    s.length > 4 &&
    (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes') || s.endsWith('ches') || s.endsWith('shes'))
  ) {
    return s.slice(0, -2)
  }
  if (s.length > 3 && s.endsWith('s')) return s.slice(0, -1)
  return s
}

interface UnitSum {
  /** First-seen unit spelling, used for display. */
  unit: string
  amount: number
}

interface Group {
  name: string
  /** normalized unit -> summed amount */
  byUnit: Map<string, UnitSum>
  /** verbatim quantities that didn't parse (deduped) */
  raw: Set<string>
  /** planned meal names using this ingredient */
  recipes: Set<string>
}

export interface AggregateInput {
  doc: RecipeDoc
  /** planServingsForMeal / recipe.serving_count */
  factor: number
  /** Display name of the planned meal (for provenance). */
  recipeName: string
  /** nameKey-normalized ingredient keys hidden for THIS meal only. */
  cleared?: Set<string>
}

/**
 * Aggregate line items across all planned recipes (grocery spec v2):
 * - scale parseable quantities by each meal's serving factor — linearly
 *   for ingredients, sub-linearly + capped for seasonings (ADR-0009)
 * - group by normalized ingredient name (no stemming/plural-merging of names)
 * - normalize units before summing ("2 cloves" + "1 clove" → "3 cloves");
 *   amounts with genuinely different units stay separate lines
 * - pass unparseable quantities through verbatim
 * - track which planned meals use each ingredient
 * - skip ingredients cleared per meal (cleared set): an ingredient cleared
 *   by one meal still appears if another planned meal uses it
 */
export function aggregateGroceries(inputs: AggregateInput[]): GroceryItem[] {
  const groups = new Map<string, Group>()

  for (const { doc, factor, recipeName, cleared } of inputs) {
    // ADR-0009: seasonings scale sub-linearly against the recipe's own
    // authored serving count, so keep base/target, not just the ratio.
    const base = doc.serving_count
    const target = base * factor
    for (const item of doc.line_items) {
      const normalized = nameKey(item.ingredient_name)
      if (!normalized) continue
      // Hidden for this meal (cleared from the grocery list) — skipped
      // entirely, other meals' contributions are aggregated separately.
      if (cleared?.has(normalized)) continue
      let group = groups.get(normalized)
      if (!group) {
        group = { name: item.ingredient_name.trim(), byUnit: new Map(), raw: new Set(), recipes: new Set() }
        groups.set(normalized, group)
      }
      group.recipes.add(recipeName)
      const parsed = parseQuantity(item.quantity)
      if (parsed) {
        const key = unitKey(parsed.unit)
        const scaled = scaleQuantity(
          parsed.amount,
          base,
          target,
          isSeasoning(item.ingredient_name),
          item.ingredient_name,
        )
        const current = group.byUnit.get(key)
        if (current) current.amount += scaled
        else group.byUnit.set(key, { unit: parsed.unit, amount: scaled })
      } else {
        // Unparseable or empty quantity — pass through verbatim (may be '').
        group.raw.add(item.quantity.trim())
      }
    }
  }

  const items: GroceryItem[] = []
  for (const [normalized, group] of groups) {
    const lines: GroceryLine[] = []
    for (const { unit, amount } of group.byUnit.values()) {
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
    items.push({
      normalized,
      name: group.name,
      section: bucketFor(group.name),
      recipes: [...group.recipes],
      lines,
    })
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}
