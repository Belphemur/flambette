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
 * `groceryDisplayNames` keeps the base line as the key/quantity basis and
 * overrides ONLY the group's display name, positionally.
 *
 * Pure lib: no Vue, no Pinia, no fetch at module scope. The one async piece
 * (`loadOverlay`) takes the fetch + base URL as parameters so bun-test can
 * exercise it without an environment.
 */

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
const SLUG_BY_ID = new Map(RESTRICTIONS.map((r) => [r.id, r.slug]))

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
 * The recipe doc as it displays under the active restrictions: the overlay's
 * `line_items` + `instructions` replace the base's wholesale (upstream's own
 * restricted rendering, quantities verbatim); everything else stays from the
 * base. `null` overlay returns the base doc unchanged.
 *
 * Overlay line items carry no `id` (the overlay is keyed by recipe, not by
 * line). The view synthesizes one from the BASE line positionally — line
 * order is stable across upstream's renders (measured: 99.91% positional
 * name agreement between the US and metric renders) — falling back to a
 * negative index for the rare reworked doc whose line count changed.
 */
export function restrictedDocView(doc: RecipeDoc, overlay: OverlayDoc | null): RecipeDoc {
  if (!overlay) return doc
  const baseIds = doc.line_items.map((li) => li.id)
  const line_items: LineItem[] = overlay.line_items.map((li, i) => ({
    id: i < baseIds.length ? baseIds[i] : -(i + 1),
    quantity: li.quantity,
    ingredient_name: li.ingredient_name,
  }))
  return { ...doc, line_items, instructions: overlay.instructions }
}

/* ---------- The grocery seam (keys stay base, names may swap) ---------- */

/**
 * Per-line DISPLAY names for the grocery aggregation, or null when the base
 * doc should render as-is.
 *
 * Only a doc whose rework kept the line COUNT is substituted here: line order
 * is stable across renders, so base line i and overlay line i are the same
 * ingredient. A rework that moved the count (a protein substituted away, one
 * line split into two — measured on real docs) has no trustworthy line
 * mapping, so the grocery list keeps the base text for that doc; the recipe
 * detail and cooking view still show upstream's full rework. Keeping this
 * conservative is what makes the KEY half of the split unconditional: keys
 * are computed from the base line, always.
 */
export function groceryDisplayNames(doc: RecipeDoc, overlay: OverlayDoc | null): string[] | null {
  if (!overlay || overlay.line_items.length !== doc.line_items.length) return null
  let changed = false
  const names = overlay.line_items.map((li, i) => {
    const base = doc.line_items[i]
    if (li.ingredient_name !== base.ingredient_name) changed = true
    return li.ingredient_name
  })
  return changed ? names : null
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
