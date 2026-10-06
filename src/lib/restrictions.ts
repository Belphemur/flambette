/**
 * Dietary restrictions: the runtime half of the restriction pipeline — ADR.
 *
 * The runtime consumes ONE committed artifact: `data/restriction_dict.json`
 * (built by `scripts/build_restriction_dict.py`). Per restriction id the
 * dictionary carries:
 *
 *   * removed — the recipes upstream drops for that restriction (recipe ids)
 *   * pairRemoved — per two-restriction pair, the EXTRA recipes the pair removes
 *     that NEITHER single removes (the composition extras, recipe ids)
 *   * swaps — per (from -> to) ingredient pair, the quantity rule upstream
 *     applied and how many events back it
 *
 * The runtime does NOT compose or hardcode substitutions — it reads the
 * dictionary. Nothing per-recipe ships in the app (the per-recipe overlay
 * dumps of ADR-0056 option B were deleted).
 *
 * THE KEY/DISPLAY SPLIT (the load-bearing rule of this module):
 * the swap is DISPLAY truth only. Every persisted or derived key — grocery
 * line keys, checked-state keys, cleared-ingredient keys — stays keyed by the
 * BASE doc's nameKey, so toggling a restriction can never orphan or uncheck a
 * saved item. Concretely: `restrictedDocView` (recipe detail, cooking view,
 * measured chips) applies swaps to `line_items` in place (display names
 * change, quantities stay verbatim, ids stay base), while `groceryDisplayLines`
 * builds the grocery's display rows so a row's (name, quantity) pair ALWAYS
 * co-occurs in one authoritative doc (the base doc, possibly with a swap on
 * the name) — never a cross-pair of base quantity under a substitute name.
 *
 * WHY SWAPS ARE NAME-BASED: upstream's rework can REORDER lines within a doc,
 * so pairing by position alone once displayed `6 cloves gluten-free fettuccine
 * pasta` — a pair in NEITHER doc. A swap table keys on the ingredient NAME:
 * the substitute is the display, the base nameKey is the key, and the pairing
 * is trivial (it CAN'T go wrong because the substitute name is NEVER checked
 * state).
 *
 * Pure lib: no Vue, no Pinia, no fetch at module scope. The one async piece
 * (`loadRestrictionDict`) takes the fetch + base URL as parameters so bun-test
 * can exercise it without an environment.
 */

import { nameKey, type RestrictedDisplayLine } from './grocery'
import type { LineItem, RecipeDoc } from './types'

/* ---------- The dictionary artifact (committed) ---------- */

export interface SwapEntry {
  from: string
  to: string
  quantityRule: string
  count: number
}

export interface RestrictionDictEntry {
  removed: number[]
  pairRemoved: Record<string, number[]>
  swaps: SwapEntry[]
}

export type RestrictionDict = Record<string, RestrictionDictEntry>

export interface SwapIndex {
  /** nameKey -> the swap entry (across all restrictions; first match wins). */
  byNameKey: Map<string, SwapEntry>
}

export interface DictIndex {
  /** The committed dictionary (nullable when the artifact is absent). */
  dict: RestrictionDict | null | undefined
  /** nameKey -> swap entry across all restrictions. */
  swaps: SwapIndex
}

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

export interface RestrictionEntry {
  id: number
  slug: string
  label: string
}

/**
 * Display order (the Settings selector reads this array in order):
 * allergens first, lifestyle-relevant nightshades last. Ids are upstream's
 * (live-verified 2026-10-06; 7 and 8 exist upstream but are unused).
 */
export const RESTRICTIONS: RestrictionEntry[] = [
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

/* ---------- O(1) lookups, built once per load ---------- */

/**
 * Build the runtime index from the committed dictionary. The dict is stored
 * in the index so `isRemovedByRestriction` can filter by ACTIVE ids at query
 * time (a recipe removed by an INACTIVE restriction must not be removed).
 */
export function buildDictIndex(dict: RestrictionDict | null | undefined): DictIndex {
  const byNameKey = new Map<string, SwapEntry>()
  if (dict) {
    for (const entry of Object.values(dict)) {
      for (const swap of entry.swaps) {
        const key = nameKey(swap.from)
        // Keep the FIRST swap for a nameKey — the dictionary is sorted by
        // count desc per restriction; the first restriction to claim a
        // nameKey wins because RESTRICTIONS order gives the allergen-first
        // pass.
        if (!byNameKey.has(key)) {
          byNameKey.set(key, swap)
        }
      }
    }
  }
  return { dict, swaps: { byNameKey } }
}

/**
 * Is this recipe removed from the catalog under the given active ids?
 *
 * A recipe is removed if ANY active restriction lists it in `removed`, or if
 * ANY active pair lists it in `pairRemoved` (the composition extras — a recipe
 * removed by the PAIR but by NEITHER single).
 */
export function isRemovedByRestriction(
  recipeId: number,
  activeIds: number[],
  index: DictIndex,
): boolean {
  if (activeIds.length === 0 || !index.dict) return false
  for (const id of activeIds) {
    const entry = index.dict[String(id)]
    if (!entry) continue
    if (entry.removed.includes(recipeId)) return true
    for (const [pairKey, rids] of Object.entries(entry.pairRemoved)) {
      const [aStr, bStr] = pairKey.split(',')
      const a = parseInt(aStr)
      const b = parseInt(bStr)
      if (activeIds.includes(a) && activeIds.includes(b) && rids.includes(recipeId)) return true
    }
  }
  return false
}

/* ---------- Dictionary application (display truth) ---------- */

/**
 * Apply the dictionary swap to a display name when an active swap matches this
 * nameKey. Returns the substitute name when a swap applies, otherwise the
 * original name unchanged. The quantity stays VERBATIM from the base doc —
 * measured: 99.8% of upstream swaps keep the base quantity string (verbatim),
 * 0.1% rescale (same unit, doubled), 0.1% re-author. The runtime never invents
 * a quantity: no swap entry means no change.
 */
export function swapName(name: string, index: DictIndex): string {
  const swap = index.swaps.byNameKey.get(nameKey(name))
  return swap ? swap.to : name
}

/**
 * The recipe doc as it displays under the active restrictions: swaps are
 * applied to each line item's ingredient_name (nameKey match); the base
 * quantity string stays verbatim; ids stay the base ids. Recipe prose (step
 * instructions) stays AUTHENTIC — substitution only applies to ingredient
 * names in line items (ADR-0022). `null` index returns the base doc unchanged.
 */
export function restrictedDocView(
  doc: RecipeDoc,
  index: DictIndex | null | undefined,
): RecipeDoc {
  if (!index || !index.dict || index.swaps.byNameKey.size === 0) return doc
  const line_items: LineItem[] = doc.line_items.map((li) => ({
    ...li,
    ingredient_name: swapName(li.ingredient_name, index),
  }))
  return { ...doc, line_items }
}

/* ---------- The grocery seam (keys stay base, display follows the swap) ---------- */

/**
 * The grocery's display rows for this recipe, or null when the base doc
 * should render as-is (no active swaps — every row's name matches its key).
 *
 * Every row's (name, quantity) pair co-occurs in the BASE doc: display is
 * the substitute name (when a swap applies), quantity is the base doc's
 * verbatim string, keyName is the base doc's nameKey. A display row is never
 * a cross-pair of base quantity under a substitute name — that was the option-B
 * bug, eliminated by the swap table (each line's key and display are one
 * ingredient).
 */
export function groceryDisplayLines(
  doc: RecipeDoc,
  index: DictIndex | null | undefined,
): RestrictedDisplayLine[] | null {
  if (!index || !index.dict || index.swaps.byNameKey.size === 0) return null
  let changed = false
  const rows = doc.line_items.map((li) => {
    const swapped = swapName(li.ingredient_name, index)
    if (swapped !== li.ingredient_name) changed = true
    return {
      keyName: nameKey(li.ingredient_name),
      name: swapped,
      quantity: li.quantity,
      keyIngredient: li.ingredient_name,
    }
  })
  return changed ? rows : null
}

/* ---------- Dictionary loading (lazy, per active set) ---------- */

/**
 * Fetch the committed dictionary, cached. `fetchImpl` and `baseUrl` are
 * injected so tests run without a browser environment. A failed fetch
 * resolves null — a missing dictionary DEGRADES to the base doc (the feature
 * is display enrichment; it must never take the catalog down), and is retried
 * on the next call.
 */
export function loadRestrictionDict(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<RestrictionDict | null> {
  return fetchImpl(`${baseUrl}data/restriction_dict.json`).then(
    async (res) => {
      if (!res.ok) {
        return null
      }
      return (await res.json()) as RestrictionDict
    },
    () => null,
  )
}
