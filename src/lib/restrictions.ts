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

/** One pairing input: the ingredient's nameKey plus its quantity string. */
interface PairItem {
  key: string
  quantity: string
}

/**
 * Pair overlay rows to base rows:
 *
 * - pass 1 — the SAME nameKey (the same ingredient wherever upstream moved
 *   it);
 * - pass 1b — nameKey CONTAINMENT: upstream's substitutions embed the
 *   original name (`soy sauce` → `tamari soy sauce`, `fettuccine pasta` →
 *   `gluten-free fettuccine pasta`), so a leftover overlay row pairs a
 *   leftover base row when one nameKey contains the other — but only when
 *   the candidate is UNIQUE on both sides (an ambiguous containment is no
 *   evidence);
 * - pass 2 — the remaining leftovers pair IN ORDER, one constraint per
 *   pair: BOTH quantities must be unique among their own leftovers.
 *   Duplicate quantities (two `354 ml` lines, the many empty seasoning
 *   rows) cannot prove identity, and an ingredient upstream ADDED (GF rid
 *   863's `12 eggs`) must never steal a base row's key by blind order —
 *   measured live 2026-10-06: blind order pairing keyed the eggs row onto
 *   the shrimp line and the tamari row onto fish sauce.
 *
 * The return is per-overlay-row: the paired base row's index, or -1 when
 * the overlay row has no base counterpart (a split's extra line, a refused
 * ambiguous pair). An unpaired base row is absent from the restricted
 * render and the display truth never includes it.
 */
function pairOverlayToBase(base: readonly PairItem[], ov: readonly PairItem[]): number[] {
  const usedBase = new Set<number>()
  const pairOf = new Array<number>(ov.length).fill(-1)
  for (let i = 0; i < ov.length; i++) {
    if (!ov[i].key) continue
    const j = base.findIndex((b, idx) => !usedBase.has(idx) && b.key === ov[i].key)
    if (j !== -1) {
      pairOf[i] = j
      usedBase.add(j)
    }
  }
  const openOv: number[] = []
  for (let i = 0; i < ov.length; i++) if (pairOf[i] === -1 && ov[i].key) openOv.push(i)
  const openBase: number[] = []
  for (let j = 0; j < base.length; j++) if (!usedBase.has(j)) openBase.push(j)
  for (const i of openOv) {
    const candidates = openBase.filter(
      (j) => !usedBase.has(j) && (base[j].key.includes(ov[i].key) || ov[i].key.includes(base[j].key)),
    )
    if (candidates.length === 1) {
      pairOf[i] = candidates[0]
      usedBase.add(candidates[0])
    }
  }
  const leftOv: number[] = []
  for (let i = 0; i < ov.length; i++) if (pairOf[i] === -1 && ov[i].key) leftOv.push(i)
  const leftBase: number[] = []
  for (let j = 0; j < base.length; j++) if (!usedBase.has(j)) leftBase.push(j)
  const ovQty = new Map<string, number>()
  for (const i of leftOv) {
    const q = ov[i].quantity.trim()
    ovQty.set(q, (ovQty.get(q) ?? 0) + 1)
  }
  const baseQty = new Map<string, number>()
  for (const j of leftBase) {
    const q = base[j].quantity.trim()
    baseQty.set(q, (baseQty.get(q) ?? 0) + 1)
  }
  for (let n = 0; n < leftOv.length && n < leftBase.length; n++) {
    const i = leftOv[n]
    const j = leftBase[n]
    const qo = ov[i].quantity.trim()
    const qb = base[j].quantity.trim()
    if (qo === qb && (ovQty.get(qo) ?? 0) === 1 && (baseQty.get(qb) ?? 0) === 1) {
      pairOf[i] = j
      usedBase.add(j)
    }
  }
  return pairOf
}

/**
 * The safe-positional test shared by the doc view and the grocery seam:
 * equal counts AND pairwise-equal quantities — AND every RENAMED index's
 * quantity unique within the base doc. Duplicate quantities (GF rid 224
 * carries two `354 ml` lines; many docs repeat empty seasoning rows) mean
 * an upstream REORDER of equal-quantity lines cannot be ruled out, so a
 * rename on such an index falls to the nameKey-first pairing below.
 */
function positionalSafe(base: readonly PairItem[], ov: readonly PairItem[]): boolean {
  if (ov.length !== base.length) return false
  if (!ov.every((li, i) => li.quantity.trim() === base[i].quantity.trim())) return false
  const qtyCounts = new Map<string, number>()
  for (const b of base) {
    const q = b.quantity.trim()
    qtyCounts.set(q, (qtyCounts.get(q) ?? 0) + 1)
  }
  return ov.every(
    (row, i) =>
      row.key === base[i].key || (qtyCounts.get(base[i].quantity.trim()) ?? 0) === 1,
  )
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
  const pairOf = positionalSafe(
    doc.line_items.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
    overlay.line_items.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
  )
    ? overlay.line_items.map((_, i) => (i < baseIds.length ? i : -1))
    : pairOverlayToBase(
        doc.line_items.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
        overlay.line_items.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
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
 * index's quantity string is equal (or both empty), with no rename sitting
 * on a duplicated quantity (see `positionalSafe`): base line i and overlay
 * line i are the same ingredient, so the row keys on the BASE nameKey,
 * displays the overlay's name and the (identical) quantity. Unchanged names
 * return null — no override, byte-identical to the base render.
 *
 * THE MISMATCH CLASS — anything else (a reorder, a substituted-away line that
 * collapsed two lines into one, a split): names are NOT overridden
 * positionally. The overlay's OWN line list is displayed instead — the
 * overlay is metric, so its quantities are correct — while each row's key
 * stays a BASE doc nameKey wherever the pairing found the row's base
 * counterpart (exact nameKey, containment, or an unambiguous in-order
 * leftover pair — see `pairOverlayToBase`); an overlay row with no base
 * counterpart (a split's extra line, an upstream addition) keys to itself.
 * A base line with no overlay counterpart is NOT appended: it is absent
 * from the restricted render, and the restricted doc is the display truth
 * (measured live: GF rid 863's base soy sauce and fish sauce used to
 * survive their own restriction in the grocery while the recipe detail
 * showed only tamari).
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
    positionalSafe(
      base.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
      ov.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
    )
  ) {
    let changed = false
    const rows = ov.map((li, i) => {
      if (li.ingredient_name !== base[i].ingredient_name) changed = true
      return {
        keyName: nameKey(base[i].ingredient_name),
        name: li.ingredient_name,
        quantity: base[i].quantity,
        keyIngredient: base[i].ingredient_name,
      }
    })
    return changed ? rows : null
  }

  const pairOf = pairOverlayToBase(
    base.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
    ov.map((li) => ({ key: nameKey(li.ingredient_name), quantity: li.quantity })),
  )
  return ov.map((li, i) => {
    const j = pairOf[i]
    if (j === -1) {
      // An overlay row with no base counterpart keys to itself.
      return { keyName: nameKey(li.ingredient_name), name: li.ingredient_name, quantity: li.quantity }
    }
    const row: RestrictedDisplayLine = {
      keyName: nameKey(base[j].ingredient_name),
      name: li.ingredient_name,
      quantity: li.quantity,
      keyIngredient: base[j].ingredient_name,
    }
    if (base[j].quantity.trim() !== li.quantity.trim()) row.keyQuantity = base[j].quantity
    return row
  })
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
