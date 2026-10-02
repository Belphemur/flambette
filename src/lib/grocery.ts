import {
  containerContribution,
  containerKey,
  formatContainerQuantity,
  parseContainerQuantity,
} from './containers'
import { parseQuantity, formatAmount } from './quantity'
import { isSeasoning, scaleQuantity } from './recipe'
import { bucketFor, type StoreSection } from './sections'
import type { RecipeDoc } from './types'

export interface GroceryLine {
  /** Stable key for the checkbox state: `<normalized name>||<display>` */
  key: string
  /**
   * Formatted amount + unit, or the verbatim unparseable quantity.
   *
   * CANONICAL: this is the key basis and stays metric forever (ADR-0047).
   * Never localize it — the localized rendering is `text` on
   * `GroceryLineView`, so flipping the unit system cannot orphan a checked
   * item.
   */
  display: string
}

/**
 * A line plus its display text for THIS device's unit system (ADR-0047).
 * Two fields on purpose: `display` is the identity and the key basis,
 * `text` is what the screen shows.
 */
export interface GroceryLineView extends GroceryLine {
  /** `display` converted for display; identical to `display` in metric. */
  text: string
}

export interface GroceryItemView extends Omit<GroceryItem, 'lines'> {
  lines: GroceryLineView[]
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

/** Sum of container-unit contributions for one (container, annotation). */
interface ContainerSum {
  /** First-seen container phrase, used for display (`small bunch`). */
  container: string
  annotation: string
  /** Sum of per-recipe container contributions. */
  amount: number
  /** How many planned meals contributed. */
  contributions: number
  /**
   * Verbatim authored quantity when a single meal at its own serving count
   * is the only contributor — keeps `½ (142 g) pkg` authentic.
   */
  verbatim?: string
}

interface Group {
  name: string
  /** normalized unit -> summed amount */
  byUnit: Map<string, UnitSum>
  /** container merge key -> ceil-merged container total (ADR-0017) */
  containers: Map<string, ContainerSum>
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
 * - container units (`½ (142 g) pkg`, `1 small bunch`) are purchasable, not
 *   divisible: they skip linear scaling and ceil-merge per container +
 *   annotation (ADR-0017)
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
        group = {
          name: item.ingredient_name.trim(),
          byUnit: new Map(),
          containers: new Map(),
          raw: new Set(),
          recipes: new Set(),
        }
        groups.set(normalized, group)
      }
      group.recipes.add(recipeName)
      // ADR-0017: container units are bought whole — aggregate them before
      // the linear path so a serving bump rounds UP to a purchasable
      // container instead of inventing 1.7 packages.
      const container = parseContainerQuantity(item.quantity)
      if (container) {
        const key = containerKey(container.container, container.annotation)
        const contribution = containerContribution(container.count, factor)
        const current = group.containers.get(key)
        if (current) {
          current.amount += contribution
          current.contributions += 1
          // A second contributor (or a scaled single one) drops verbatim text.
          current.verbatim = undefined
        } else {
          group.containers.set(key, {
            container: container.container,
            annotation: container.annotation,
            amount: contribution,
            contributions: 1,
            verbatim: contribution === container.count ? container.raw : undefined,
          })
        }
        continue
      }
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
    for (const { container, annotation, amount, verbatim } of group.containers.values()) {
      // A single meal at its authored servings keeps the recipe's own text
      // (`½ (142 g) pkg`); every other case renders the merged count, whole
      // (`1 (142 g) pkg`, `2 (142 g) pkgs`) or fractional (`3/2 small bunch`).
      const display = verbatim ?? formatContainerQuantity(amount, container, annotation)
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
