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
 * v3 (ADR-0031) adds household PREFERENCE on top, without changing any
 * v2 arithmetic when the new field is absent:
 * - `favoriteIds`: a favourited candidate pays FAVORITE_BONUS less score.
 *   A preference nudges ties; waste still decides.
 * Household RATINGS need no field: the caller already injects the rating
 * it wants scored through `ratings` (useAutoPlan blends the household
 * stars over the catalog mean), which keeps this lib a pure function of
 * its request.
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
   * v2 (qodo round 1): variant id → the servings the household ACTUALLY
   * plans for each base meal. Base footprints commit at the authored
   * servings by default; when a meal was scaled, its container rows are
   * ceil-scaled per ADR-0017 so the ledger reflects what is really bought
   * (linear rows are presence-only for the ledger and need no scaling).
   */
  baseServings?: ReadonlyMap<number, number>
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
  /**
   * v3 (ADR-0031) — variant ids the household has favourited. Each one
   * pays `FAVORITE_BONUS` off its score (0.05 — a fifth of a rating
   * swing, a fiftieth of an opened package). Omitted → v2 arithmetic,
   * bit for bit. The rotating SEED is deliberately NOT biased: it ranks
   * on rating alone, so favourites nudge slot picking without changing
   * which recipe anchors the pack.
   */
  favoriteIds?: ReadonlySet<number>
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

export interface PackProposal {
  /** The anchor (seed) recipe the completion grew from. */
  seedId: number
  /** NEWLY picked variant ids in pick order (base meals NOT included). */
  variantIds: number[]
  /** Whole packages bought for the FULL pack (base + additions in add mode). */
  packagesBought: number
  /** Distinct non-pantry ingredient nameKeys in the FULL pack. */
  scoredIngredients: number
  /**
   * 'continuity' — add mode's pinned proposal #1, anchored on the eligible
   * candidate with the LOWEST marginal package cost against the base ledger
   * (ADR-0080 Decision 3). 'rated' — anchored on a rating-ranked window seed.
   */
  kind: 'continuity' | 'rated'
  /** Pool-exhaustion warnings from the completion (qodo round 1). */
  warnings?: string[]
}

/** Proposals per press (ADR-0080 Decision 2). */
export const PROPOSAL_COUNT = 3
/**
 * Regeneration-variety amendment (ADR-0080, #74): the seed pool widens to
 * PROPOSAL_COUNT × 3 top-rated candidates, and the generation's window
 * covers one of three DISJOINT rank thirds — so the cheapest pack of one
 * window can no longer dominate the next generation's Plan A.
 */
export const PROPOSAL_POOL = PROPOSAL_COUNT * 3
/** Rank width of one disjoint window (PROPOSAL_POOL / PROPOSAL_COUNT). */
const WINDOW_SIZE = 3

export const MIN_MEALS = 1
export const MAX_MEALS = 10

const RATING_WEIGHT = 0.25
/**
 * v2 (ADR-0027): one shared variety tag costs 0.2 — meaningfully less than
 * a full rating swing (0.25) and far less than one opened package (1.0):
 * similarity nudges ties, waste still decides.
 */
const TAG_WEIGHT = 0.2
/**
 * v3 (ADR-0031): a household favourite is a preference signal, not a
 * command — 0.05 is a fifth of RATING_WEIGHT and 1/20 of one opened
 * package, so it can flip a near-tie (two candidates sharing every
 * package) but never outvote waste.
 */
export const FAVORITE_BONUS = 0.05
/** v2 (ADR-0027) — seed rotation depth: the top-5 rated candidates take
 *  turns being the seed across generations. */
export const ROTATION_K = 5
const EPS = 1e-9
/** All 2,730 recipes are authored serving_count = 6 (frozen catalog). */
const AUTHORED_SERVINGS = 6

/** Container key inside a pack: (ingredient keyId, container unitId). */
function containerKeyId(keyId: number, unitId: number): number {
  return keyId * 1024 + unitId
}

function cmpAscendingId(a: number, b: number): number {
  return a - b
}

/**
 * Pack state shared by every completion of one request: running container
 * totals keyed by (ingredient, container), the set of non-pantry ingredient
 * keys already present, and the pool of variety tags present on picked
 * meals (base included).
 */
interface PackLedger {
  pantry: Set<string>
  totals: Map<number, number>
  scored: Set<number>
  tagPool: Set<number>
  commit(id: number, factor?: number): void
  baseIds: number[]
}

function createLedger(index: PackIndex, req: PackPlanRequest): PackLedger {
  const pantry = new Set(index.pantryStaples)
  const totals = new Map<number, number>()
  const scored = new Set<number>()
  const tagPool = new Set<number>()
  const tags = req.tags

  /** Commit a recipe's footprint + tags into the ledger (base OR pick). */
  function commit(id: number, factor = 1): void {
    for (const [keyId, amount, unitId, isContainer] of index.recipes[String(id)]?.i ?? []) {
      const keyName = index.ingredientKeys[keyId]
      if (pantry.has(keyName)) continue
      scored.add(keyId)
      if (isContainer && amount > 0) {
        const key = containerKeyId(keyId, unitId)
        // Scaled base meals (qodo round 2): a meal planned for more
        // servings buys whole containers — ceil per ADR-0017.
        const contribution = factor === 1 ? amount : Math.max(1, Math.ceil(amount * factor - EPS))
        totals.set(key, (totals.get(key) ?? 0) + contribution)
      }
    }
    for (const tag of tags?.get(id) ?? []) tagPool.add(tag)
  }

  // Base meals pre-commit (add mode) and are never eligible as picks.
  const baseIds = [...new Set(req.baseIds ?? [])].sort(cmpAscendingId)
  for (const id of baseIds) {
    const servings = req.baseServings?.get(id)
    commit(id, servings && servings > 0 ? servings / AUTHORED_SERVINGS : 1)
  }

  return { pantry, totals, scored, tagPool, commit, baseIds }
}

/**
 * Marginal whole-package cost of adding a candidate's rows to the
 * current pack (containers ceil-merge per ADR-0017; linear measures add
 * freely). Pantry rows are free by definition.
 */
function marginalPackagesOf(
  index: PackIndex,
  pantry: Set<string>,
  totals: Map<number, number>,
  id: number,
): number {
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
function tagOverlapOf(
  tags: ReadonlyMap<number, ReadonlyArray<number>> | undefined,
  tagPool: Set<number>,
  id: number,
): number {
  const candidateTags = tags?.get(id)
  if (!candidateTags || tagPool.size === 0) return 0
  let overlap = 0
  for (const tag of candidateTags) if (tagPool.has(tag)) overlap += 1
  return overlap
}

/**
 * Eligible candidate ids, deterministically ordered (index keys are
 * strings — sort numerically so iteration order is id order).
 */
function collectCandidates(
  index: PackIndex,
  picked: Set<number>,
  excluded: Set<number> | null,
): number[] {
  const candidates: number[] = []
  for (const idStr of Object.keys(index.recipes)) {
    const id = Number(idStr)
    if (excluded?.has(id) || picked.has(id)) continue
    candidates.push(id)
  }
  candidates.sort(cmpAscendingId)
  return candidates
}

/** Non-finite or negative generations (a hostile backup import) degrade
 * to 0 so `gen % k` can never produce NaN → an undefined seed (qodo
 * round 2). Shared by the rotation seed and the proposal window. */
function sanitizeGeneration(raw: number | undefined): number {
  const generation = raw ?? 0
  return typeof generation === 'number' && Number.isFinite(generation) && generation >= 0
    ? Math.floor(generation)
    : 0
}

/**
 * ONE seeded greedy completion (the ADR-0080 refactor of the v2 body).
 * The seed is either FORCED (a proposal's anchor) or the rotating
 * rating-rank seed (ADR-0027). Slots 2..N minimize
 * `marginalPackages + RATING_WEIGHT*(1-rating) + TAG_WEIGHT*tagOverlap
 * - FAVORITE_BONUS*isFavourite`; ties → higher rating, then lower id.
 * No randomness anywhere: the same (index, request incl. generation) →
 * identical output.
 */
function runPack(index: PackIndex, req: PackPlanRequest, forcedSeedId: number | null): PackPlan {
  const count = Math.min(MAX_MEALS, Math.max(MIN_MEALS, Math.floor(req.count)))
  const ratings = req.ratings
  const tags = req.tags
  const favorites = req.favoriteIds ?? null
  const ledger = createLedger(index, req)
  const { pantry, totals, scored, tagPool, commit } = ledger
  const picked = new Set(ledger.baseIds)
  const candidates = collectCandidates(
    index,
    picked,
    req.excludeIds ? new Set(req.excludeIds) : null,
  )
  const pack: number[] = []

  const warnings: string[] = []
  if (candidates.length === 0 && ledger.baseIds.length === 0) {
    return {
      variantIds: [],
      packagesBought: 0,
      scoredIngredients: 0,
      warnings: ['No eligible recipes for this plan'],
    }
  }

  const ratingOf = (id: number): number => ratings?.get(id) ?? 0

  // Rotating seed (ADR-0027): rank candidates by rating desc, ties →
  // lower id. candidates are ascending by id and Array.sort is stable, so
  // a descending-rating sort keeps the lowest id first within a rating
  // tie. Generation g seeds rank (g mod ROTATION_K); generation 0 lands
  // on rank 0 = the v1 "highest rating" seed. A forced seed (a proposal
  // anchor, always an eligible candidate) overrides the rotation.
  const byRating = [...candidates].sort((a, b) => ratingOf(b) - ratingOf(a))
  const k = Math.min(ROTATION_K, byRating.length)
  if (k > 0) {
    const forced =
      forcedSeedId != null && candidates.includes(forcedSeedId) && !picked.has(forcedSeedId)
        ? forcedSeedId
        : null
    const seed = forced ?? byRating[sanitizeGeneration(req.seedGeneration) % k]
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
        marginalPackagesOf(index, pantry, totals, id) +
        RATING_WEIGHT * (1 - rating) +
        TAG_WEIGHT * tagOverlapOf(tags, tagPool, id) -
        (favorites?.has(id) ? FAVORITE_BONUS : 0)
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

/**
 * Greedy waste-first packer (v2, ADR-0027).
 *
 * Base meals (add mode) commit their footprints first — additions share
 * their packages — and are never re-picked. The seed ROTATES across
 * generations over the top-ROTATION_K candidates ranked by rating desc
 * (generation 0 = highest rating, ties → lowest id).
 *
 * Bit-for-bit v2: the v2 body now lives in `runPack`; this wrapper passes
 * no forced seed, so absent `buildAutoPlanProposals` the lib behaves
 * exactly as before (every existing unit pin stays valid).
 */
export function buildAutoPlan(index: PackIndex, req: PackPlanRequest): PackPlan {
  return runPack(index, req, null)
}

function toProposal(seedId: number, plan: PackPlan, kind: PackProposal['kind']): PackProposal {
  const proposal: PackProposal = {
    seedId,
    variantIds: plan.variantIds,
    packagesBought: plan.packagesBought,
    scoredIngredients: plan.scoredIngredients,
    kind,
  }
  // Pool-exhaustion warnings ride along (qodo round 1): a short pack must
  // reach the confirm toast, not vanish into the lib.
  if (plan.warnings) proposal.warnings = plan.warnings
  return proposal
}

/**
 * Multi-proposal Auto-Plan preview (ADR-0080): up to PROPOSAL_COUNT
 * DISTINCT packs, each ONE seed greedy-completed with the SAME v2 slot
 * arithmetic (`runPack`) — the scorer is never forked.
 *
 * Seeds come from the top-PROPOSAL_POOL (9) smoothed-rated candidates,
 * ranked rating desc (ties → lower id) — the ranking the rotation uses.
 * Ranking of the RETURNED list is waste-first (ADR-0080 Decision 1):
 * packagesBought ASC, then seed rating DESC, then seed id ASC — except
 * the CONTINUITY seed (add mode, non-empty baseIds), which is PINNED at
 * position #1 (Decision 4). The favourite bonus stays inside the slot
 * scores; it never reorders proposals.
 *
 * Regeneration-variety amendment (ADR-0080, #74 — "Plan A never changes
 * across Regenerate presses"):
 * - **Continuity tie-rotation.** The continuity seed is the candidate at
 *   rank `(seedGeneration mod min(tieCount, ROTATION_K))` of the
 *   minimal-marginal tie set (computed against the BASE ledger; candidates
 *   outside the tie set are ineligible), ordered by smoothed rating desc →
 *   id asc. Rank 0 is the pre-amendment pick, so generation 0 is
 *   bit-for-bit unchanged.
 * - **Disjoint proposal windows.** Window `w = seedGeneration mod 3`
 *   covers ranks `[3w, 3w+2]` of the rated pool (which in add mode
 *   EXCLUDES the continuity seed — Decision 4 — so the window start is
 *   taken on the filtered pool). The walk is FORWARD in rank order, so a
 *   pack-dedupe replacement takes "the next ranked seed"; if the pool
 *   exhausts, fewer cards render.
 * - **Pack-content dedupe.** A seed whose COMPLETED pack (variantId set —
 *   order-insensitive, the planner has no day/slot assignment) equals an
 *   already-chosen proposal's pack is skipped. No cross-generation state:
 *   determinism per generation is preserved.
 *
 * Catalogs with fewer eligible candidates than PROPOSAL_POOL keep the
 * original clamped, CYCLIC window (§Decision 4): span = min(WINDOW_SIZE,
 * pool), start = generation mod span, so every eligible seed stays
 * reachable from every generation (a one-candidate pool at generation 2
 * shows its one proposal, never an empty preview).
 *
 * `baseIds` footprints pre-commit into EVERY proposal's ledger (add mode
 * semantics — `packagesBought` describes base + additions, exactly as
 * `buildAutoPlan` does).
 *
 * Determinism: same (index, request incl. generation) → identical list.
 */
export function buildAutoPlanProposals(index: PackIndex, req: PackPlanRequest): PackProposal[] {
  const ledger = createLedger(index, req)
  const candidates = collectCandidates(
    index,
    new Set(ledger.baseIds),
    req.excludeIds ? new Set(req.excludeIds) : null,
  )
  if (candidates.length === 0) return []

  const ratingOf = (id: number): number => req.ratings?.get(id) ?? 0
  const byRating = [...candidates].sort((a, b) => ratingOf(b) - ratingOf(a))

  // Continuity seed (add mode, amendment Decision 1): rank
  // (generation mod min(tieCount, ROTATION_K)) of the minimal-marginal
  // tie set against the BASE ledger, ordered smoothed-rating desc → id
  // asc. The rating comparison keeps the pre-amendment tie semantics
  // (differences within EPS are ties → lower id), so rank 0 reproduces
  // the old strict-improvement scan's pick exactly.
  let continuitySeed: number | null = null
  if (ledger.baseIds.length > 0) {
    let minMarginal = Infinity
    const marginals = new Map<number, number>()
    for (const id of candidates) {
      const marginal = marginalPackagesOf(index, ledger.pantry, ledger.totals, id)
      marginals.set(id, marginal)
      if (marginal < minMarginal) minMarginal = marginal
    }
    const tieSet = candidates
      .filter((id) => Math.abs(marginals.get(id)! - minMarginal) <= 1e-12)
      .sort((a, b) => {
        const dr = ratingOf(b) - ratingOf(a)
        return Math.abs(dr) > EPS ? dr : a - b
      })
    const depth = Math.min(ROTATION_K, tieSet.length)
    continuitySeed = tieSet[sanitizeGeneration(req.seedGeneration) % depth]
  }

  // Window rotation (ADR-0080 Decision 4 + regeneration-variety
  // amendment Decision 2). The rated pool EXCLUDES the continuity seed
  // (add mode: "the non-continuity seeds") BEFORE the window start is
  // taken. Full pool: the three windows over ranks are DISJOINT, so the
  // cheapest pack of one window cannot dominate the next generation.
  // Sub-pool catalogs keep the clamped cyclic walk so no eligible seed
  // becomes unreachable.
  const ratedPool = byRating
    .slice(0, Math.min(PROPOSAL_POOL, byRating.length))
    .filter((id) => id !== continuitySeed)
  const generation = sanitizeGeneration(req.seedGeneration)
  const disjoint = ratedPool.length >= PROPOSAL_POOL
  const start = disjoint ? (generation % WINDOW_SIZE) * WINDOW_SIZE : generation % Math.max(1, Math.min(WINDOW_SIZE, ratedPool.length))
  const cyclic = !disjoint
  const packKey = (variantIds: number[]): string =>
    [...variantIds].sort(cmpAscendingId).join(',')

  // Forward (disjoint) or cyclic (sub-pool clamp) walk over ranks; each
  // visited seed is run once, deduped by completed pack.
  const rankCount = cyclic ? ratedPool.length : ratedPool.length - start
  const continuity: PackProposal[] = []
  const rated: PackProposal[] = []
  const seenPacks: string[] = []
  let cards = 0
  if (continuitySeed != null) {
    const plan = runPack(index, req, continuitySeed)
    seenPacks.push(packKey(plan.variantIds))
    continuity.push(toProposal(continuitySeed, plan, 'continuity'))
    cards++
  }
  for (let n = 0; n < rankCount && cards < PROPOSAL_COUNT; n++) {
    const seedId = cyclic ? ratedPool[(start + n) % ratedPool.length] : ratedPool[start + n]
    const plan = runPack(index, req, seedId)
    // Amendment Decision 3: dedupe COMPLETED packs, not seeds — distinct
    // seeds can complete to the same variantId set (order-insensitive;
    // the plan has no day/slot assignment). The next ranked seed takes
    // the slot; pool exhaustion renders fewer cards, never a duplicate.
    const key = packKey(plan.variantIds)
    if (seenPacks.includes(key)) continue
    seenPacks.push(key)
    rated.push(toProposal(seedId, plan, 'rated'))
    cards++
  }

  // Waste-first ranking (Decision 1) among the rated proposals; the
  // continuity proposal stays pinned at #1 in add mode (Decision 4).
  rated.sort(
    (a, b) =>
      a.packagesBought - b.packagesBought ||
      ratingOf(b.seedId) - ratingOf(a.seedId) ||
      a.seedId - b.seedId,
  )
  return [...continuity, ...rated]
}
