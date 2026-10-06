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

export interface DropEntry {
  from: string
  count: number
}

export interface RestrictionDictEntry {
  removed: number[]
  pairRemoved: Record<string, number[]>
  swaps: SwapEntry[]
  drops: DropEntry[]
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
  /** rid -> set of nameKeys that DROP (no swap counterpart) under that restriction. */
  dropsByRestriction: Map<string, Set<string>>
  /** nameKey -> drop entry (across all restrictions; first match wins). */
  dropsByIndex: Map<string, DropEntry>
}

/** Compute the union of drop nameKeys across the given active ids from the index. */
export function activeDrops(activeIds: number[], index: DictIndex): Set<string> {
  const out = new Set<string>()
  if (!index.dict) return out
  for (const id of activeIds) {
    const perRestriction = index.dropsByRestriction.get(String(id))
    if (perRestriction) {
      for (const key of perRestriction) out.add(key)
    }
  }
  return out
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
  const dropsByRestriction = new Map<string, Set<string>>()
  const dropsByIndex = new Map<string, DropEntry>()
  if (dict) {
    for (const [rid_str, entry] of Object.entries(dict)) {
      const swapSet = new Set<string>()
      for (const s of entry.swaps ?? []) {
        const key = nameKey(s.from)
        // Keep the FIRST swap for a nameKey — the dictionary is sorted by
        // count desc per restriction; the first restriction to claim a
        // nameKey wins because RESTRICTIONS order gives the allergen-first
        // pass.
        if (!byNameKey.has(key)) {
          byNameKey.set(key, s)
        }
        swapSet.add(key)
      }
      const dropSet = new Set<string>()
      for (const drop of entry.drops ?? []) {
        const key = nameKey(drop.from)
        // Drops and swaps can overlap on the same from-ingredient (a swap
        // in some recipes, a drop in others). The swap wins at application
        // time; the drop is a second representation counted separately.
        if (!dropSet.has(key) && !swapSet.has(key)) {
          dropSet.add(key)
          if (!dropsByIndex.has(key)) {
            dropsByIndex.set(key, drop)
          }
        }
      }
      dropsByRestriction.set(rid_str, dropSet)
    }
  }
  return { dict, swaps: { byNameKey }, dropsByRestriction, dropsByIndex }
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
 * 0.1% rescale (same unit, doubled), 0.1% re-authored. The runtime never invents
 * a quantity: no swap entry means no change.
 */
export function swapName(name: string, index: DictIndex): string {
  const swap = index.swaps.byNameKey.get(nameKey(name))
  return swap ? swap.to : name
}

/**
 * Is this nameKey in the drops set for any of the active restrictions?
 * Drops are ingredients that DISAPPEAR in kept recipes under a restriction
 * with NO swap counterpart (e.g. crumbled feta cheese under DF). Used for
 * display-only hiding — keys and checked state are untouched.
 */
export function isDropName(name: string, drops: Set<string>): boolean {
  return drops.has(nameKey(name))
}

/**
 * The recipe doc as it displays under the active restrictions: swaps are
 * applied to each line item's ingredient_name (nameKey match); the base
 * quantity string stays verbatim; ids stay the base ids. Recipe prose (step
 * instructions) stays AUTHENTIC — substitution only applies to ingredient
 * names in line items (ADR-0022). A line whose nameKey is in the drops set
 * (no swap counterpart under any active restriction) is HIDDEN from display
 * only; the key/checked state is UNTOUCHED. `null` index returns the base doc
 * unchanged.
 */
export function restrictedDocView(
  doc: RecipeDoc,
  index: DictIndex | null | undefined,
  activeIds: number[],
): RecipeDoc {
  if (!index || !index.dict) return doc
  if (index.swaps.byNameKey.size === 0 && index.dropsByIndex.size === 0) return doc
  const drops = activeDrops(activeIds, index)
  const line_items: LineItem[] = []
  for (const li of doc.line_items) {
    const lk = nameKey(li.ingredient_name)
    const swap = index.swaps.byNameKey.get(lk)
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
 * quantity under a substitute name).
 *
 * A line whose nameKey is in the drops set (no swap counterpart under any
 * active restriction) is HIDDEN from display only; the key/checked state is
 * UNTOUCHED (un-hiding on toggle restores the row automatically — the key
 * never changed). A line whose nameKey has an active swap shows the
 * substitute name with the base doc's verbatim quantity.
 */
export function groceryDisplayLines(
  doc: RecipeDoc,
  index: DictIndex | null | undefined,
  activeIds: number[],
): RestrictedDisplayLine[] | null {
  if (!index || !index.dict) return null
  if (index.swaps.byNameKey.size === 0 && index.dropsByIndex.size === 0) return null
  const drops = activeDrops(activeIds, index)
  let changed = false
  const rows: RestrictedDisplayLine[] = []
  for (const li of doc.line_items) {
    const lk = nameKey(li.ingredient_name)
    const swap = index.swaps.byNameKey.get(lk)
    if (swap) {
      changed = true
      rows.push({
        keyName: lk,
        name: swap.to,
        quantity: li.quantity,
        keyIngredient: li.ingredient_name,
      })
    } else if (drops.has(lk)) {
      // Drop: hide from display only; key/checked state untouched.
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
