/**
 * Dietary restrictions: the runtime half of the restriction pipeline — ADR.
 *
 * The heavy lifting happened at BUILD time (scripts/build_restriction_sets.py,
 * over the live archive `archive_catalog_profiles.py --restrictions`):
 * upstream's OWN restricted rendering of every changed doc is committed in
 * `data/restriction_overlays/<slug>.json`, keyed by the stable `recipe_id`.
 * Upstream's mechanism (measured live): a restriction REMOVES recipes
 * outright (a strict subset — `removed`), and surviving recipes keep their
 * structure while ingredient names — and occasionally a step's prose — are
 * swapped to restriction-safe substitutes, chosen per recipe by upstream.
 * None of that is re-derived here: the runtime only SELECTS and DISPLAYS.
 *
 * THE KEY/DISPLAY SPLIT (the load-bearing rule of this module):
 * the overlay is DISPLAY truth only. Every persisted or derived key — grocery
 * line keys, checked-state keys, cleared-ingredient keys — stays keyed by the
 * BASE doc's nameKey, so toggling a restriction can never orphan or uncheck a
 * saved item. Concretely: `restrictedDocView` (recipe detail, cooking view,
 * measured chips) replaces `line_items`/`instructions` wholesale, while
 * `groceryDisplayLines` builds the grocery's display rows so a row's (name,
 * quantity) pair ALWAYS co-occurs in one authoritative doc (the overlay, or
 * the base where the overlay has no counterpart) — never a cross-pair of base
 * quantity under an overlay name.
 *
 * WHY NOT POSITIONAL-ONLY: upstream's rework can REORDER lines within a
 * reworked doc (measured live: GF rid 224 swaps its pasta and garlic lines),
 * so pairing names by position alone once displayed `6 cloves gluten-free
 * fettuccine pasta` — a pair that appears in NEITHER doc. The pairing below
 * matches by nameKey first (the same ingredient wherever it moved), falls
 * back positionally on the leftovers, and keeps unpaired base lines verbatim.
 *
 * Pure lib: no Vue, no Pinia, no fetch at module scope. The one async piece
 * (`loadOverlay`) takes the fetch + base URL as parameters so bun-test can
 * exercise it without an environment.
 */

import { nameKey, type RestrictedDisplayLine } from './grocery'
import type { LineItem, RecipeDoc, RecipeInstruction } from './types'

/* ---------- The control plane (committed artifact) ---------- */

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

/** `data/restriction_sets.json` (scripts/build_restriction_sets.py). */
export interface RestrictionSetInfo {
  slug: string
  label: string
  /** Sorted recipe ids the restriction removes from the catalog. */
  removed: number[]
  overlay: string
  swapped_docs: number
}

export interface RestrictionSetsFile {
  generated_at: string
  restrictions: Record<string, RestrictionSetInfo>
}

/** `data/restriction_overlays/<slug>.json`. */
export interface OverlayLineItem {
  quantity: string
  ingredient_name: string
}

export interface OverlayDoc {
  line_items: OverlayLineItem[]
  instructions: RecipeInstruction[]
}

export interface RestrictionOverlay {
  slug: string
  docs: Record<string, OverlayDoc>
}

export type OverlaysBySlug = Partial<Record<string, RestrictionOverlay>>

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

/* ---------- O(1) lookups, built once per load ---------- */

export interface RestrictionIndex {
  /** slug -> the recipe ids it removes */
  removedBySlug: Map<string, Set<number>>
  /** id -> slug for the ACTIVE ids fast path */
  slugById: Map<number, string>
}

export function buildRestrictionIndex(sets: RestrictionSetsFile | null | undefined): RestrictionIndex {
  const removedBySlug = new Map<string, Set<number>>()
  if (sets) {
    for (const info of Object.values(sets.restrictions)) {
      removedBySlug.set(info.slug, new Set(info.removed))
    }
  }
  return { removedBySlug, slugById: SLUG_BY_ID }
}

/** Is this recipe removed from the catalog under the given active ids? */
export function isRemovedByRestriction(
  recipeId: number,
  activeIds: number[],
  index: RestrictionIndex,
): boolean {
  return activeIds.some((id) => index.removedBySlug.get(SLUG_BY_ID.get(id) ?? '')?.has(recipeId) ?? false)
}

/**
 * The reworked doc slice for this recipe under the given active ids, or null.
 *
 * When SEVERAL active restrictions rework the same doc (upstream composes
 * restrictions inside one render; we archive only the twelve singles), the
 * smallest id wins — a deterministic, documented default, not an attempt to
 * synthesize the composition upstream would render.
 */
export function overlayDocFor(
  recipeId: number,
  activeIds: number[],
  overlays: OverlaysBySlug,
): OverlayDoc | null {
  for (const id of [...activeIds].sort((a, b) => a - b)) {
    const overlay = overlays[SLUG_BY_ID.get(id) ?? '']
    const doc = overlay?.docs[String(recipeId)]
    if (doc) return doc
  }
  return null
}

/* ---------- The restricted doc view (display truth) ---------- */

/**
 * Pair overlay rows to base rows by INDEX: pass 1 matches the SAME nameKey
 * (the same ingredient wherever upstream moved it), pass 2 pairs the
 * leftover overlay rows positionally with the leftover base rows in order.
 * The return is per-overlay-row: the paired base row's index, or -1 when the
 * overlay row has no base counterpart (a split's extra line).
 */
function pairOverlayToBase(baseKeys: readonly string[], ovKeys: readonly string[]): number[] {
  const usedBase = new Set<number>()
  const pairOf = new Array<number>(ovKeys.length).fill(-1)
  for (let i = 0; i < ovKeys.length; i++) {
    if (!ovKeys[i]) continue
    const j = baseKeys.findIndex((k, idx) => !usedBase.has(idx) && k === ovKeys[i])
    if (j !== -1) {
      pairOf[i] = j
      usedBase.add(j)
    }
  }
  const leftover = baseKeys.map((_, j) => j).filter((j) => !usedBase.has(j))
  let next = 0
  for (let i = 0; i < ovKeys.length; i++) {
    if (pairOf[i] !== -1 || next >= leftover.length) continue
    pairOf[i] = leftover[next]
    usedBase.add(leftover[next])
    next += 1
  }
  return pairOf
}

/**
 * The recipe doc as it displays under the active restrictions: the overlay's
 * `line_items` + `instructions` replace the base's wholesale (upstream's own
 * restricted rendering, quantities verbatim); everything else stays from the
 * base. `null` overlay returns the base doc unchanged.
 *
 * Overlay line items carry no `id` (the overlay is keyed by recipe, not by
 * line). The view synthesizes one from the BASE doc: positionally when the
 * count AND per-index quantities agree (the safe case), else by pairing the
 * ingredient to the base line it belongs to (nameKey match first, then
 * positional among the leftovers), with a negative index for an overlay line
 * that has no base counterpart.
 */
export function restrictedDocView(doc: RecipeDoc, overlay: OverlayDoc | null): RecipeDoc {
  if (!overlay) return doc
  const baseIds = doc.line_items.map((li) => li.id)
  // Upstream's rework can REORDER lines within a reworked doc (measured live:
  // GF rid 224 swaps its pasta and garlic lines), so the base line ids are
  // only trustworthy positionally when BOTH the count and the per-index
  // quantity agree — the same safe-positional test the grocery seam uses.
  // Otherwise each base id follows the ingredient it belongs to (nameKey
  // match first, positional among the leftovers), so a measured chip and the
  // line naming it stay the same ingredient — never base quantity with an
  // overlay name.
  const positional =
    overlay.line_items.length === baseIds.length &&
    overlay.line_items.every(
      (li, i) => li.quantity.trim() === doc.line_items[i].quantity.trim(),
    )
  const pairOf = positional
    ? overlay.line_items.map((_, i) => (i < baseIds.length ? i : -1))
    : pairOverlayToBase(
        doc.line_items.map((li) => nameKey(li.ingredient_name)),
        overlay.line_items.map((li) => nameKey(li.ingredient_name)),
      )
  const line_items: LineItem[] = overlay.line_items.map((li, i) => ({
    id: pairOf[i] === -1 ? -(i + 1) : baseIds[pairOf[i]],
    quantity: li.quantity,
    ingredient_name: li.ingredient_name,
  }))
  return { ...doc, line_items, instructions: overlay.instructions }
}

/* ---------- The grocery seam (keys stay base, display follows the overlay) ---------- */

/**
 * The grocery's display rows for this recipe, or null when the base doc
 * should render as-is.
 *
 * THE SAFE POSITIONAL CASE — overlay line count == base line count AND every
 * index's quantity string is equal (or both empty): base line i and overlay
 * line i are the same ingredient, so the row keys on the BASE nameKey,
 * displays the overlay's name and the (identical) quantity. Unchanged names
 * return null — no override, byte-identical to the base render.
 *
 * THE MISMATCH CLASS — anything else (a reorder, a substituted-away line that
 * collapsed two lines into one, a split): names are NOT overridden
 * positionally. The overlay's OWN line list is displayed instead — the
 * overlay is metric, so its quantities are correct — while each row's key
 * stays a BASE doc nameKey: pass 1 pairs overlay rows to base rows with the
 * SAME nameKey (the same ingredient wherever it moved), pass 2 pairs the
 * leftovers positionally in order, and an overlay row with no base
 * counterpart (a split's extra line) keys to itself. A base line with no
 * overlay counterpart (a collapse) is appended verbatim.
 *
 * The invariant this preserves: a grocery row's (name, quantity) pair always
 * co-occurs in ONE authoritative doc — never `6 cloves gluten-free fettuccine
 * pasta`, which appears in neither.
 */
export function groceryDisplayLines(
  doc: RecipeDoc,
  overlay: OverlayDoc | null,
): RestrictedDisplayLine[] | null {
  if (!overlay) return null
  const base = doc.line_items
  const ov = overlay.line_items
  if (
    ov.length === base.length &&
    ov.every((li, i) => li.quantity.trim() === base[i].quantity.trim())
  ) {
    let changed = false
    const rows = ov.map((li, i) => {
      if (li.ingredient_name !== base[i].ingredient_name) changed = true
      return { keyName: nameKey(base[i].ingredient_name), name: li.ingredient_name, quantity: base[i].quantity }
    })
    return changed ? rows : null
  }

  const baseKeys = base.map((li) => nameKey(li.ingredient_name))
  const ovKeys = ov.map((li) => nameKey(li.ingredient_name))
  const pairOf = pairOverlayToBase(baseKeys, ovKeys)
  const rows = ov.map((li, i) => {
    const j = pairOf[i]
    if (j === -1) {
      // An overlay row with no base counterpart keys to itself.
      return { keyName: ovKeys[i], name: li.ingredient_name, quantity: li.quantity }
    }
    const keyQuantity =
      base[j].quantity.trim() === li.quantity.trim() ? undefined : base[j].quantity
    return { keyName: baseKeys[j], name: li.ingredient_name, quantity: li.quantity, keyQuantity }
  })
  // Base lines with no overlay counterpart keep the base text verbatim.
  const usedBase = new Set(pairOf.filter((j) => j !== -1))
  for (let j = 0; j < base.length; j++) {
    if (!usedBase.has(j)) {
      rows.push({ keyName: baseKeys[j], name: base[j].ingredient_name, quantity: base[j].quantity })
    }
  }
  return rows
}

/* ---------- Overlay loading (lazy, per active slug) ---------- */

/**
 * Fetch one slug's overlay, cached. `fetchImpl` and `baseUrl` are injected so
 * tests run without a browser environment. A failed fetch resolves null —
 * a missing overlay DEGRADES to the base doc (the feature is display
 * enrichment; it must never take the catalog down), and is retried on the
 * next call.
 */
export function createOverlayLoader(
  fetchImpl: typeof fetch,
  baseUrl: string,
): (slug: string) => Promise<RestrictionOverlay | null> {
  const cache = new Map<string, Promise<RestrictionOverlay | null>>()
  return (slug) => {
    let p = cache.get(slug)
    if (!p) {
      p = fetchImpl(`${baseUrl}data/restriction_overlays/${slug}.json`).then(
        async (res) => {
          if (!res.ok) {
            // A failed fetch is NOT cached: the next call retries.
            cache.delete(slug)
            return null
          }
          return (await res.json()) as RestrictionOverlay
        },
        () => {
          cache.delete(slug)
          return null
        },
      )
      cache.set(slug, p)
    }
    return p
  }
}
