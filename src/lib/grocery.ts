import {
  containerContribution,
  containerKey,
  formatContainerQuantity,
  parseContainerQuantity,
} from './containers'
import { parseQuantity, formatAmount, formatMetricAmount, quantizeSpoons, scaleMetricAmount } from './quantity'
import { isSeasoning, scaleQuantity } from './recipe'
import { bucketFor, type StoreSection } from './sections'
import type { RecipeDoc } from './types'

export interface GroceryLine {
  /** Stable key for the checkbox state: `<normalized name>||<key basis>` */
  key: string
  /**
   * Formatted amount + unit, or the verbatim unparseable quantity.
   *
   * CANONICAL: stays metric forever (ADR-0047). Never localize it — the
   * localized rendering is `text` on `GroceryLineView`, so flipping the
   * unit system cannot orphan a checked item.
   */
  display: string
}

/**
 * The checkbox key's amount spelling: `formatAmount`'s decimal form — the
 * exact spelling every persisted `checked` key used before ADR-0055's
 * glyph rendering (`67.5 ml`, never `67 ½ ml`). The key basis and the
 * display are TWO spellings of the same amount on purpose: re-spelling
 * the key would silently uncheck every fractional line on upgrade.
 */
function lineKeyBasis(amount: number, unit: string): string {
  return unit ? `${formatAmount(amount)} ${unit}` : formatAmount(amount)
}

/**
 * A line plus its display text for THIS device's unit system (ADR-0047).
 * Two fields on purpose: `display` is the canonical metric rendering,
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
  /**
   * The KEY spelling's parallel sum: the accumulation of every row's
   * KEY quantity (the base doc's when the restriction seam supplied one).
   * Equal to `amount` unless a re-authored overlay amount diverged — the
   * checkbox key spells THIS, never the display sum.
   */
  keyAmount: number
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
  /** The KEY spelling's parallel sum/verbatim — see UnitSum.keyAmount. */
  keyAmount: number
  keyContributions: number
  keyVerbatim?: string
}

interface Group {
  name: string
  /**
   * Every contributing display name. When they DIVERGE (different
   * substitutes for one base ingredient), the item's label names them all
   * instead of whichever arrived first.
   */
  names: Set<string>
  /** normalized unit -> summed amount */
  byUnit: Map<string, UnitSum>
  /** container merge key -> ceil-merged container total (ADR-0017) */
  containers: Map<string, ContainerSum>
  /**
   * Verbatim quantities that didn't parse, deduped by DISPLAY spelling —
   * each entry carries its own KEY spelling (the base doc's quantity when
   * the restriction seam re-authored it), which is what the checkbox key
   * is built from, never the display spelling.
   */
  raw: Map<string, string>
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
  /**
   * The restriction's display rows (the restriction ADR): when present, the
   * grocery displays THESE instead of `doc.line_items` — each row's (name,
   * quantity) pair co-occurs in ONE authoritative doc (the overlay, or the
   * base where the overlay has no counterpart), so a display row is never a
   * cross-pair of base quantity + overlay name. The group key stays the
   * row's `keyName` — a BASE doc nameKey wherever a base counterpart was
   * found — so a restriction toggle can never re-key checked state.
   * Omitted renders the base doc as-is.
   */
  displayLines?: RestrictedDisplayLine[]
}

/**
 * One grocery display row (the restriction seam). `keyName` is already a
 * `nameKey` — the aggregation key and the checked-key's name half. `name`
 * and `quantity` come from the SAME source doc.
 *
 * `keyQuantity` carries the paired BASE line's quantity, present ONLY when
 * upstream's rework re-authored the amount (the display quantity is the
 * overlay's). The checkbox key's amount spelling derives from THIS — the
 * base doc — so toggling the restriction re-renders the base quantity under
 * the SAME key and a checked line survives the toggle. Absent (the common
 * case): the key spelling follows `quantity`, exactly as the base render
 * would spell it.
 */
export interface RestrictedDisplayLine {
  keyName: string
  name: string
  quantity: string
  keyQuantity?: string
  /**
   * The paired BASE line's ingredient name, present whenever the row HAS a
   * base counterpart. The key side's seasoning classification (the
   * sub-linear rule) runs on THIS, never the display name: the base render
   * classifies by the base ingredient, and a substitute that crosses the
   * seasoning verdict must not re-classify the base spelling.
   */
  keyIngredient?: string
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

  for (const { doc, factor, recipeName, cleared, displayLines } of inputs) {
    // ADR-0009: seasonings scale sub-linearly against the recipe's own
    // authored serving count, so keep base/target, not just the ratio.
    const base = doc.serving_count
    const target = base * factor
    // The rows the grocery displays: the restriction's display rows when the
    // overlay is active for this doc, else the base doc's own lines. Either
    // way a row's (name, quantity) pair co-occurs in ONE authoritative doc.
    const rows: readonly RestrictedDisplayLine[] = displayLines ??
      doc.line_items.map((li) => ({
        keyName: nameKey(li.ingredient_name),
        name: li.ingredient_name,
        quantity: li.quantity,
      }))
    for (const row of rows) {
      const normalized = row.keyName
      if (!normalized) continue
      // Hidden for this meal (cleared from the grocery list) — skipped
      // entirely, other meals' contributions are aggregated separately.
      if (cleared?.has(normalized)) continue
      let group = groups.get(normalized)
      if (!group) {
        group = {
          name: row.name.trim(),
          names: new Set([row.name.trim()]),
          byUnit: new Map(),
          containers: new Map(),
          raw: new Map(),
          recipes: new Set(),
        }
        groups.set(normalized, group)
      }
      group.recipes.add(recipeName)
      // Every contributing display name is kept: two planned meals whose
      // base ingredient is the same but whose SUBSTITUTES differ (or one
      // restricted meal plus one unrestricted one) would otherwise label
      // the whole merged group with whichever name arrived first.
      group.names.add(row.name.trim())
      // The KEY spelling's own parse: the paired BASE quantity when the
      // restriction seam re-authored the display amount, else the same
      // string — so absent keyQuantity the two accumulations are identical
      // and every key is byte-identical to the pre-restriction render.
      const keySource = row.keyQuantity ?? row.quantity
      const keyContainer = parseContainerQuantity(keySource)
      // ADR-0017: container units are bought whole — aggregate them before
      // the linear path so a serving bump rounds UP to a purchasable
      // container instead of inventing 1.7 packages.
      const container = parseContainerQuantity(row.quantity)
      if (container) {
        const key = containerKey(container.container, container.annotation)
        const contribution = containerContribution(container.count, factor)
        // The key side accumulates the BASE container when it is the same
        // (container, annotation) — measured: every re-authored container
        // amount keeps the upstream annotation — else it follows display.
        const keyCount = keyContainer && containerKey(keyContainer.container, keyContainer.annotation) === key
          ? keyContainer.count
          : container.count
        const keyRaw = keyContainer && containerKey(keyContainer.container, keyContainer.annotation) === key
          ? keyContainer.raw
          : container.raw
        const keyContribution = containerContribution(keyCount, factor)
        const current = group.containers.get(key)
        if (current) {
          current.amount += contribution
          current.contributions += 1
          // A second contributor (or a scaled single one) drops verbatim text.
          current.verbatim = undefined
          current.keyAmount += keyContribution
          current.keyContributions += 1
          current.keyVerbatim = undefined
        } else {
          group.containers.set(key, {
            container: container.container,
            annotation: container.annotation,
            amount: contribution,
            contributions: 1,
            verbatim: contribution === container.count ? container.raw : undefined,
            keyAmount: keyContribution,
            keyContributions: 1,
            keyVerbatim: keyContribution === keyCount ? keyRaw : undefined,
          })
        }
        continue
      }
      const parsed = parseQuantity(row.quantity)
      if (parsed) {
        const key = unitKey(parsed.unit)
        const keyParsed = keyContainer ? null : parseQuantity(keySource)
        // ADR-0054: non-seasonings scale through the QUANTIZED grammar
        // (`scaleMetricAmount` — the same vocabulary recipe detail uses), so
        // the grocery sum and the recipe-detail chip can never disagree:
        // `2129 ml ×⅔` renders `1420 ml` on BOTH surfaces. Summing two
        // ½-quanta yields integers, so the aggregate keeps the vocabulary;
        // seasonings keep `recipe.scaleQuantity`'s sub-linear rule.
        const scaled = isSeasoning(row.name)
          ? // ADR-0055: the sub-linear intermediate joins the same spoon
            // vocabulary as everywhere else — upstream never authors a
            // decimal spoon (`2.523 tsp` reads `2 ½ tsp`).
            quantizeSpoons(
              scaleQuantity(parsed.amount, base, target, true, row.name),
              parsed.unit,
            )
          : scaleMetricAmount(parsed.amount, factor, parsed.unit)
        // The key side runs the SAME scale rule on the key source's amount,
        // classified by the KEY ingredient (the base doc's name — a
        // substitute that crosses the seasoning verdict must not
        // re-classify the base spelling). A key source that parses to a
        // DIFFERENT unit follows the display unit (the parallel sums live
        // under the display line's unit key).
        const keyIngredient = row.keyIngredient ?? row.name
        const keyScaled = keyParsed && unitKey(keyParsed.unit) === key
          ? isSeasoning(keyIngredient)
            ? quantizeSpoons(
                scaleQuantity(keyParsed.amount, base, target, true, keyIngredient),
                keyParsed.unit,
              )
            : scaleMetricAmount(keyParsed.amount, factor, keyParsed.unit)
          : scaled
        const current = group.byUnit.get(key)
        if (current) {
          current.amount += scaled
          current.keyAmount += keyScaled
        } else group.byUnit.set(key, { unit: parsed.unit, amount: scaled, keyAmount: keyScaled })
      } else {
        // Unparseable or empty quantity — verbatim DISPLAY. The KEY
        // spelling follows the key source (the base doc's quantity when
        // the seam re-authored it), never the display spelling: when the
        // key source PARSES, the base render keyed this line under the
        // parsed grammar — so this spells the scaled parsed basis — and
        // only a key source that cannot parse either falls back to the
        // `raw||` namespace.
        const display = row.quantity.trim()
        if (!group.raw.has(display)) {
          const kp = keyContainer ? null : parseQuantity(keySource)
          if (kp) {
            const keyIngredient = row.keyIngredient ?? row.name
            const keyScaled = isSeasoning(keyIngredient)
              ? quantizeSpoons(scaleQuantity(kp.amount, base, target, true, keyIngredient), kp.unit)
              : scaleMetricAmount(kp.amount, factor, kp.unit)
            group.raw.set(display, lineKeyBasis(keyScaled, kp.unit))
          } else {
            group.raw.set(display, `raw||${(row.keyQuantity ?? row.quantity).trim()}`)
          }
        }
      }
    }
  }

  const items: GroceryItem[] = []
  for (const [normalized, group] of groups) {
    const lines: GroceryLine[] = []
    for (const { unit, amount, keyAmount } of group.byUnit.values()) {
      // ADR-0057: unit-aware rendering — integer ml/g, fraction glyphs.
      const display = unit
        ? `${formatMetricAmount(amount, unit)} ${unit}`
        : formatMetricAmount(amount, '')
      // The KEY stays on formatAmount's decimal spelling — the spelling
      // every persisted `checked` key already uses — so the glyph render
      // never re-keys a fractional line (`67.5 ml` vs `67 ½ ml`). The
      // spelling is the KEY sum's (the base doc's when the restriction seam
      // re-authored the amount), never the display sum's.
      lines.push({ key: `${normalized}||${lineKeyBasis(keyAmount, unit)}`, display })
    }
    for (const {
      container,
      annotation,
      amount,
      verbatim,
      keyAmount,
      keyVerbatim,
    } of group.containers.values()) {
      // A single meal at its authored servings keeps the recipe's own text
      // (`½ (142 g) pkg`); every other case renders the merged count, whole
      // (`1 (142 g) pkg`, `2 (142 g) pkgs`) or fractional (`3/2 small bunch`).
      const display = verbatim ?? formatContainerQuantity(amount, container, annotation)
      const keyBasis = keyVerbatim ?? formatContainerQuantity(keyAmount, container, annotation)
      lines.push({ key: `${normalized}||${keyBasis}`, display })
    }
    // Sort summed lines numerically for stable, readable output.
    lines.sort((a, b) => {
      const na = parseQuantity(a.display)?.amount ?? 0
      const nb = parseQuantity(b.display)?.amount ?? 0
      return na - nb
    })
    for (const [raw, keyBasis] of group.raw) {
      lines.push({ key: `${normalized}||${keyBasis}`, display: raw })
    }
    // Line keys stay unique (the checked map IS keyed by them): a
    // raw-display row whose key source PARSES keys under the parsed
    // grammar, and another contributor may already have emitted that same
    // basis as a real by-unit line. The parsed line is pushed FIRST and
    // carries a real display, so the colliding raw line — whose display is
    // typically the overlay's blanked quantity — is dropped.
    const seenKeys = new Set<string>()
    const unique = lines.filter((l) => {
      if (seenKeys.has(l.key)) return false
      seenKeys.add(l.key)
      return true
    })
    lines.length = 0
    lines.push(...unique)
    // When the group's display names DIVERGE (different substitutes for the
    // same base ingredient, or a restricted meal plus an unrestricted one),
    // the label names them ALL — a first-seen-only label would silently
    // claim the whole summed quantity for one substitute. The quantity sums
    // stay merged (splitting by name would re-key checked state on
    // toggle); the section still buckets on the first-seen name.
    const name = group.names.size > 1 ? [...group.names].join(' / ') : group.name
    items.push({
      normalized,
      name,
      section: bucketFor(group.name),
      recipes: [...group.recipes],
      lines,
    })
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}
