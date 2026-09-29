/**
 * Auto-Plan pack builder — ADR-0024.
 *
 * A deterministic, waste-first greedy packer over the precomputed
 * `public/data/pack_index.json` footprint. The unit of waste is the
 * PACKAGE, not the gram (containers ceil-merge per ADR-0017; linear
 * measures just add and cost nothing extra). Pantry staples are
 * present-but-free and never drive selection. No network, no randomness,
 * no AI: same inputs → same plan, every time — pinnable in e2e.
 *
 * PURE LIB: no Vue, no Pinia, no fetch. The index is loaded outside
 * (see src/composables/useAutoPlan.ts) and passed in.
 */

/** Shape of the committed public/data/pack_index.json. */
export interface PackIndex {
  generatedAt: string
  count: number
  /** nameKeys the planner treats as present-but-free (ADR-0024 §3). */
  pantryStaples: string[]
  /** interned ingredient nameKeys (row keyId → string). */
  ingredientKeys: string[]
  /** interned unit strings, containerKey format `pkg|(142 g)` for containers */
  unitKeys: string[]
  recipes: Record<string, PackIndexRecipe>
}

export interface PackIndexRecipe {
  /** [keyId, amount, unitId, isContainer] rows, one per ingredient nameKey. */
  i: ReadonlyArray<[number, number, number, number]>
  /** distinct non-pantry ingredient keys (informational). */
  s: number
}

export interface PackPlanRequest {
  /** Meals wanted. Clamped to 1..10. */
  count: number
  /**
   * Variant id → rating (0..1) from builder_data.variant_meta. The index
   * deliberately carries no recipe metadata, so ratings are injected by
   * the caller; recipes without an entry are treated as rating 0.
   */
  ratings?: ReadonlyMap<number, number>
  /**
   * Variant ids to exclude (already-planned meals, failed diet filters,
   * out-of-category recipes — the planner itself has no category or diet
   * flag; the caller resolves those into this set, per the ADR).
   */
  excludeIds?: Iterable<number>
}

export interface PackPlan {
  /** Chosen variant ids in pick order (seed first). */
  variantIds: number[]
  /** Whole packages bought for the pack: Σ ceil(amount) per container key. */
  packagesBought: number
  /** Distinct non-pantry ingredient nameKeys in the pack. */
  scoredIngredients: number
  /** Present only when the picker could not satisfy the request. */
  warnings?: string[]
}

export const MIN_MEALS = 1
export const MAX_MEALS = 10

const RATING_WEIGHT = 0.25
const EPS = 1e-9

/** Container key inside a pack: (ingredient keyId, container unitId). */
function containerKeyId(keyId: number, unitId: number): number {
  return keyId * 1024 + unitId
}

function cmpAscendingId(a: number, b: number): number {
  return a - b
}

/**
 * Greedy waste-first packer.
 *
 * Seed = highest-rated eligible candidate (ties → lowest id). Then pick,
 * one meal at a time, the candidate minimizing
 * `marginalPackages + RATING_WEIGHT * (1 - rating)`; ties → higher rating,
 * then lower id. Everything is deterministic; there is no randomness.
 */
export function buildAutoPlan(index: PackIndex, req: PackPlanRequest): PackPlan {
  const count = Math.min(MAX_MEALS, Math.max(MIN_MEALS, Math.floor(req.count)))
  const pantry = new Set(index.pantryStaples)
  const excluded = req.excludeIds ? new Set(req.excludeIds) : null
  const ratings = req.ratings

  // Eligible candidate ids, deterministically ordered (index keys are
  // strings — sort numerically so iteration order is id order).
  const candidates: number[] = []
  for (const idStr of Object.keys(index.recipes)) {
    const id = Number(idStr)
    if (excluded?.has(id)) continue
    candidates.push(id)
  }
  candidates.sort(cmpAscendingId)

  const warnings: string[] = []
  if (candidates.length === 0) {
    return {
      variantIds: [],
      packagesBought: 0,
      scoredIngredients: 0,
      warnings: ['No eligible recipes for this plan'],
    }
  }

  const ratingOf = (id: number): number => ratings?.get(id) ?? 0

  // Pack state: running container totals keyed by (ingredient, container),
  // and the set of non-pantry ingredient keys already present.
  const totals = new Map<number, number>()
  const scored = new Set<number>()
  const pack: number[] = []

  /**
   * Marginal whole-package cost of adding `rows` to the current pack
   * (containers ceil-merge per ADR-0017; linear measures add freely).
   * Pantry rows are free by definition.
   */
  function marginalPackages(rows: PackIndexRecipe['i']): number {
    let marginal = 0
    for (const [keyId, amount, unitId, isContainer] of rows) {
      if (!isContainer || amount <= 0) continue
      if (pantry.has(index.ingredientKeys[keyId])) continue
      const key = containerKeyId(keyId, unitId)
      const current = totals.get(key) ?? 0
      marginal += Math.ceil(current + amount - EPS) - Math.ceil(current - EPS)
    }
    return marginal
  }

  function commit(rows: PackIndexRecipe['i']): void {
    for (const [keyId, amount, unitId, isContainer] of rows) {
      const keyName = index.ingredientKeys[keyId]
      if (pantry.has(keyName)) continue
      scored.add(keyId)
      if (isContainer && amount > 0) {
        const key = containerKeyId(keyId, unitId)
        totals.set(key, (totals.get(key) ?? 0) + amount)
      }
    }
  }

  // Seed: max rating, ties → lowest id. Candidates are in id order.
  let seed = candidates[0]
  let seedRating = ratingOf(seed)
  for (const id of candidates) {
    const r = ratingOf(id)
    if (r > seedRating + EPS) {
      seed = id
      seedRating = r
    }
  }
  commit(index.recipes[String(seed)]?.i ?? [])
  pack.push(seed)
  const picked = new Set(pack)

  for (let slot = 1; slot < count; slot++) {
    if (pack.length >= candidates.length) break
    let bestId = -1
    let bestScore = Infinity
    let bestRating = -1
    for (const id of candidates) {
      if (picked.has(id)) continue
      const rating = ratingOf(id)
      const score =
        marginalPackages(index.recipes[String(id)]?.i ?? []) +
        RATING_WEIGHT * (1 - rating)
      // Ties → higher rating, then lower id. Candidates are iterated in
      // ascending id order, so strict-improvement comparisons keep the
      // lower id on an exact tie.
      if (
        score < bestScore - 1e-12 ||
        (Math.abs(score - bestScore) <= 1e-12 && rating > bestRating + EPS)
      ) {
        bestId = id
        bestScore = score
        bestRating = rating
      }
    }
    if (bestId < 0) break
    const rows = index.recipes[String(bestId)]?.i ?? []
    commit(rows)
    pack.push(bestId)
    picked.add(bestId)
  }

  if (pack.length < count) {
    warnings.push(`Pool exhausted at ${pack.length}/${count} meals`)
  }

  let packagesBought = 0
  for (const total of totals.values()) packagesBought += Math.ceil(total - EPS)

  const plan: PackPlan = {
    variantIds: pack,
    packagesBought,
    scoredIngredients: scored.size,
  }
  if (warnings.length > 0) plan.warnings = warnings
  return plan
}
