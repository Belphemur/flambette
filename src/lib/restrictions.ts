/**
 * Dietary restrictions: the runtime half of the restriction pipeline — ADR-0059.
 *
 * The runtime consumes a SPLIT TREE under `public/data/restrictions/`:
 *
 *   * index.json       ~2 KB   the 12 entries {id, slug, label} + the pair file list — loaded ALWAYS
 *   * swaps.json       ~8 KB   the from→to entries with quantityRule + the drops lists — loaded when ANY restriction is active
 *   * removed/<slug>.json ~4 KB ×12  one restriction's removed recipe ids — loaded when THAT chip activates
 *   * pairs/<a>-<b>.json  ~1 KB ×66  ONLY the composition extras (the 918 ids partitioned by pair) — loaded when THAT PAIR is active
 *
 * The ladder: `loadIndex`, `ensureSwaps`, `ensureRemoved(slug)`, `ensurePair(a, b)` —
 * each cached, retryable, injectable fetch (the tests inject fakes).
 * `isRemovedByRestriction` consults the loaded union (from removed/*) + pair extras
 * (from pairs/*); `swapName` consults swaps only when loaded (pre-load behaviour:
 * identity — no restriction is "active-looking" until its data arrives; the existing
 * aria/loading semantics are kept).
 *
 * Pure lib: no Vue, no Pinia, no fetch at module scope. The async pieces
 * (loadIndex, ensureSwaps, ensureRemoved, ensurePair) take the fetch + base URL
 * as parameters so bun-test can exercise them without an environment.
 *
 * THE KEY/DISPLAY SPLIT (the load-bearing rule of this module):
 * the swap is DISPLAY truth only. Every persisted or derived key — grocery
 * line keys, checked-state keys, cleared-ingredient keys — stays keyed by the
 * BASE doc's nameKey, so toggling a restriction can never orphan or uncheck a
 * saved item. Concretely: `restrictedDocView` applies swaps to `line_items` in
 * place (display names change, quantities stay verbatim, ids stay base), while
 * `groceryDisplayLines` builds the grocery's display rows so a row's (name,
 * quantity) pair ALWAYS co-occurs in one authoritative doc (the base doc,
 * possibly with a swap on the name) — never a cross-pair of base quantity under
 * a substitute name.
 *
 * WHY SWAPS ARE NAME-BASED: upstream's rework can REORDER lines within a doc,
 * so pairing by position alone once displayed `6 cloves gluten-free fettuccine
 * pasta` — a pair in NEITHER doc. A swap table keys on the ingredient NAME:
 * the substitute is the display, the base nameKey is the key, and the pairing
 * is trivial (it CAN'T go wrong because the substitute name is NEVER checked
 * state).
 */

import { nameKey, type RestrictedDisplayLine } from './grocery'
import type { LineItem, RecipeDoc } from './types'

/* ---------- The split-tree artifact contracts ---------- */

export interface SwapEntry {
  from: string
  to: string
  quantityRule: string
  count: number
}

export interface DropEntry {
  from: string
  count: number
}

/** One restriction entry from index.json: {id, slug, label}. */
export interface RestrictionEntry {
  id: number
  slug: string
  label: string
}

/** The committed split tree, loaded by the ladder. */
export interface LadderIndex {
  /** The 12 entries from index.json (or the lib's RESTRICTIONS constant). */
  restrictions: RestrictionEntry[]
  /** From→to entries from swaps.json (null until ensureSwaps loads it). */
  swaps: SwapEntry[] | null
  /** Drops entries from swaps.json (null until ensureSwaps loads it). */
  drops: DropEntry[] | null
  /** slug → removed recipe ids (from removed/<slug>.json). Filled per chip activation. */
  removed: Map<string, number[]>
  /** pairKey (a-b) → composition extras (from pairs/<a>-<b>.json). Filled per pair activation. */
  pairs: Map<string, number[]>
}

// Constants must be defined before buildLadderIndex (TDZ-safe ordering).


/** Build an empty LadderIndex from the lib's RESTRICTIONS constant (cold start). */
export function buildLadderIndex(): LadderIndex {
  return {
    restrictions: RESTRICTIONS.map((r) => ({ id: r.id, slug: r.slug, label: r.label })),
    swaps: null,
    drops: null,
    removed: new Map(),
    pairs: new Map(),
  }
}

/**
 * Load index.json via `fetchImpl`. Cached, retryable, injectable.
 * A failed fetch resolves null — index.json ships in the bundle, so a failure
 * is a build problem; the caller should never see null in practice.
 */
export async function loadIndex(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<LadderIndex | null> {
  const res = await fetchImpl(`${baseUrl}data/restrictions/index.json`).catch(() => null)
  if (!res || !res.ok) return null
  const doc = (await res.json()) as { restrictions: RestrictionEntry[]; pairs: string[] }
  return {
    restrictions: doc.restrictions,
    swaps: null,
    drops: null,
    removed: new Map(),
    pairs: new Map(),
  }
}

/**
 * Ensure swaps.json is loaded into the index. Cached (no-op if already loaded).
 * A failed fetch leaves swaps as null (identity display) + is retried on the
 * next call.
 */
export async function ensureSwaps(
  index: LadderIndex,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<void> {
  if (index.swaps !== null || index.drops !== null) return
  const res = await fetchImpl(`${baseUrl}data/restrictions/swaps.json`).catch(() => null)
  if (!res || !res.ok) return
  const doc = (await res.json()) as { swaps: SwapEntry[]; drops: DropEntry[] }
  index.swaps = doc.swaps
  index.drops = doc.drops
}

/**
 * Ensure removed/<slug>.json is loaded into the index. Cached (no-op if already loaded).
 * A failed fetch leaves this slug's removed set as an empty list (identity display
 * for that chip) + is retried on the next call.
 */
export async function ensureRemoved(
  slug: string,
  index: LadderIndex,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<void> {
  if (index.removed.has(slug)) return
  const res = await fetchImpl(`${baseUrl}data/restrictions/removed/${slug}.json`).catch(() => null)
  if (!res || !res.ok) {
    index.removed.set(slug, [])
    return
  }
  const doc = (await res.json()) as { removed: number[] }
  index.removed.set(slug, doc.removed ?? [])
}

/**
 * Ensure pairs/<a>-<b>.json is loaded into the index. Cached (no-op if already loaded).
 * The pairKey uses canonical ordering (a < b by slug string comparison).
 * A failed fetch leaves this pair's extras as an empty list + is retried on the next call.
 */
export async function ensurePair(
  a: string,
  b: string,
  index: LadderIndex,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<void> {
  const pairKey = a < b ? `${a}-${b}` : `${b}-${a}`
  if (index.pairs.has(pairKey)) return
  const res = await fetchImpl(`${baseUrl}data/restrictions/pairs/${pairKey}.json`).catch(() => null)
  if (!res || !res.ok) {
    index.pairs.set(pairKey, [])
    return
  }
  const doc = (await res.json()) as { extras: number[] }
  index.pairs.set(pairKey, doc.extras ?? [])
}

/* ---------- Query-time consultation ---------- */

/**
 * Is this recipe removed by an active restriction?
 *
 * A recipe is removed if ANY active restriction's removed/<slug>.json lists it,
 * or if ANY active pair's pairs/<a>-<b>.json lists it (the composition extras —
 * removed by the PAIR but by NEITHER single).
 *
 * The union of all active restrictions' removed sets + the union of all active
 * pairs' extras. If swaps/drops have not arrived yet (pre-load), removal is
 * still computed from loaded removed/* and pairs/* data (those load first in
 * the ladder). If neither has arrived, returns false.
 */
export function isRemovedByRestriction(
  recipeId: number,
  activeIds: number[],
  index: LadderIndex,
): boolean {
  if (activeIds.length === 0) return false
  // Check removed sets from loaded removed/<slug>.json files
  for (const id of activeIds) {
    const entry = index.restrictions.find((r) => r.id === id)
    if (!entry) continue
    const removed = index.removed.get(entry.slug)
    if (removed && removed.includes(recipeId)) return true
  }
  // Check pair extras from loaded pairs/<a>-<b>.json files
  // (only pairs where BOTH members are active)
  for (let i = 0; i < activeIds.length; i++) {
    const aEntry = index.restrictions.find((r) => r.id === activeIds[i])
    if (!aEntry) continue
    for (let j = i + 1; j < activeIds.length; j++) {
      const bEntry = index.restrictions.find((r) => r.id === activeIds[j])
      if (!bEntry) continue
      const pairKey = aEntry.slug < bEntry.slug
        ? `${aEntry.slug}-${bEntry.slug}`
        : `${bEntry.slug}-${aEntry.slug}`
      const extras = index.pairs.get(pairKey)
      if (extras && extras.includes(recipeId)) return true
    }
  }
  return false
}

/* ---------- Dictionary application (display truth) ---------- */

/**
 * Build the union of drop nameKeys across the given active ids from the index.
 * Drops come from swaps.json (loaded when any chip is active). If swaps haven't
 * loaded yet, returns an empty set (pre-load: no drops visible). Drops apply
 * only when at least one restriction is active.
 */
export function activeDrops(activeIds: number[], index: LadderIndex): Set<string> {
  const out = new Set<string>()
  if (activeIds.length === 0 || !index.drops) return out
  for (const drop of index.drops) {
    out.add(nameKey(drop.from))
  }
  return out
}

/**
 * Is this nameKey in the drops set (union across all loaded drops)?
 * Drops are ingredients that DISAPPEAR in kept recipes under a restriction
 * with NO swap counterpart. Used for display-only hiding.
 */
export function isDropName(name: string, drops: Set<string>): boolean {
  return drops.has(nameKey(name))
}

/**
 * Apply the swap to a display name when a swap matches this nameKey.
 * Returns the substitute name when a swap applies, otherwise the original
 * name unchanged. swapName consults swaps.json ONLY when it has loaded
 * (pre-load behaviour: identity — no restriction is "active-looking" until
 * its data arrives; the existing aria/loading semantics are kept).
 */
export function swapName(name: string, index: LadderIndex): string {
  if (!index.swaps) return name
  const swap = index.swaps.find((s) => s.from === name || s.from === nameKey(name))
  return swap ? swap.to : name
}

/**
 * The recipe doc as it displays under the active restrictions: swaps are
 * applied to each line item's ingredient_name (nameKey match); the base
 * quantity string stays verbatim; ids stay the base ids. Recipe prose (step
 * instructions) stays AUTHENTIC — substitution only applies to ingredient
 * names in line items (ADR-0022). A line whose nameKey is in the drops set
 * (no swap counterpart under any active restriction) is HIDDEN from display
 * only; the key/checked state is UNTOUCHED. `null` index returns the base doc
 * unchanged. No swaps loaded yet = identity (pre-load behaviour).
 */
export function restrictedDocView(
  doc: RecipeDoc,
  index: LadderIndex | null | undefined,
  activeIds: number[],
): RecipeDoc {
  if (!index) return doc
  if (!index.swaps || index.swaps.length === 0) return doc
  const drops = activeDrops(activeIds, index)
  if (drops.size === 0 && index.swaps.length === 0) return doc
  const line_items: LineItem[] = []
  for (const li of doc.line_items) {
    const lk = nameKey(li.ingredient_name)
    const swap = index.swaps.find((s) => nameKey(s.from) === lk)
    if (swap) {
      // Swap applies: substitute the display name, keep everything else.
      line_items.push({ ...li, ingredient_name: swap.to })
    } else if (drops.has(lk)) {
      // Drop: hide this line from display only — key/checked state untouched.
      continue
    } else {
      line_items.push({ ...li })
    }
  }
  return { ...doc, line_items }
}

/**
 * The grocery's display rows for this recipe, or null when the base doc
 * should render as-is (no active swaps and no active drops — every row's
 * (name, quantity) pair ALWAYS co-occurs in one authoritative doc (the base
 * doc, possibly with a swap on the name) — never a cross-pair of base
 * quantity under a substitute name). No swaps loaded yet = null (pre-load:
 * base doc renders as-is).
 */
export function groceryDisplayLines(
  doc: RecipeDoc,
  index: LadderIndex | null | undefined,
  activeIds: number[],
): RestrictedDisplayLine[] | null {
  if (!index) return null
  if (!index.swaps || index.swaps.length === 0) return null
  const drops = activeDrops(activeIds, index)
  if (drops.size === 0 && index.swaps.length === 0) return null
  let changed = false
  const rows: RestrictedDisplayLine[] = []
  for (const li of doc.line_items) {
    const lk = nameKey(li.ingredient_name)
    const swap = index.swaps!.find((s) => nameKey(s.from) === lk)
    if (swap) {
      changed = true
      rows.push({
        keyName: lk,
        name: swap.to,
        quantity: li.quantity,
        keyIngredient: li.ingredient_name,
      })
    } else if (drops.has(lk)) {
      changed = true
      continue
    } else {
      rows.push({
        keyName: lk,
        name: li.ingredient_name,
        quantity: li.quantity,
        keyIngredient: li.ingredient_name,
      })
    }
  }
  return changed ? rows : null
}

/* ---------- Constants ---------- */

export interface RestrictionEntryFull {
  id: number
  slug: string
  label: string
}

/**
 * Display order (the Settings selector reads this array in order):
 * allergens first, lifestyle-relevant nightshades last. Ids are upstream's
 * (live-verified 2026-10-06; 7 and 8 exist upstream but are unused).
 */
export const RESTRICTIONS: RestrictionEntryFull[] = [
  { id: 4, slug: 'shellfish-free', label: 'Shellfish-Free' },
  { id: 3, slug: 'fish-free', label: 'Fish-Free' },
  { id: 1, slug: 'gluten-free', label: 'Gluten-Free' },
  { id: 2, slug: 'dairy-free', label: 'Dairy-Free' },
  { id: 5, slug: 'peanut-free', label: 'Peanut-Free' },
  { id: 6, slug: 'tree-nut-free', label: 'Tree Nut-Free' },
  { id: 9, slug: 'soy-free', label: 'Soy-Free' },
  { id: 11, slug: 'egg-free', label: 'Egg-Free' },
  { id: 12, slug: 'sesame-free', label: 'Sesame-Free' },
  { id: 13, slug: 'mustard-free', label: 'Mustard-Free' },
  { id: 14, slug: 'sulfite-free', label: 'Sulfite-Free' },
  { id: 10, slug: 'nightshade-free', label: 'Nightshade-Free' },
]

const KNOWN_IDS = new Set(RESTRICTIONS.map((r) => r.id))
export const SLUG_BY_ID = new Map(RESTRICTIONS.map((r) => [r.id, r.slug]))

/**
 * Every inbound restriction-id list (backup import, a future room payload,
 * hand-edited localStorage) passes through here: unknown ids dropped, dupes
 * collapsed, ascending sort. Same discipline as `normalizeQuickFilters`.
 */
export function normalizeRestrictionIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out = new Set<number>()
  for (const v of raw) {
    if (typeof v === 'number' && Number.isInteger(v) && KNOWN_IDS.has(v)) out.add(v)
    // String digits come from forms and URLs; a numeric string of a KNOWN id
    // is accepted, everything else is dropped.
    else if (typeof v === 'string' && /^\d+$/.test(v) && KNOWN_IDS.has(Number(v))) out.add(Number(v))
  }
  return [...out].sort((a, b) => a - b)
}
