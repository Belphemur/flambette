import { shallowRef } from 'vue'
import { getCatalog } from '../lib/catalog'
import { dietIndexFor, matchesAllDiets } from '../lib/dietFilter'
import {
  buildAutoPlan,
  type PackIndex,
  type PackPlan,
} from '../lib/packPlanner'
import { usePlanStore } from '../stores/plan'
import { useFavouritesStore } from '../stores/favourites'
import { useRatingStore } from '../stores/rating'
import { useUiStore } from '../stores/ui'
// Type-only: the ruleset FILTER is the taxonomy's own ruleset values, so
// the union is DERIVED from the one source (ADR-0046 §2.3) — a second
// hand-written copy is exactly what already drifted (Lunch/Snack missing
// from the Auto-Plan dialog's local list). Erased at runtime, so the
// store's runtime import edge is not reciprocated.
import type { OFFERED_MEAL_TYPES } from '../lib/mealTypeFilter'

/**
 * Auto-Plan (ADR-0024): loads the pack index ONCE (memoized promise) and
 * runs the pure planner over the eligible catalog slice.
 *
 * Eligibility is resolved HERE, outside the pure lib (the planner has no
 * diet or category flag by design):
 * - optional protein-type constraint (builder_data category_name)
 * - active diet-filter chips (existing classifier in dietFilter.ts, ANDed
 *   exactly like the Recipes tab)
 * - meals already planned are excluded (they are already in the plan)
 *
 * Ratings come from builder_data.variant_meta (the pack index deliberately
 * carries no recipe metadata — see scripts/build_pack_index.py), blended
 * with the HOUSEHOLD's own stars and favourites (ADR-0031).
 */

const PACK_INDEX_URL = `${import.meta.env.BASE_URL}data/pack_index.json`

let indexPromise: Promise<PackIndex> | null = null

/** Reactive holder for the loaded index (null until loaded). */
export const packIndex = shallowRef<PackIndex | null>(null)

async function loadIndex(): Promise<PackIndex> {
  const res = await fetch(PACK_INDEX_URL)
  if (!res.ok) throw new Error(`Failed to load pack index: HTTP ${res.status}`)
  const parsed = (await res.json()) as PackIndex
  packIndex.value = parsed
  return parsed
}

/** The memoized index loader — resolves the committed pack_index.json.
 *  Shares the in-flight promise across callers; a REJECTED load resets
 *  the memo so the next call retries instead of failing forever
 *  (qodo thread 5). */
export function getPackIndex(): Promise<PackIndex> {
  if (!indexPromise) {
    indexPromise = loadIndex().catch((err) => {
      indexPromise = null
      throw err
    })
  }
  return indexPromise
}

/** The ruleset values the offered meal occasions select (mealTypeFilter). */
export type OccasionRuleset = (typeof OFFERED_MEAL_TYPES)[number]['ruleset']

/**
 * Ruleset constraint for Auto-Plan (ADR-0027, widened by ADR-0046): the
 * five offered occasions + 'any', which imposes none. Default 'dinner'.
 */
export type AutoPlanRulesetFilter = OccasionRuleset | 'any'

export interface AutoPlanOptions {
  count: number
  /** Protein-type constraint resolved OUTSIDE the pure planner. */
  category?: 'meat' | 'fish' | 'vegetarian'
  /** Ruleset constraint (ADR-0027); 'any' imposes none. Default 'dinner'. */
  ruleset?: AutoPlanRulesetFilter
  /** v2 (ADR-0027): 'add' completes the current plan; 'replace' replaces it. */
  mode?: 'add' | 'replace'
  /** Rotating seed generation (persisted counter, ADR-0027). */
  seedGeneration?: number
}

export interface AutoPlanResult extends PackPlan {
  /** Caller-side eligible pool size (diagnostics). */
  eligibleCount: number
}

/** Bayesian prior weight for rating smoothing (ADR-0027 §smoothing). */
export const RATING_PRIOR_WEIGHT = 10

/**
 * ADR-0031: the prior weight for a HOUSEHOLD rating, in rating (0..1)
 * units. Deliberately tiny next to the catalog's RATING_PRIOR_WEIGHT of
 * 10 — one 5-star cast by one person must outrank a catalog mean, while
 * the eligible slice's mean still floors it. The catalog's Bayesian mean
 * therefore stays the COLD-START floor (unrated recipes keep their v2
 * smoothed value, bit for bit) and the household only ever pulls rated
 * recipes toward its own opinion.
 */
export const HOUSEHOLD_PRIOR_WEIGHT = 1

/** Highest star value the rating store accepts (5). */
const MAX_STARS = 5

/**
 * Bayesian shrinkage toward the catalog mean: a 1.0 from 2 votes must not
 * outrank a 0.95 from 400. Computed over the ELIGIBLE slice only, so a
 * filtered catalog's own mean anchors the prior (a dessert-only run does
 * not get dragged by 2,090 dinners).
 */
function smoothedRating(
  meta: { rating?: number; rating_count?: number } | undefined,
  mean: number,
): number {
  const count = meta?.rating_count ?? 0
  return ((meta?.rating ?? 0) * count + mean * RATING_PRIOR_WEIGHT) / (count + RATING_PRIOR_WEIGHT)
}

/**
 * Run the planner over the current catalog slice. Throws when the catalog
 * or the index fails to load — the UI surfaces that via a toast.
 */
export async function runAutoPlan(options: AutoPlanOptions): Promise<AutoPlanResult> {
  const [catalog, index] = await Promise.all([getCatalog(), getPackIndex()])
  const planStore = usePlanStore()
  const ui = useUiStore()
  const dietIndex = dietIndexFor(catalog.data.variant_meta)
  const diets = ui.quickFilters.diets
  const ruleset = options.ruleset ?? ui.autoPlanRuleset
  const mode = options.mode ?? ui.autoPlanMode
  const plannedIds = new Set(planStore.plan.map((e) => e.variantId))

  // Eligible = catalog minus (wrong category, failing ruleset, diet-failing,
  // and in replace mode: already planned).
  // Everything NOT eligible goes into excludeIds — the planner only sees
  // the eligible slice, since its candidate universe is index.recipes.
  const eligible = new Set<number>()
  for (const [id, vd] of catalog.dataById) {
    if (options.category && vd.category_name !== options.category) continue
    if (
      ruleset !== 'any' &&
      (catalog.byId.get(id)?.ruleset ?? undefined) !== ruleset
    ) {
      continue
    }
    if (mode === 'replace' && plannedIds.has(id)) continue
    const verdict = dietIndex.verdictById.get(id)
    if (!verdict || !matchesAllDiets(verdict, diets)) continue
    eligible.add(id)
  }

  // Bayesian-smoothed ratings over the ELIGIBLE slice (ADR-0027): the
  // prior mean comes from the eligible candidates only.
  const metas = catalog.data.variant_meta
  const eligibleMetas = metas.filter((m) => eligible.has(m.id))
  const mean =
    eligibleMetas.length > 0
      ? eligibleMetas.reduce((sum, m) => sum + (m.rating ?? 0), 0) / eligibleMetas.length
      : 0
  const ratings = new Map<number, number>(
    metas.map((m) => [m.id, eligible.has(m.id) ? smoothedRating(m, mean) : 0]),
  )
  // ADR-0031: household stars OVERRIDE the catalog-smoothed rating for the
  // recipes that have them, shrunk toward the same eligible-slice mean.
  // A recipe nobody rated keeps its v2 value exactly — the blend only
  // touches keys the household actually rated.
  const ratingStore = useRatingStore()
  for (const [key, entry] of Object.entries(ratingStore.map)) {
    const id = Number(key)
    if (!eligible.has(id)) continue
    const stars = Math.min(MAX_STARS, Math.max(0, entry.rating)) / MAX_STARS
    const count = Math.max(1, entry.count)
    ratings.set(id, (stars * count + mean * HOUSEHOLD_PRIOR_WEIGHT) / (count + HOUSEHOLD_PRIOR_WEIGHT))
  }
  const tags = new Map<number, number[]>(
    metas.map((m) => [m.id, m.variety_tag_ids ?? []]),
  )

  // v2 (ADR-0027): in ADD mode the current plan's meals pre-commit their
  // waste into the ledger and stay; in REPLACE mode they are excluded
  // and the plan is replaced after confirm.
  const baseIds = mode === 'add' ? planStore.plan.map((e) => e.variantId) : []
  // Base meals may have been scaled by the user — the ledger must
  // reflect what is actually bought (qodo round 2).
  const baseServings =
    mode === 'add' ? new Map(planStore.plan.map((e) => [e.variantId, e.servings])) : undefined

  // The complement of the eligible set ALWAYS excludes — even when the
  // eligible set is empty (otherwise buildAutoPlan would interpret a
  // missing excludeIds as "exclude nothing" and pick recipes that fail
  // the active constraints; qodo thread 1).
  const excludeIds = [...catalog.dataById.keys()].filter((id) => !eligible.has(id))
  const result = buildAutoPlan(index, {
    count: options.count,
    excludeIds,
    ratings,
    tags,
    baseIds,
    baseServings,
    seedGeneration: options.seedGeneration ?? ui.nextAutoPlanGeneration(),
    // ADR-0031: household favourites are a preference signal (+0.05 off a
    // candidate's score). The set is read whole — the planner only ever
    // consults it for candidates it is already considering.
    favoriteIds: new Set(useFavouritesStore().ids),
  })
  return { ...result, eligibleCount: eligible.size }
}
