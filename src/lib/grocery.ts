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

/**
 * The clear-time serving context stamped onto entries captured at clear
 * time (informational — the line filter derives successors from the
 * claiming variant's own current render, never from these fields).
 */
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
 * The entry is ALWAYS an `approx` claim (ADR-0094 review addendum): a
 * legacy string carried the MERGED line key — no per-variant share and no
 * serving context — so its amount is advisory and its factor/servings
 * context is stamped "unknown" (factor 1, servingsAtClear 0) rather than
 * invented from the plan's current state. The filter matches approx
 * claims by identity presence, which survives any servings change.
 *
 * Returns null for a key that cannot yield a nameKey (defensive: a
 * malformed `||...` string is dropped rather than stored as an
 * empty-named claim).
 */
export function clearedEntryFromKey(key: string): ClearedIngredient | null {
  if (!key) return null
  const sep = key.indexOf('||')
  if (sep < 0) {
    return {
      keyName: key,
      unit: { kind: 'row' },
      factor: 1,
      servingsAtClear: 0,
      scope: 'ingredient',
      approx: true,
    }
  }
  const keyName = key.slice(0, sep)
  const basis = key.slice(sep + 2)
  if (!keyName) return null
  const scope: 'line' | 'ingredient' = 'line'
  // Legacy context is UNKNOWN, never invented: the string model stored no
  // serving snapshot, so any stamped value would be a guess (and stamping
  // the plan's CURRENT servings mispredicts the moment the plan has moved
  // since the clear). approx claims never read these fields.
  const ctx = { factor: 1, servingsAtClear: 0 }
  if (basis.startsWith('raw||')) {
    return { keyName, unit: { kind: 'raw', basis: basis.slice('raw||'.length) }, ...ctx, scope, approx: true }
  }
  const container = parseContainerQuantity(basis)
  if (container) {
    return {
      keyName,
      unit: { kind: 'container', noun: container.container, annotation: container.annotation, count: container.count },
      ...ctx,
      scope,
      approx: true,
    }
  }
  const parsed = parseQuantity(basis)
  if (parsed) {
    return { keyName, unit: { kind: 'byUnit', unit: parsed.unit, amount: parsed.amount }, ...ctx, scope, approx: true }
  }
  return { keyName, unit: { kind: 'raw', basis }, ...ctx, scope, approx: true }
}

/** Runtime shape guard for one ADR-0094 cleared entry off the wire/backup. */
export function isClearedIngredient(value: unknown): value is ClearedIngredient {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<ClearedIngredient>
  if (typeof e.keyName !== 'string' || !e.keyName) return false
  if (e.scope !== 'line' && e.scope !== 'ingredient') return false
  if (typeof e.factor !== 'number' || !Number.isFinite(e.factor)) return false
  if (typeof e.servingsAtClear !== 'number' || !Number.isFinite(e.servingsAtClear)) return false
  if (e.approx !== undefined && e.approx !== true) return false
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
 * entry-by-entry).
 *
 * Legacy strings become `approx` claims (ADR-0094 review addendum): the
 * string model persisted the MERGED line key — one identity, no
 * per-variant share, no serving context — so each distinct migrated
 * identity mints ONE identity-presence claim whose serving context is stamped
 * "unknown", never invented from the plan's current state. The claim's amount
 * is advisory — consulted for UNIT-BEARING claims in `lineClaimed` (so a
 * legacy `cabbage||1.5 medium head` cannot hide a `4 medium heads` line, but
 * unitless claims like `egg||` still hide across re-sums regardless of amount),
 * never used to invent serving context. The same merged string arriving through several
 * contributing variants' arrays therefore still yields one claim per
 * identity per variant, and identity claims never sum, so N contributors
 * can never multiply the claimed amount (the pre-review migration turned
 * each into a full byUnit claim and N of them summed to N × the merged
 * line).
 *
 * Entries are deduped per variant by `clearedEntryIdentity`, incoming
 * last (so a re-clear's fresher context wins). Variants whose arrays are
 * empty or whose entries all fail validation are dropped.
 */
export function migrateClearedMap(
  raw: Record<number, readonly unknown[]> | Record<string, readonly unknown[]> | undefined,
): Record<number, ClearedIngredient[]> {
  const out: Record<number, ClearedIngredient[]> = {}
  if (!raw) return out
  for (const [rawId, list] of Object.entries(raw)) {
    if (!Array.isArray(list) || list.length === 0) continue
    const variantId = Number(rawId)
    if (!Number.isFinite(variantId)) continue
    const byIdentity = new Map<string, ClearedIngredient>()
    for (const item of list) {
      const entry =
        typeof item === 'string'
          ? clearedEntryFromKey(item)
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
 * clear-time serving context. The context and amount are INFORMATIONAL
 * (they spell what was cleared and when, and feed the legacy wire
 * spelling): the line filter re-derives each claim's successor from the
 * claiming variant's own CURRENT render — the shadow aggregation (the
 * ADR-0094 review addendum) — so a captured value is never re-scaled.
 * Returns null when the variant does not contribute to that line (it
 * holds the ingredient's nameKey but renders a DIFFERENT grammar branch
 * beside it), so a claim is never minted for a line the variant cannot
 * own — the structural guard that keeps a sibling's line independent.
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
 * Do an inbound snapshot's two cleared spellings DISAGREE (ADR-0094
 * review addendum, the mixed-household freshness rule)? Both inputs are
 * normalized through the SAME funnel — object arrays → legacy strings —
 * and compared as sorted, deduped string sets per variant, so the
 * comparison is stable under entry order and never depends on clock
 * reading.
 *
 * Why this decides freshness: a V2-capable sender derives BOTH spellings
 * from ONE state at snapshot time (`room.ts` `snapshot()`), so its two
 * keys always agree. A peer that predates `clearedV2` writes ONLY
 * `cleared` — which is exactly when the two per-store rows can diverge
 * (the relay's `splitSnapshot` treats an absent key as silence, so the
 * older `clearedV2` row stays persisted next to the newer `cleared`).
 * Disagreement therefore PROVES the legacy spelling is the newer write,
 * and the receiver must apply it instead of the stale object arrays.
 */
export function clearedSpellingsDiverge(
  a: Record<number, readonly unknown[]> | undefined,
  b: Record<number, readonly unknown[]> | undefined,
): boolean {
  // An ABSENT key is silence (ADR-0028's standing rule): there is nothing
  // to disagree with, and the caller's presence-decides branch handles it.
  if (a === undefined || b === undefined) return false
  const canonical = (raw: Record<number, readonly unknown[]>): string => {
    const legacy = clearedMapToLegacy(migrateClearedMap(raw))
    const sorted: Record<string, string[]> = {}
    for (const id of Object.keys(legacy).sort((x, y) => Number(x) - Number(y))) {
      sorted[id] = [...legacy[Number(id)]].sort()
    }
    return JSON.stringify(sorted)
  }
  return canonical(a) !== canonical(b)
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

/**
 * The INGESTION half of the grocery aggregation: walk every input's rows
 * (the restriction display rows or the base doc lines) into per-nameKey
 * groups, scaling/merging exactly as the render always has. Extracted
 * from `aggregateGroceries` so the cleared-line successor pass can render
 * a claiming variant's OWN current contribution — the shadow aggregation
 * (ADR-0094 review addendum): the successor of a cleared line is what the
 * variant's own render produces for that identity at the CURRENT
 * servings, computed by the very same code the merged render runs, so
 * seasoning scaling, metric quantization and the ADR-0017 container
 * ceiling can never diverge between claim and render.
 */
function buildGroups(inputs: AggregateInput[]): Map<string, Group> {
  const groups = new Map<string, Group>()
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
  return groups
}

export function aggregateGroceries(inputs: AggregateInput[]): GroceryItem[] {

  // ADR-0094 (review addendum): the cleared state is the OBJECT grammar —
  // per-variant claims carrying a stable, discriminated IDENTITY. Each
  // claim's SUCCESSOR is what the claiming variant's own render produces
  // for that identity at the CURRENT servings — computed by running the
  // very same `buildGroups` ingestion the merged render runs (the shadow
  // aggregation), so the claim and the render can never diverge: the
  // sub-linear seasoning rule (ADR-0009), `scaleMetricAmount`'s
  // quantized grammar (ADR-0057) and the ADR-0017 container ceiling are
  // all THE RENDER'S OWN math, not a re-implementation that drifts. The
  // stored clear-time amount/context is informational; matching never
  // re-scales a captured (already-rendered) value.
  //
  // - byUnit/container claims SUM per (keyName, identity) bucket — the
  //   merged render sums its contributors the same way — and hide the
  //   line whose key amount equals the claimed sum. A partial clear (one
  //   contributor claimed) sums to less than the merged line and leaves
  //   it visible; a full merged clear sums to exactly the merged line and
  //   hides it (the owner contract: checking off the merged total checks
  //   off everything).
  // - raw claims are ANY-match on the successor basis, per keyName (the
  //   render's raw map keeps ONE first-seen key basis per display).
  // - `approx` claims (legacy string migrations) carry no trustworthy
  //   amount, so they match by IDENTITY PRESENCE: the rendered line whose
  //   unit identity equals the claim's is hidden at any re-sum. One
  //   identity matches at most one rendered line per group, so a sibling
  //   can never be swallowed, and N duplicate legacy claims never sum.
  // - a whole-ingredient (row / scope ingredient) claim skips the
  //   variant's contribution at ingestion, exactly like the old
  //   bare-nameKey skip.
  //
  // Every bucket is scoped by the claim's `keyName` — the group key the
  // render itself derives (`row.keyName`). A claim can therefore only
  // ever hide a line of ITS OWN ingredient: two ingredients sharing a
  // unit/container/raw basis keep independent buckets, and `lineClaimed`
  // resolves each rendered line's group from the line's own key.
  interface SuccessorSum {
    sum: number
    claims: number
  }
  const successorByUnit = new Map<string, SuccessorSum>()
  const successorContainers = new Map<string, SuccessorSum>()
  const successorRawParsed = new Map<string, Set<string>>()
  const successorRawVerbatim = new Map<string, Set<string>>()
  // Identity-presence claims (`approx`), keyed `${keyName}||${identity}`.
  const successorIdentities = new Set<string>()
  // Approx (legacy) entries carry an advisory amount (clearedEntryFromKey
  // 119-123); for unit-bearing claims we compare it against the merged key
  // amount so a legacy `cabbage||1.5 medium head` no longer hides a
  // `4 medium heads` line with an unclaimed portion (Kody critical).
  // Unitless/row/raw claims leave this unset and fall back to identity.
  const successorAmounts = new Map<string, number>()
  let hasLineClaims = false
  const rawSetFor = (map: Map<string, Set<string>>, name: string): Set<string> => {
    let set = map.get(name)
    if (!set) {
      set = new Set<string>()
      map.set(name, set)
    }
    return set
  }
  for (const input of inputs) {
    const { cleared } = input
    if (!cleared?.length) continue
    const lineEntries = cleared.filter(
      (entry) => entry.scope !== 'ingredient' && entry.unit.kind !== 'row',
    )
    if (lineEntries.length === 0) continue
    hasLineClaims = true
    // The variant's own current render — the shadow. Built only when an
    // exact claim needs it (approx claims never consult amounts).
    const shadowGroups = lineEntries.some((entry) => !entry.approx)
      ? buildGroups([{ ...input, cleared: undefined }])
      : null
    for (const entry of lineEntries) {
      const name = entry.keyName
      const u = entry.unit
      if (entry.approx) {
        if (u.kind === 'byUnit') {
          const id = `${name}||u:${unitKey(u.unit)}`
          successorIdentities.add(id)
          // Unit-bearing amount is meaningful; unitless (`egg||`) keeps no
          // amount — its identity must hide across re-sums (test 513), so it
          // stays amount-free and falls back to identity below.
          if (u.unit) successorAmounts.set(id, u.amount)
        } else if (u.kind === 'container') {
          const id = `${name}||c:${containerKey(u.noun, u.annotation)}`
          successorIdentities.add(id)
          successorAmounts.set(id, u.count) // container count is always meaningful
        } else if (u.kind === 'raw') {
          rawSetFor(successorRawVerbatim, name).add(u.basis)
        }
        continue
      }
      const shadow = shadowGroups?.get(name)
      if (!shadow) continue
      if (u.kind === 'byUnit') {
        const own = shadow.byUnit.get(unitKey(u.unit))
        if (!own) continue
        const bucket = `${name}||u:${unitKey(u.unit)}`
        const cur = successorByUnit.get(bucket) ?? { sum: 0, claims: 0 }
        cur.sum += own.keyAmount
        cur.claims += 1
        successorByUnit.set(bucket, cur)
      } else if (u.kind === 'container') {
        const own = shadow.containers.get(containerKey(u.noun, u.annotation))
        if (!own) continue
        const bucket = `${name}||c:${containerKey(u.noun, u.annotation)}`
        const cur = successorContainers.get(bucket) ?? { sum: 0, claims: 0 }
        cur.sum += own.keyAmount
        cur.claims += 1
        successorContainers.set(bucket, cur)
      } else if (u.kind === 'raw') {
        const parsed = parseQuantity(u.basis)
        if (!parsed) {
          // Verbatim raw row — the render passes it through unscaled, so
          // the clear-time basis IS the successor.
          rawSetFor(successorRawVerbatim, name).add(u.basis)
          continue
        }
        // A raw row whose key source parsed (the restriction seam's
        // key/display split): the successor is the shadow raw line's
        // re-summed basis. Matched by unit identity inside the group —
        // raw rows share no amount-stable identity — with an ambiguous
        // group (two same-unit raw rows) falling back to the verbatim
        // clear-time basis rather than guessing.
        const matches = [...shadow.raw.values()]
          .map((kb) => (kb.startsWith('raw||') ? kb.slice('raw||'.length) : kb))
          .filter((content) => {
            const p = parseQuantity(content)
            return p !== null && unitKey(p.unit) === unitKey(parsed.unit)
          })
        if (matches.length === 1) {
          rawSetFor(successorRawParsed, name).add(matches[0])
        } else {
          rawSetFor(successorRawVerbatim, name).add(u.basis)
        }
      }
    }
  }
  const groups = buildGroups(inputs)


  // ADR-0094: does one of the successor claims predict THIS rendered line?
  // The line's grammar BRANCH is read off its display (the same string the
  // render branched on), never guessed from the key; the AMOUNT comes off
  // the KEY basis (what the claims' own shares were spelled from — the
  // key/display split can differ). Every lookup is SCOPED to the line's
  // own group (the key's nameKey half): a claim for one ingredient can
  // never hide another ingredient's line, however much their units,
  // containers or raw bases coincide.
  const lineClaimed = (l: GroceryLine): boolean => {
    const sep = l.key.indexOf('||')
    const name = sep < 0 ? '' : l.key.slice(0, sep)
    const basis = sep < 0 ? '' : l.key.slice(sep + 2)
    const branchContainer = parseContainerQuantity(l.display)
    if (branchContainer) {
      const cKey = containerKey(branchContainer.container, branchContainer.annotation)
      const keyParsed = parseContainerQuantity(basis)
      // ADR-0094 fix (Kody critical): the pre-review code short-circuited to
      // `return true` on identity presence alone, so a legacy approx
      // `cabbage||1.5 medium head` claim hid a merged PARTIAL line (4 medium
      // heads with one contributor unclaimed). The shadow (non-approx) claim
      // is authoritative when present; an approx claim carrying an amount is
      // compared and, on mismatch, must NOT defer to identity presence —
      // amount-free claims (raw/row/unitless) keep the identity fallback.
      const claim = successorContainers.get(`${name}||c:${cKey}`)
      if (claim !== undefined && keyParsed) {
        // The rendered basis is spelled through formatFraction's glyph
        // grammar (⅓, 2 ¼), so the comparison tolerates the fraction snap
        // (0.02, containers.ts's FRACTION_TOLERANCE) rather than demanding
        // bit-equality against the exact summed key amount.
        return Math.abs(keyParsed.count - claim.sum) < 0.02 + 1e-9
      }
      const approx = successorAmounts.get(`${name}||c:${cKey}`)
      if (approx !== undefined) {
        const target = keyParsed ? keyParsed.count : branchContainer.count
        return Math.abs(target - approx) < 0.02 + 1e-9
      }
      return successorIdentities.has(`${name}||c:${cKey}`)
    }
    const branchParsed = parseQuantity(l.display)
    if (branchParsed) {
      // ADR-0094 fix point (Kody critical): do not short-circuit on identity
      // presence. The shadow `successorByUnit` holds the variant's OWN
      // current contribution for this keyName+unit; a legacy amount-bearing
      // clear (e.g. `cabbage||1.5 medium head`) must not hide a merged line
      // that includes an unclaimed portion (4 medium heads). Prefer the
      // amount check, and fall back to identity presence only when no shadow
      // claim exists (the legacy/legacy-V1 shape has no shadow amount).
      const keyParsed = parseQuantity(basis)
      // The lookup key prefers the line's own unit (the clear-time basis),
      // because the shadow bucket is indexed by the contributor's keyName+unit
      // — which is the line's unit when the claim is fully matched.
      const claim = successorByUnit.get(`${name}||u:${unitKey(branchParsed.unit)}`)
      if (claim !== undefined) {
        return (
          formatAmount(claim.sum) === formatAmount(keyParsed ? keyParsed.amount : branchParsed.amount) &&
          claim.claims >= 1
        )
      }
      // No shadow claim for this unit (exact legacy shape or approx-only):
      // fall back to identity presence. Kody's residual is resolved here —
      // the short-circuit above is unreachable when a shadow line exists.
      if (keyParsed) {
        const claimByBasis = successorByUnit.get(`${name}||u:${unitKey(keyParsed.unit)}`)
        if (claimByBasis !== undefined) {
          return formatAmount(claimByBasis.sum) === formatAmount(keyParsed.amount)
        }
      }
      // Approx (legacy) unit-bearing claims carry an advisory amount; compare
      // it against the merged key amount instead of matching by identity
      // alone (a legacy `milk||1cup` must not hide a `3 cup` merge). Unitless
      // claims leave successorAmounts unset and fall through to identity.
      const approx = successorAmounts.get(`${name}||u:${unitKey(branchParsed.unit)}`)
      if (approx !== undefined) {
        const target = keyParsed ? keyParsed.amount : branchParsed.amount
        return formatAmount(approx) === formatAmount(target)
      }
      return successorIdentities.has(`${name}||u:${unitKey(branchParsed.unit)}`)
    }
    // Raw branch: the display never parses. The line's key basis is the
    // parsed-grammar spelling when the key source parsed (possibly
    // re-namespaced under `raw||` after a dedup collision), else the
    // verbatim `raw||` content — either spelling matches its claim.
    const content = basis.startsWith('raw||') ? basis.slice('raw||'.length) : basis
    return (
      successorRawParsed.get(name)?.has(content) === true ||
      successorRawVerbatim.get(name)?.has(content) === true
    )
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
