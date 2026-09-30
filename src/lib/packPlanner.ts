/**
 * Auto-Plan pack builder — ADR-0024 (v1) + ADR-0027 (v2).
 *
 * A deterministic, waste-first greedy packer over the precomputed
 * `public/data/pack_index.json` footprint. The unit of waste is the
 * PACKAGE, not the gram (containers ceil-merge per ADR-0017; linear
 * measures just add and cost nothing extra). Pantry staples are
 * present-but-free and never drive selection. No network, no randomness,
 * no AI: same inputs → same plan, every time — pinnable in e2e.
 *
 * v2 (ADR-0027) adds completion semantics without breaking v1 callers:
 * - `baseIds`: already-planned meals pre-commit their footprints (they
 *   share their packages with the additions) and are never re-picked.
 * - `tags` (variety_tag_ids): candidates whose tags are already present
 *   pay a per-shared-tag penalty — variety nudges, waste still decides.
 * - `seedGeneration`: the seed rotates over the top-ROTATION_K candidates
 *   ranked by rating; generation 0 = highest rating (v1 behavior).
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
  /** NEW meals wanted. Clamped to 1..10. */
  count: number
  /**
   * Variant id → rating (0..1) — in v2 the caller injects the
   * BAYESIAN-SMOOTHED value over the eligible slice (ADR-0027 §smoothing).
   * The index deliberately carries no recipe metadata; recipes without an
   * entry are treated as rating 0.
   */
  ratings?: ReadonlyMap<number, number>
  /**
   * Variant ids to exclude (failed diet/category/ruleset filters, ids that
   * must never be picked — the planner itself has no category, diet or
   * ruleset flag; the caller resolves those into this set).
   */
  excludeIds?: Iterable<number>
  /**
   * v2 (ADR-0027) — completion mode: footprints of these recipes commit
   * into the waste ledger FIRST (additions share their packages), never
   * appear in `variantIds`, and are not eligible as picks.
   * `packagesBought` / `scoredIngredients` describe the FULL pack
   * (base + additions).
   */
  baseIds?: Iterable<number>
  /**
   * v2 (ADR-0027) — variant id → variety_tag_ids (builder_data). Candidates
   * whose tags are already present on picked meals (base included) pay a
   * TAG_WEIGHT penalty per shared tag. Omitted → v1 behavior (no variety
   * pressure), keeping old callers/tests valid.
   */
  tags?: ReadonlyMap<number, ReadonlyArray<number>>
  /**
   * v2 (ADR-0027) — rotating seed generation (default 0). Candidates are
   * ranked by rating desc (ties → lower id); the seed is the rank
   * `(seedGeneration mod ROTATION_K)`. Generation 0 reproduces "highest
   * rating" exactly. Same (index, request incl. generation) → identical
   * output.
   */
  seedGeneration?: number
}

export interface PackPlan {
  /** NEWLY picked variant ids in pick order (base meals NOT included). */
  variantIds: number[]
  /** Whole packages bought for the FULL pack: Σ ceil(amount) per (ingredient, container). */
  packagesBought: number
  /** Distinct non-pantry ingredient nameKeys in the FULL pack. */
  scoredIngredients: number
  /** Present only when the picker could not satisfy the request. */
  warnings?: string[]
}

export const MIN_MEALS = 1
export const MAX_MEALS = 10

const RATING_WEIGHT = 0.25
/**
 * v2 (ADR-0027): one shared variety tag costs 0.2 — meaningfully less than
 * a full rating swing (0.25) and far less than one opened package (1.0):
 * similarity nudges ties, waste still decides.
 */
const TAG_WEIGHT = 0.2
/** v2 (ADR-0027) — seed rotation depth: the top-5 rated candidates take
 *  turns being the seed across generations. */
export const ROTATION_K = 5
const EPS = 1e-9

/** Container key inside a pack: (ingredient keyId, container unitId). */
function containerKeyId(keyId: number, unitId: number): number {
  return keyId * 1024 + unitId
}

function cmpAscendingId(a: number, b: number): number {
  return a - b
}

/**
 * Greedy waste-first packer (v2, ADR-0027).
 *
 * Base meals (add mode) commit their footprints first — additions share
 * their packages — and are never re-picked. The seed ROTATES across
 * generations over the top-ROTATION_K candidates ranked by rating desc
 * (generation 0 = highest rating, ties → lowest id). Slots 2..N minimize
 * `marginalPackages + RATING_WEIGHT*(1-rating) + TAG_WEIGHT*tagOverlap`;
 * ties → higher rating, then lower id. No randomness anywhere: the same
 * (index, request incl. generation) → identical output.
 */
export function buildAutoPlan(index: PackIndex, req: PackPlanRequest): PackPlan {
  const count = Math.min(MAX_MEALS, Math.max(MIN_MEALS, Math.floor(req.count)))
  const pantry = new Set(index.pantryStaples)
  const excluded = req.excludeIds ? new Set(req.excludeIds) : null
  const ratings = req.ratings
  const tags = req.tags

  // Pack state: running container totals keyed by (ingredient, container),
  // the set of non-pantry ingredient keys already present, and the pool of
  // variety tags present on picked meals (base included).
  const totals = new Map<number, number>()
  const scored = new Set<number>()
  const tagPool = new Set<number>()
  const pack: number[] = []
  const picked = new Set<number>()

  /** Commit a recipe's footprint + tags into the ledger (base OR pick). */
  function commit(id: number): void {
    for (const [keyId, amount, unitId, isContainer] of index.recipes[String(id)]?.i ?? []) {
      const keyName = index.ingredientKeys[keyId]
      if (pantry.has(keyName)) continue
      scored.add(keyId)
      if (isContainer && amount > 0) {
        const key = containerKeyId(keyId, unitId)
        totals.set(key, (totals.get(key) ?? 0) + amount)
      }
    }
    for (const tag of tags?.get(id) ?? []) tagPool.add(tag)
  }

  // Base meals pre-commit (add mode) and are never eligible as picks.
  const baseIds = [...new Set(req.baseIds ?? [])].sort(cmpAscendingId)
  for (const id of baseIds) {
    commit(id)
    picked.add(id)
  }

  // Eligible candidate ids, deterministically ordered (index keys are
  // strings — sort numerically so iteration order is id order).
  const candidates: number[] = []
  for (const idStr of Object.keys(index.recipes)) {
    const id = Number(idStr)
    if (excluded?.has(id) || picked.has(id)) continue
    candidates.push(id)
  }
  candidates.sort(cmpAscendingId)

  const warnings: string[] = []
  if (candidates.length === 0 && baseIds.length === 0) {
    return {
      variantIds: [],
      packagesBought: 0,
      scoredIngredients: 0,
      warnings: ['No eligible recipes for this plan'],
    }
  }

  const ratingOf = (id: number): number => ratings?.get(id) ?? 0

  /**
   * Marginal whole-package cost of adding a candidate's rows to the
   * current pack (containers ceil-merge per ADR-0017; linear measures add
   * freely). Pantry rows are free by definition.
   */
  function marginalPackages(id: number): number {
    let marginal = 0
    for (const [keyId, amount, unitId, isContainer] of index.recipes[String(id)]?.i ?? []) {
      if (!isContainer || amount <= 0) continue
      if (pantry.has(index.ingredientKeys[keyId])) continue
      const key = containerKeyId(keyId, unitId)
      const current = totals.get(key) ?? 0
      marginal += Math.ceil(current + amount - EPS) - Math.ceil(current - EPS)
    }
    return marginal
  }

  /** Distinct candidate tags already present on picked meals (base incl.). */
  function tagOverlap(id: number): number {
    const candidateTags = tags?.get(id)
    if (!candidateTags || tagPool.size === 0) return 0
    let overlap = 0
    for (const tag of candidateTags) if (tagPool.has(tag)) overlap += 1
    return overlap
  }

  // Rotating seed (ADR-0027): rank candidates by rating desc, ties →
  // lower id. candidates are ascending by id and Array.sort is stable, so
  // a descending-rating sort keeps the lowest id first within a rating
  // tie. Generation g seeds rank (g mod ROTATION_K); generation 0 lands
  // on rank 0 = the v1 "highest rating" seed.
  const byRating = [...candidates].sort((a, b) => ratingOf(b) - ratingOf(a))
  const k = Math.min(ROTATION_K, byRating.length)
  // Guard: with a base pack and an empty candidate pool there is no seed
  // (and no slots) — fall through to the partial-pack warning.
  if (k > 0) {
    const seed = byRating[Math.floor(req.seedGeneration ?? 0) % k]
    commit(seed)
    pack.push(seed)
    picked.add(seed)
  }

  for (let slot = 1; slot < count; slot++) {
    if (pack.length >= candidates.length) break
    let bestId = -1
    let bestScore = Infinity
    let bestRating = -1
    for (const id of candidates) {
      if (picked.has(id)) continue
      const rating = ratingOf(id)
      const score =
        marginalPackages(id) +
        RATING_WEIGHT * (1 - rating) +
        TAG_WEIGHT * tagOverlap(id)
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
    commit(bestId)
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
