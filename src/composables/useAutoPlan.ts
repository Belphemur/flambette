import { shallowRef } from 'vue'
import { getCatalog } from '../lib/catalog'
import { dietIndexFor, matchesAllDiets } from '../lib/dietFilter'
import {
  buildAutoPlan,
  type PackIndex,
  type PackPlan,
} from '../lib/packPlanner'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

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
 * carries no recipe metadata — see scripts/build_pack_index.py).
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

export interface AutoPlanOptions {
  count: number
  /** Protein-type constraint resolved OUTSIDE the pure planner. */
  category?: 'meat' | 'fish' | 'vegetarian'
}

export interface AutoPlanResult extends PackPlan {
  /** Caller-side eligible pool size (diagnostics). */
  eligibleCount: number
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
  const diets = ui.dietFilters

  // Eligible = catalog minus (wrong category, diet-failing, planned).
  // Everything NOT eligible goes into excludeIds — the planner only sees
  // the eligible slice, since its candidate universe is index.recipes.
  const eligible = new Set<number>()
  for (const [id, vd] of catalog.dataById) {
    if (options.category && vd.category_name !== options.category) continue
    if (planStore.plan.some((e) => e.variantId === id)) continue
    const verdict = dietIndex.verdictById.get(id)
    if (!verdict || !matchesAllDiets(verdict, diets)) continue
    eligible.add(id)
  }

  const ratings = new Map(catalog.data.variant_meta.map((m) => [m.id, m.rating ?? 0]))
  // The complement of the eligible set ALWAYS excludes — even when the
  // eligible set is empty (otherwise buildAutoPlan would interpret a
  // missing excludeIds as "exclude nothing" and pick recipes that fail
  // the active constraints; qodo thread 1).
  const excludeIds = [...catalog.dataById.keys()].filter((id) => !eligible.has(id))
  const result = buildAutoPlan(index, { count: options.count, excludeIds, ratings })
  return { ...result, eligibleCount: eligible.size }
}
