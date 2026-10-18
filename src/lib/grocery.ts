import {
  containerContribution,
  containerKey,
  formatContainerQuantity,
  parseContainerQuantity,
} from './containers'
import { parseQuantity, formatAmount, formatMetricAmount, unitKey } from './quantity'
import { scaleSeasoningAware } from './recipe'
import { bucketFor, type StoreSection } from './sections'
import type { RecipeDoc } from './types'
import type { ClearedIngredient } from '../stores/grocery'

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

/* ---------- ADR-0094: object-JSON cleared-ingredient storage ---------- */

/**
 * Merge-identity of one cleared entry (ADR-0094): the nameKey plus the
 * GRAMMAR BUCKET the entry claims — `row` for whole-ingredient clears,
 * the verbatim basis for raw rows, the container key for container lines,
 * the unit key for by-unit lines. Two entries with the same identity are
 * the same claim (the newest one wins on merge); entries with different
 * identities never collapse — which is exactly the discrimination the
 * old `nameKey||basis` string keys lost (`egg||4` and `egg||6 to taste`
 * both reducing to `egg||`).
 */
export function clearedEntryIdentity(entry: ClearedIngredient): string {
  const u = entry.unit
  switch (u.kind) {
    case 'byUnit':
      return `${entry.keyName}||u:${unitKey(u.unit)}`
    case 'container':
      return `${entry.keyName}||c:${containerKey(u.noun, u.annotation)}`
    case 'raw':
      return `${entry.keyName}||r:${u.basis}`
    case 'row':
      return `${entry.keyName}||row`
  }
}

/** The clear-time serving context stamped onto every migrated entry. */
export interface ClearedClearContext {
  /** Clear-time plan factor (entryServings / recipe.baseServings), when known. */
  factor: number
  /** Serving count the plan held at clear time. */
  servingsAtClear: number
}

/**
 * Classify one legacy cleared key (`nameKey||basis`, or a bare nameKey)
 * into the ADR-0094 object grammar. The basis is classified with the SAME
 * parsers the render uses, so a migrated entry claims the same bucket its
 * string key did:
 *
 * - bare nameKey -> `{ kind: 'row' }`, scope `ingredient` (the Clear-list
 *   whole-ingredient ledger);
 * - `nameKey||raw||<basis>` -> `{ kind: 'raw', basis }`, verbatim (raw
 *   rows never re-sum, so the basis IS the identity);
 * - a parseable container quantity -> `{ kind: 'container', ... }` with
 *   the clear-time count;
 * - any other parseable quantity -> `{ kind: 'byUnit', unit, amount }`;
 * - anything unparseable -> `{ kind: 'raw', basis }` with the basis
 *   preserved verbatim.
 *
 * Returns null for a key that cannot yield a nameKey (defensive: a
 * malformed `||...` string is dropped rather than stored as an
 * empty-named claim).
 */
export function clearedEntryFromKey(
  key: string,
  ctx: ClearedClearContext,
): ClearedIngredient | null {
  if (!key) return null
  const sep = key.indexOf('||')
  if (sep < 0) {
    return {
      keyName: key,
      unit: { kind: 'row' },
      factor: ctx.factor,
      servingsAtClear: ctx.servingsAtClear,
      scope: 'ingredient',
    }
  }
  const keyName = key.slice(0, sep)
  const basis = key.slice(sep + 2)
  if (!keyName) return null
  const scope: 'line' | 'ingredient' = 'line'
  if (basis.startsWith('raw||')) {
    return { keyName, unit: { kind: 'raw', basis: basis.slice('raw||'.length) }, factor: ctx.factor, servingsAtClear: ctx.servingsAtClear, scope }
  }
  const container = parseContainerQuantity(basis)
  if (container) {
    return {
      keyName,
      unit: { kind: 'container', noun: container.container, annotation: container.annotation, count: container.count },
      factor: ctx.factor,
      servingsAtClear: ctx.servingsAtClear,
      scope,
    }
  }
  const parsed = parseQuantity(basis)
  if (parsed) {
    return { keyName, unit: { kind: 'byUnit', unit: parsed.unit, amount: parsed.amount }, factor: ctx.factor, servingsAtClear: ctx.servingsAtClear, scope }
  }
  return { keyName, unit: { kind: 'raw', basis }, factor: ctx.factor, servingsAtClear: ctx.servingsAtClear, scope }
}

/** Runtime shape guard for one ADR-0094 cleared entry off the wire/backup. */
export function isClearedIngredient(value: unknown): value is ClearedIngredient {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<ClearedIngredient>
  if (typeof e.keyName !== 'string' || !e.keyName) return false
  if (e.scope !== 'line' && e.scope !== 'ingredient') return false
  if (typeof e.factor !== 'number' || !Number.isFinite(e.factor)) return false
  if (typeof e.servingsAtClear !== 'number' || !Number.isFinite(e.servingsAtClear)) return false
  const u = e.unit as { kind?: unknown; unit?: unknown; amount?: unknown; noun?: unknown; annotation?: unknown; count?: unknown; basis?: unknown } | undefined
  if (typeof u !== 'object' || u === null) return false
  switch (u.kind) {
    case 'byUnit':
      return typeof u.unit === 'string' && typeof u.amount === 'number' && Number.isFinite(u.amount)
    case 'container':
      return (
        typeof u.noun === 'string' &&
        typeof u.annotation === 'string' &&
        typeof u.count === 'number' &&
        Number.isFinite(u.count)
      )
    case 'raw':
      return typeof u.basis === 'string'
    case 'row':
      return true
    default:
      return false
  }
}

/**
 * Normalize a cleared map that may be EITHER shape — the ADR-0094 object
 * arrays (used as-is) or the legacy `Record<number, string[]>` (migrated
 * entry-by-entry). Legacy entries get their serving context stamped from
 * `servingsFor` (the plan's CURRENT state — the ADR's documented
 * approximation: at stamp time the servings ratio is 1, so a migrated
 * entry hides exactly the line its string key named, strictly no worse
 * than the string model; `factor` is stamped 1 because a legacy blob
 * cannot know the recipe's base servings — the successor derivation uses
 * the servings ratio, which is mathematically identical since the base
 * cancels).
 *
 * Entries are deduped per variant by `clearedEntryIdentity`, incoming
 * last (so a re-clear's fresher context wins). Variants whose arrays are
 * empty or whose entries all fail validation are dropped.
 */
export function migrateClearedMap(
  raw: Record<number, readonly unknown[]> | Record<string, readonly unknown[]> | undefined,
  servingsFor: (variantId: number) => number,
): Record<number, ClearedIngredient[]> {
  const out: Record<number, ClearedIngredient[]> = {}
  if (!raw) return out
  for (const [rawId, list] of Object.entries(raw)) {
    if (!Array.isArray(list) || list.length === 0) continue
    const variantId = Number(rawId)
    if (!Number.isFinite(variantId)) continue
    const ctx: ClearedClearContext = { factor: 1, servingsAtClear: servingsFor(variantId) }
    const byIdentity = new Map<string, ClearedIngredient>()
    for (const item of list) {
      const entry =
        typeof item === 'string'
          ? clearedEntryFromKey(item, ctx)
          : isClearedIngredient(item)
            ? item
            : null
      if (!entry) continue
      byIdentity.set(clearedEntryIdentity(entry), entry)
    }
    if (byIdentity.size > 0) out[variantId] = [...byIdentity.values()]
  }
  return out
}

/**
 * True when the variant's cleared entries claim the WHOLE ingredient group
 * (a `row` entry or a scope-'ingredient' claim) — the whole-ingredient
 * skip that used to be a bare nameKey in the cleared set.
 */
export function clearedIngredientHidden(
  cleared: readonly ClearedIngredient[] | undefined,
  keyName: string,
): boolean {
  return (
    cleared?.some(
      (e) => e.keyName === keyName && (e.scope === 'ingredient' || e.unit.kind === 'row'),
    ) ?? false
  )
}

/** One rendered snapshot line: the full checkbox key plus its display text. */
export interface ClearedSnapshotLine {
  key: string
  display: string
}

/** The grammar branch a rendered line belongs to, read off its display —
 *  the same string the render branched on (container parse first, then the
 *  linear quantity parse, else the raw row). */
function clearedBranchOfDisplay(display: string): 'container' | 'byUnit' | 'raw' {
  if (parseContainerQuantity(display)) return 'container'
  if (parseQuantity(display)) return 'byUnit'
  return 'raw'
}

/** The branch inferred from a line KEY alone (no display available): the
 *  raw|| namespace is raw; a parseable container basis is container;
 *  everything else parses as a linear quantity. Ambiguous ONLY for a raw
 *  row whose key source parsed (the restriction seam's key/display split)
 *  — callers holding the display pass it and skip the guess. */
function clearedBranchOfKey(key: string): 'container' | 'byUnit' | 'raw' {
  const sep = key.indexOf('||')
  const basis = sep < 0 ? '' : key.slice(sep + 2)
  if (basis.startsWith('raw||')) return 'raw'
  if (parseContainerQuantity(basis)) return 'container'
  if (parseQuantity(basis)) return 'byUnit'
  return 'raw'
}

/**
 * The cleared entry ONE variant's claim on ONE checked line produces
 * (ADR-0094): the variant's OWN share of the merged line — parsed from
 * the variant's own rendered line in the same grammar branch — plus the
 * clear-time serving context. Returns null when the variant does not
 * contribute to that line (it holds the ingredient's nameKey but renders
 * a DIFFERENT grammar branch beside it), so a claim is never minted for a
 * line the variant cannot own — the structural guard that keeps a
 * sibling's line independent.
 *
 * Without the snapshot's own-line view (legacy callers), the merged
 * checked key's basis stands in for the own share: exact for a
 * sole-contributor line (the common case) and the pre-object model's
 * behaviour otherwise.
 */
export function clearedEntryForCheckedLine(
  keyName: string,
  checked: { key: string; display?: string },
  ownLines: readonly ClearedSnapshotLine[] | undefined,
  ctx: { servings: number; factor: number },
): ClearedIngredient | null {
  const branch = checked.display
    ? clearedBranchOfDisplay(checked.display)
    : clearedBranchOfKey(checked.key)
  let basis: string | null = null
  if (ownLines) {
    const identity = lineKeyIdentity(checked.key)
    const own = ownLines.find((l) => {
      if (clearedBranchOfDisplay(l.display) !== branch) return false
      // Raw-branch lines are per-DISPLAY (the render's raw map is keyed
      // by the display text): the merged raw line is the contributor
      // whose display IS this one.
      if (branch === 'raw') return l.display === checked.display
      return lineKeyIdentity(l.key) === identity
    })
    if (!own) return null
    basis = own.key.slice(own.key.indexOf('||') + 2)
  } else {
    const sep = checked.key.indexOf('||')
    if (sep < 0) return null
    basis = checked.key.slice(sep + 2)
  }
  if (branch === 'raw') {
    // The display says raw row — the kind follows the branch even when the
    // key source parsed (the restriction seam's key/display split): the
    // basis is preserved verbatim and the filter's raw matching re-parses
    // it for the scaled successor.
    const content = basis.startsWith('raw||') ? basis.slice('raw||'.length) : basis
    return {
      keyName,
      unit: { kind: 'raw', basis: content },
      factor: ctx.factor,
      servingsAtClear: ctx.servings,
      scope: 'line',
    }
  }
  const container = parseContainerQuantity(basis)
  if (container) {
    return {
      keyName,
      unit: { kind: 'container', noun: container.container, annotation: container.annotation, count: container.count },
      factor: ctx.factor,
      servingsAtClear: ctx.servings,
      scope: 'line',
    }
  }
  const parsed = parseQuantity(basis)
  if (parsed) {
    return {
      keyName,
      unit: { kind: 'byUnit', unit: parsed.unit, amount: parsed.amount },
      factor: ctx.factor,
      servingsAtClear: ctx.servings,
      scope: 'line',
    }
  }
  return {
    keyName,
    unit: { kind: 'raw', basis },
    factor: ctx.factor,
    servingsAtClear: ctx.servings,
    scope: 'line',
  }
}

/**
 * The legacy `nameKey||basis` spelling of a cleared entry — the shape the
 * string model persisted and the render filter still consumes. Used as
 * the Task-1 bridge at the `useGroceryList` seam until the successor-key
 * filter rewrite lands: byUnit/raw/row entries round-trip exactly; a
 * container entry re-spells its noun through the canonical formatter
 * (`½ (142 g) pkg` -> `½ (142 g) pkgs`), which can transiently re-spell a
 * legacy verbatim key — the Task-3 filter matches containers by parsed
 * (containerKey, count) instead, so the shipped behavior is exact.
 */
export function clearedLineKey(entry: ClearedIngredient): string {
  const u = entry.unit
  switch (u.kind) {
    case 'row':
      return entry.keyName
    case 'raw':
      return `${entry.keyName}||raw||${u.basis}`
    case 'container':
      return `${entry.keyName}||${formatContainerQuantity(u.count, u.noun, u.annotation)}`
    case 'byUnit':
      return `${entry.keyName}||${lineKeyBasis(u.amount, u.unit)}`
  }
}

/**
 * The whole cleared map in the legacy string spelling — the interim wire
 * shape (room snapshot's `cleared` key, ADR-0094 Appendix A) and the
 * Task-1 bridge input at the `useGroceryList` seam. Older peers keep
 * receiving exactly the payload shape they always did; Task 4 replaces
 * this with the `clearedV2` + legacy dual emission.
 */
export function clearedMapToLegacy(
  map: Record<number, readonly ClearedIngredient[]>,
): Record<number, string[]> {
  const out: Record<number, string[]> = {}
  for (const [rawId, entries] of Object.entries(map)) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    const id = Number(rawId)
    if (!Number.isFinite(id)) continue
    out[id] = [...new Set(entries.map(clearedLineKey))]
  }
  return out
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
  /**
   * Per-meal cleared entries for THIS meal (ADR-0094): a whole-ingredient
   * claim (`row` kind / `ingredient` scope) hides the variant's whole
   * contribution to an ingredient group; a `line` claim hides exactly the
   * rendered line its successor derivation predicts —
   * `aggregateGroceries` unions the claims.
   */
  cleared?: readonly ClearedIngredient[]
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
/**
 * The aggregation-row KEY list for one input: the display rows' keyNames
 * when the restriction seam is active, else each base line's nameKey —
 * the ONE derivation the consumers share. aggregateGroceries walks these
 * rows (plus their names/quantities); the sidebar card counts the
 * SURVIVING rows from this list and the clear-snapshot provider
 * snapshots it. Exported so the "SAME rows by construction" comments
 * become structurally true instead of asserted in prose (DRY).
 */
export function aggregateRowKeys(input: Pick<AggregateInput, 'doc' | 'displayLines'>): string[] {
  return input.displayLines
    ? input.displayLines.map((row) => row.keyName)
    : input.doc.line_items.map((li) => nameKey(li.ingredient_name))
}

/**
 * The checked-map's stored convention, ONE spelling: only TRUE entries
 * are kept — absent/false means unchecked, so a stale `false` can never
 * resurrect a done item. The room snapshot, the room's applyRemote and
 * backup's checked.json writer all used to spell this loop by hand.
 */
export function onlyTrueKeys(map: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(map)) {
    if (value) out[key] = true
  }
  return out
}

/**
 * A rendered line key's COMPOSITION-STABLE identity (PR #94 round 2,
 * kody K1): the nameKey plus the basis's UNIT identity — the normalized
 * container key (`pkg|142 g`) for container quantities, otherwise
 * `unitKey` of the PARSED unit (amount-free and plural-collapsed:
 * `2 cups` and `1 cup` share `cup`; a unitless `2` and `4` share the
 * empty unit), and the trailing raw token only when the basis parses as
 * neither. `raw||`-namespace keys (a raw row whose key source could not
 * parse) carry no stable unit, so they are their own identity —
 * exact-match only, the pre-round-2 behaviour.
 *
 * Why an identity at all: a cleared entry persists the RENDER-summed
 * basis (`soy sauce||3 tbsp`), which stops matching the moment a
 * co-contributing meal is cooked/unplanned or the servings change (the
 * line re-sums to `2 tbsp`) — the cleared line would reappear even
 * though the household never re-planned. The unit does not change with
 * composition, so matching on (nameKey, unit) keeps the line hidden
 * across composition changes while structurally never over-hiding: a
 * by-unit line is unique per unit identity and a container line unique
 * per (noun, annotation) inside its group, so one identity can match at
 * most one rendered line and an unchecked sibling line (a DIFFERENT
 * unit) can never be swallowed.
 */
export function lineKeyIdentity(key: string): string {
  const sep = key.indexOf('||')
  if (sep < 0) return key
  const nameKey = key.slice(0, sep)
  const basis = key.slice(sep + 2)
  if (basis.startsWith('raw||')) return key
  const container = parseContainerQuantity(basis)
  if (container) return `${nameKey}||${containerKey(container.container, container.annotation)}`
  const parsed = parseQuantity(basis)
  if (parsed) return `${nameKey}||${unitKey(parsed.unit)}`
  const tokens = basis.trim().split(/\s+/)
  return `${nameKey}||${(tokens[tokens.length - 1] ?? '').toLowerCase()}`
}

/**
 * The Contributing Meals card's line count for ONE meal (kody PR #94
 * round 2, K2 + round-2 follow-up): the lines THIS meal contributes
 * that SURVIVE in the merged render — the meal's own rendered line
 * identities (a single-input aggregation of the same input, so a meal
 * using soy sauce in tbsp while another uses ml attributes only its own
 * unit line) intersected with its groups' surviving identities from the
 * merged pass, and rows bare-cleared for THIS meal skipped (its own
 * contribution stays hidden even when the merged group survives on
 * other meals).
 *
 * `visibleIdentitiesByGroup` is the merged render's per-group surviving
 * line identities (`item.normalized` → the set of
 * `lineKeyIdentity(line.key)` over its visible lines), so the card
 * cannot disagree with the list by construction. Identities are counted
 * once each (a degenerate same-identity raw pair cannot double-count).
 */
export function mealSurvivingLines(
  input: AggregateInput,
  visibleIdentitiesByGroup: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  const own = aggregateGroceries([{ ...input, cleared: undefined }])
  let lines = 0
  for (const group of own) {
    if (clearedIngredientHidden(input.cleared, group.normalized)) continue
    const surviving = visibleIdentitiesByGroup.get(group.normalized)
    if (!surviving) continue
    for (const id of new Set(group.lines.map((line) => lineKeyIdentity(line.key)))) {
      if (surviving.has(id)) lines += 1
    }
  }
  return lines
}

export function aggregateGroceries(inputs: AggregateInput[]): GroceryItem[] {
  const groups = new Map<string, Group>()

  // ADR-0094: the cleared state is the OBJECT grammar — per-variant claims
  // carrying the variant's OWN clear-time share and the clear-time serving
  // context. Each claim predicts the SUCCESSOR contribution its variant's
  // line makes at the CURRENT servings: the clear-time own share re-scaled
  // by the servings ratio (the recipe's base servings cancels out of the
  // ratio, so a legacy entry's factor-1 placeholder never distorts it).
  // Because each claim re-derives with the render's own grammar, the sum
  // of the claims in a bucket equals exactly what the render will produce
  // for the claimed contributors — no stale strings, no identity
  // guessing, no display-shape heuristics:
  //
  // - byUnit claims SUM per unit bucket (the render's byUnit map sums its
  //   contributors the same way) and hide the line whose parsed amount
  //   spelling equals the claimed sum;
  // - container claims sum per container bucket (the ADR-0017 ceil rule
  //   reapplied at the ratio);
  // - raw claims are ANY-match on the successor basis (the render's raw
  //   map keeps ONE first-seen key basis per display, so the claim that
  //   named the line is the one that scales it);
  // - a whole-ingredient (row / scope ingredient) claim skips the
  //   variant's contribution at ingestion, exactly like the old
  //   bare-nameKey skip.
  //
  // The BRANCH discrimination (read off the rendered line's display — the
  // same string the render branched on) is what kills the K5 sibling
  // swallow structurally: a by-unit claim can never hide a raw row beside
  // it, and vice versa — the collapse the old lineKeyIdentity fallback
  // suffered (`egg||4` and a raw `egg||6` both reducing to `egg||`).
  interface SuccessorSum {
    sum: number
    claims: number
  }
  const successorByUnit = new Map<string, SuccessorSum>()
  const successorContainers = new Map<string, SuccessorSum>()
  const successorRawParsed = new Set<string>()
  const successorRawVerbatim = new Set<string>()
  let hasLineClaims = false
  for (const { doc, factor, cleared } of inputs) {
    if (!cleared?.length) continue
    const base = doc.serving_count
    const servingsNow = factor * base
    for (const entry of cleared) {
      if (entry.scope === 'ingredient' || entry.unit.kind === 'row') continue
      // Guard a corrupt context: a non-positive servingsAtClear cannot be
      // scaled from, so the claim applies verbatim (ratio 1).
      const ratio =
        entry.servingsAtClear > 0 && Number.isFinite(entry.servingsAtClear)
          ? servingsNow / entry.servingsAtClear
          : 1
      const u = entry.unit
      if (u.kind === 'byUnit') {
        hasLineClaims = true
        const bucket = `u:${unitKey(u.unit)}`
        const cur = successorByUnit.get(bucket) ?? { sum: 0, claims: 0 }
        cur.sum += u.amount * ratio
        cur.claims += 1
        successorByUnit.set(bucket, cur)
      } else if (u.kind === 'container') {
        hasLineClaims = true
        const bucket = `c:${containerKey(u.noun, u.annotation)}`
        const cur = successorContainers.get(bucket) ?? { sum: 0, claims: 0 }
        cur.sum += containerContribution(u.count, ratio)
        cur.claims += 1
        successorContainers.set(bucket, cur)
      } else if (u.kind === 'raw') {
        hasLineClaims = true
        const parsed = parseQuantity(u.basis)
        if (parsed) {
          // A raw row whose key source parsed (the restriction seam's
          // key/display split): the key basis is the parsed grammar and
          // re-sums with the servings, so the successor re-spells it.
          successorRawParsed.add(lineKeyBasis(parsed.amount * ratio, parsed.unit))
        } else {
          successorRawVerbatim.add(u.basis)
        }
      }
    }
  }

  for (const { doc, factor, recipeName, cleared, displayLines } of inputs) {
    // ADR-0009: seasonings scale sub-linearly against the recipe's own
    // authored serving count — the shared scaler takes base + factor.
    const base = doc.serving_count
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
      if (clearedIngredientHidden(cleared, normalized)) continue
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
        // ADR-0054/0055: ONE seasoning-aware scale (recipe.ts's
        // scaleSeasoningAware) — seasonings keep the sub-linear rule on
        // the shared spoon vocabulary, everything else scales through
        // scaleMetricAmount's quantized grammar, so the grocery sum, the
        // recipe-detail chip and the step lines can never disagree:
        // `2129 ml ×⅔` renders `1420 ml` on BOTH surfaces.
        const scaled = scaleSeasoningAware(parsed.amount, base, factor, parsed.unit, row.name)
        // The key side runs the SAME scale rule on the key source's amount,
        // classified by the KEY ingredient (the base doc's name — a
        // substitute that crosses the seasoning verdict must not
        // re-classify the base spelling). A key source that parses to a
        // DIFFERENT unit follows the display unit (the parallel sums live
        // under the display line's unit key).
        const keyIngredient = row.keyIngredient ?? row.name
        const keyScaled = keyParsed && unitKey(keyParsed.unit) === key
          ? scaleSeasoningAware(keyParsed.amount, base, factor, keyParsed.unit, keyIngredient)
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
            const keyScaled = scaleSeasoningAware(kp.amount, base, factor, kp.unit, keyIngredient)
            group.raw.set(display, lineKeyBasis(keyScaled, kp.unit))
          } else {
            group.raw.set(display, `raw||${(row.keyQuantity ?? row.quantity).trim()}`)
          }
        }
      }
    }
  }

  // ADR-0094: does one of the successor claims predict THIS rendered line?
  // The line's grammar BRANCH is read off its display (the same string the
  // render branched on), never guessed from the key; the AMOUNT comes off
  // the KEY basis (what the claims' own shares were spelled from — the
  // key/display split can differ).
  const lineClaimed = (l: GroceryLine): boolean => {
    const sep = l.key.indexOf('||')
    const basis = sep < 0 ? '' : l.key.slice(sep + 2)
    const branchContainer = parseContainerQuantity(l.display)
    if (branchContainer) {
      const keyParsed = parseContainerQuantity(basis)
      if (!keyParsed) return false
      const claim = successorContainers.get(
        `c:${containerKey(branchContainer.container, branchContainer.annotation)}`,
      )
      return claim !== undefined && Math.abs(keyParsed.count - claim.sum) < 1e-6
    }
    const branchParsed = parseQuantity(l.display)
    if (branchParsed) {
      const keyParsed = parseQuantity(basis)
      if (!keyParsed) return false
      const claim = successorByUnit.get(`u:${unitKey(branchParsed.unit)}`)
      return claim !== undefined && formatAmount(claim.sum) === formatAmount(keyParsed.amount)
    }
    // Raw branch: the display never parses. The line's key basis is the
    // parsed-grammar spelling when the key source parsed (possibly
    // re-namespaced under `raw||` after a dedup collision), else the
    // verbatim `raw||` content — either spelling matches its claim.
    const content = basis.startsWith('raw||') ? basis.slice('raw||'.length) : basis
    return successorRawParsed.has(content) || successorRawVerbatim.has(content)
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
      // Line keys stay unique (the checked map IS keyed by them). A raw
      // row whose key source PARSES spells the parsed grammar — which a
      // by-unit line may already have emitted for the same base quantity
      // (the by-unit line is pushed FIRST and carries the real summed
      // display). The colliding raw row is DROPPED when its display is
      // blank (the overlay's blanked quantity: the real line already
      // renders the amount), and re-namespaced under `raw||` when it
      // carries a real, distinct text, so both lines coexist under
      // distinct checkbox keys. A keyBasis already in the `raw||`
      // namespace (an unparseable key source) can never collide.
      const key = `${normalized}||${keyBasis}`
      if (!lines.some((l) => l.key === key)) {
        lines.push({ key, display: raw })
      } else if (raw !== '') {
        lines.push({ key: `${normalized}||raw||${keyBasis}`, display: raw })
      }
    }
    // When the group's display names DIVERGE (different substitutes for the
    // same base ingredient, or a restricted meal plus an unrestricted one),
    // the label names them ALL — a first-seen-only label would silently
    // claim the whole summed quantity for one substitute. The quantity sums
    // stay merged (splitting by name would re-key checked state on
    // toggle); the section still buckets on the first-seen name.
    const name = group.names.size > 1 ? [...group.names].join(' / ') : group.name
    // ADR-0094 line filter: hide every rendered line one of the successor
    // claims predicts. The raw-dedup above ran against the UNfiltered list
    // (dedup semantics unchanged); the filter only hides.
    const visible = hasLineClaims
      ? lines.filter((l) => !lineClaimed(l))
      : lines
    // A group whose every line is cleared disappears entirely — an
    // ingredient header with zero lines would otherwise linger.
    if (visible.length === 0) continue
    items.push({
      normalized,
      name,
      section: bucketFor(group.name),
      recipes: [...group.recipes],
      lines: visible,
    })
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}
