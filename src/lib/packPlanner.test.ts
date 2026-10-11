import { describe, expect, test } from 'bun:test'
import {
  buildAutoPlan,
  buildAutoPlanProposals,
  MAX_MEALS,
  MIN_MEALS,
  PROPOSAL_COUNT,
  type PackIndex,
} from './packPlanner'

/**
 * Tiny hand-built indexes for semantic assertions. Rows are the committed
 * index shape `[keyId, amount, unitId, isContainer]`.
 */
function idx(
  recipes: Record<string, { i: Array<[number, number, number, number]>; s: number }>,
  opts: { ingredientKeys?: string[]; unitKeys?: string[]; pantry?: string[] } = {},
): PackIndex {
  return {
    generatedAt: 'test',
    count: Object.keys(recipes).length,
    pantryStaples: opts.pantry ?? [],
    ingredientKeys: opts.ingredientKeys ?? ['ingA', 'ingB'],
    unitKeys: opts.unitKeys ?? ['', 'pkg|(142 g)'],
    recipes,
  }
}

/** Ratings map literal (builder_data.variant_meta injects these in prod). */
function ratings(entries: Array<[number, number]>): ReadonlyMap<number, number> {
  return new Map(entries)
}

describe('buildAutoPlan', () => {
  test('clamps count into 1..10', () => {
    const index = idx({ '1': { i: [], s: 0 } })
    expect(buildAutoPlan(index, { count: 0 }).variantIds).toEqual([1])
    expect(buildAutoPlan(index, { count: -5 }).variantIds).toEqual([1])
    expect(buildAutoPlan(index, { count: 99 }).variantIds).toEqual([1])
    // 99 clamps to MAX_MEALS, so the warning reports the clamped target.
    expect(buildAutoPlan(index, { count: 99 }).warnings).toEqual([
      `Pool exhausted at 1/${MAX_MEALS} meals`,
    ])
    expect(MIN_MEALS).toBe(1)
    expect(MAX_MEALS).toBe(10)
  })

  test('empty pool → empty plan + warning', () => {
    const plan = buildAutoPlan(idx({}), { count: 4 })
    expect(plan.variantIds).toEqual([])
    expect(plan.packagesBought).toBe(0)
    expect(plan.scoredIngredients).toBe(0)
    expect(plan.warnings).toEqual(['No eligible recipes for this plan'])
  })

  test('fully-excluded pool behaves like an empty pool', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, { count: 4, excludeIds: [1, 2] })
    expect(plan.variantIds).toEqual([])
    expect(plan.warnings).toEqual(['No eligible recipes for this plan'])
  })

  test('count > pool → partial pack + warning', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, { count: 4 })
    expect(plan.variantIds).toEqual([1, 2])
    expect(plan.warnings).toEqual(['Pool exhausted at 2/4 meals'])
  })

  test('excluded ids never appear (duplicate excludes tolerated)', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 }, '3': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, { count: 2, excludeIds: [1, 1] })
    expect(plan.variantIds).not.toContain(1)
    expect(plan.variantIds).toEqual([2, 3])
  })

  test('seed = highest rating, ties → lowest id', () => {
    const index = idx({ '7': { i: [], s: 0 }, '4': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, {
      count: 1,
      ratings: ratings([
        [7, 0.9],
        [4, 0.9],
      ]),
    })
    expect(plan.variantIds).toEqual([4])
  })

  test('later slots: exact score tie → higher rating, then lower id', () => {
    // All-linear rows: every candidate's marginal package cost is 0, so
    // scores differ only by rating.
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
    })
    const plan = buildAutoPlan(index, {
      count: 3,
      ratings: ratings([
        [1, 0.4],
        [2, 0.9],
        [3, 0.4],
      ]),
    })
    // Seed: 2 (rating 0.9). Slots 2-3: 1 and 3 tie at the same score →
    // higher rating first (equal) → lower id first.
    expect(plan.variantIds).toEqual([2, 1, 3])
  })

  test('sharing a container beats opening a new one', () => {
    // Recipe 3 opens a DIFFERENT container of ingA (marginal 1) — even at
    // a decent rating, the package cost dominates, so 2 is picked next.
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
      '3': { i: [[0, 1, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 1.0],
        [2, 0.1],
        [3, 0.5],
      ]),
    })
    expect(plan.variantIds).toEqual([1, 2])
    expect(plan.packagesBought).toBe(1)
  })

  test('package marginal cost outweighs any rating gap', () => {
    // Two recipes both need ingA. Recipe 1 adds a package (marginal 1),
    // recipe 2 is container-free (marginal 0). Rating gap of the full
    // 0..1 range swings the score by at most 0.25 < 1 → waste still wins.
    const index = idx({
      '1': { i: [[0, 1, 1, 1]], s: 1 },
      '2': { i: [[1, 2, 0, 0]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 1.0],
        [2, 0.0],
      ]),
    })
    // Seed 1 (rating 1.0). Slot 2 must take 2 despite rating 0: opening a
    // duplicate package would cost 1 > 0.25.
    expect(plan.variantIds).toEqual([1, 2])
    expect(plan.packagesBought).toBe(1)
  })

  test('fractional containers ceil-merge: ½ + 1½ = 2 packages', () => {
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 1.5, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([]),
    })
    expect(plan.packagesBought).toBe(2)
  })

  test('distinct containers of the same ingredient do NOT share', () => {
    // unitId 1 vs 2 → different container keys (e.g. `pkg|(142 g)` vs
    // `pkg|(454 g)`) → two separate packages.
    const index = idx({
      '1': { i: [[0, 1, 1, 1]], s: 1 },
      '2': { i: [[0, 1, 2, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, { count: 2 })
    expect(plan.packagesBought).toBe(2)
  })

  test('pantry staples are present-but-free and never scored', () => {
    const index = idx(
      {
        '1': { i: [[0, 5, 1, 1]], s: 0 },
        '2': { i: [[0, 5, 1, 1]], s: 0 },
      },
      { ingredientKeys: ['olive oil'], pantry: ['olive oil'] },
    )
    const plan = buildAutoPlan(index, { count: 2 })
    expect(plan.packagesBought).toBe(0)
    expect(plan.scoredIngredients).toBe(0)
  })

  test('pantry rows never drive selection over a scored alternative', () => {
    // Recipe 1: pantry-only footprint. Recipe 2: real ingredient. Ratings
    // equal → seed is the lower id; slot 2 takes 2 (score 0 + rating term)
    // — but the pantry candidate would also score 0 here, so pin the id
    // order instead: seed 1, then 2 (lower id than 3).
    const index = idx(
      {
        '1': { i: [[0, 1, 1, 1]], s: 0 },
        '2': { i: [[1, 1, 0, 0]], s: 1 },
        '3': { i: [[1, 1, 0, 0]], s: 1 },
      },
      { ingredientKeys: ['olive oil', 'ingB'], pantry: ['olive oil'] },
    )
    const plan = buildAutoPlan(index, { count: 3 })
    expect(plan.variantIds).toEqual([1, 2, 3])
    expect(plan.packagesBought).toBe(0)
    expect(plan.scoredIngredients).toBe(1)
  })

  test('linear measures add freely — zero packages', () => {
    const index = idx({
      '1': { i: [[0, 2, 0, 0], [1, 0.25, 0, 0]], s: 2 },
      '2': { i: [[0, 3, 0, 0], [1, 1, 0, 0]], s: 2 },
    })
    const plan = buildAutoPlan(index, { count: 2 })
    expect(plan.packagesBought).toBe(0)
    expect(plan.scoredIngredients).toBe(2)
    expect(plan.variantIds).toEqual([1, 2])
  })

  test('zero-amount container rows ("to taste") are free', () => {
    const index = idx({
      '1': { i: [[0, 0, 1, 1]], s: 1 },
      '2': { i: [[0, 1, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, { count: 2 })
    expect(plan.packagesBought).toBe(1)
  })

  test('determinism: same inputs → identical output object', () => {
    const index = idx(
      {
        '1': { i: [[0, 0.5, 1, 1]], s: 1 },
        '2': { i: [[1, 2, 0, 0]], s: 1 },
        '3': { i: [[0, 1, 1, 1]], s: 1 },
        '4': { i: [[1, 1, 0, 0]], s: 1 },
      },
      {},
    )
    const req = { count: 3, ratings: ratings([[1, 0.9]]) }
    const a = buildAutoPlan(index, req)
    const b = buildAutoPlan(index, req)
    expect(a).toEqual(b)
  })

  test('packagesBought and scoredIngredients describe the final pack', () => {
    // Pack of 2: two shared pkgs of ingA + ingB linear only.
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1], [1, 2, 0, 0]], s: 2 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, { count: 2 })
    expect(plan.variantIds.length).toBe(2)
    expect(plan.packagesBought).toBe(1)
    expect(plan.scoredIngredients).toBe(2)
  })
})

describe('buildAutoPlan v2 (ADR-0027)', () => {
  test('baseIds pre-commit waste, never picked, not in variantIds', () => {
    // Base owns 1/2 pkg of ingA. Candidates: 2 (also 1/2 pkg of ingA —
    // marginal 0 WITH the base, 1 without), 3 (fresh ingB package).
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
      '3': { i: [[1, 1, 1, 1]], s: 1 },
    })
    const withBase = buildAutoPlan(index, {
      count: 2,
      baseIds: [1],
      ratings: ratings([
        [2, 0.2],
        [3, 1.0],
      ]),
    })
    // Seed 3 (rating 1.0); slot 2 takes 2 because the base already
    // committed half its package (score 0.2 vs 3's... 2 is the only
    // other candidate — pin the order and the ledger).
    expect(withBase.variantIds).toEqual([3, 2])
    expect(withBase.variantIds).not.toContain(1)
    expect(withBase.packagesBought).toBe(2)
    // Without the base the same request picks 1 over 2 (both would open
    // the ingA package at full price; 1 has the higher rating).
    const withoutBase = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 0.9],
        [2, 0.2],
        [3, 1.0],
      ]),
    })
    expect(withoutBase.variantIds).toEqual([3, 1])
    expect(withoutBase.packagesBought).toBe(2)
  })

  test('packagesBought/scoredIngredients describe the FULL pack (base + additions)', () => {
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1], [1, 2, 0, 0]], s: 2 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
    })
    const combined = buildAutoPlan(index, {
      count: 1,
      baseIds: [1],
      ratings: ratings([[2, 0.2]]),
    })
    // Base 1/2 + addition 1/2 share ONE package; ingB is linear (free).
    expect(combined.packagesBought).toBe(1)
    expect(combined.scoredIngredients).toBe(2)
    expect(combined.variantIds).toEqual([2])
  })

  test('tag penalty flips a pick', () => {
    // Seed 1 (rating 0.9). Recipes 2 and 3 tie on waste AND rating; 2
    // shares tag 7 with the seed, 3 has a fresh tag -> 3 wins slot 2.
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
    })
    const tags = new Map([
      [1, [7]],
      [2, [7]],
      [3, [8]],
    ])
    const plan = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 0.9],
        [2, 0.5],
        [3, 0.5],
      ]),
      tags,
    })
    expect(plan.variantIds).toEqual([1, 3])
    // Without tags the id tiebreak would pick 2.
    const noTags = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 0.9],
        [2, 0.5],
        [3, 0.5],
      ]),
    })
    expect(noTags.variantIds).toEqual([1, 2])
  })

  test('tag overlap counts BASE meals too', () => {
    // Base 1 carries tag 7. Candidates 2 (tag 7) and 3 (tag 8) tie on
    // rating; 4 seeds (0.6). Slot 2: 3 (fresh) beats 2 (shares the BASE
    // tag). Slot 3 takes the remaining 2.
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
      '4': { i: [], s: 0 },
    })
    const tags = new Map([
      [1, [7]],
      [2, [7]],
      [3, [8]],
    ])
    const plan = buildAutoPlan(index, {
      count: 3,
      baseIds: [1],
      ratings: ratings([
        [2, 0.5],
        [3, 0.5],
        [4, 0.6],
      ]),
      tags,
    })
    expect(plan.variantIds).toEqual([4, 3, 2])
  })

  test('rotating seed: gen 0 = highest rating; gen g takes rank g mod K', () => {
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
      '4': { i: [], s: 0 },
      '5': { i: [], s: 0 },
      '6': { i: [], s: 0 },
    })
    const req = (generation: number) => ({
      count: 1,
      seedGeneration: generation,
      ratings: ratings([
        [1, 0.9],
        [2, 0.85],
        [3, 0.8],
        [4, 0.75],
        [5, 0.7],
        [6, 0.6],
      ]),
    })
    // Top-5 by rating: 1,2,3,4,5 (6 is rank 5, outside K).
    expect(buildAutoPlan(index, req(0)).variantIds).toEqual([1])
    expect(buildAutoPlan(index, req(1)).variantIds).toEqual([2])
    expect(buildAutoPlan(index, req(2)).variantIds).toEqual([3])
    expect(buildAutoPlan(index, req(3)).variantIds).toEqual([4])
    expect(buildAutoPlan(index, req(4)).variantIds).toEqual([5])
    // Wraps around.
    expect(buildAutoPlan(index, req(5)).variantIds).toEqual([1])
    expect(buildAutoPlan(index, req(6)).variantIds).toEqual([2])
  })

  test('rotation is stable per generation (determinism contract v2)', () => {
    const index = idx({ '1': { i: [] , s: 0 }, '2': { i: [], s: 0 } })
    const req = { count: 2, seedGeneration: 1, ratings: ratings([[1, 0.5], [2, 0.4]]) }
    expect(buildAutoPlan(index, req)).toEqual(buildAutoPlan(index, req))
  })

  test('count counts NEW meals only (base excluded)', () => {
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
    })
    const plan = buildAutoPlan(index, {
      count: 3,
      baseIds: [1, 2],
      ratings: ratings([[3, 0.5]]),
    })
    // Only 1 candidate remains: 1 new meal, warning reflects 1/3.
    expect(plan.variantIds).toEqual([3])
    expect(plan.warnings).toEqual(['Pool exhausted at 1/3 meals'])
  })

  test('base-only pool (no candidates) warns without the empty-pool text', () => {
    const index = idx({ '1': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, { count: 2, baseIds: [1] })
    expect(plan.variantIds).toEqual([])
    expect(plan.warnings).toEqual(['Pool exhausted at 0/2 meals'])
    expect(plan.packagesBought).toBe(0)
    expect(plan.scoredIngredients).toBe(0)
  })

  test('base ids outside the index commit nothing and stay out of picks', () => {
    const index = idx({ '2': { i: [[0, 1, 1, 1]], s: 1 }, '3': { i: [], s: 0 } })
    const plan = buildAutoPlan(index, { count: 2, baseIds: [99] })
    expect(plan.variantIds.length).toBe(2)
    expect(plan.packagesBought).toBe(1)
  })

  test('duplicate base ids commit once', () => {
    const index = idx({ '1': { i: [[0, 1, 1, 1]], s: 1 } })
    const plan = buildAutoPlan(index, { count: 1, baseIds: [1, 1] })
    expect(plan.packagesBought).toBe(1)
  })
})

describe('buildAutoPlan v2 hardening (qodo round 1)', () => {
  test('non-finite / negative generation degrades to 0 instead of NaN', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 } })
    const voteRatings = ratings([
      [1, 0.9],
      [2, 0.8],
    ])
    // Number.MAX_VALUE + 1 → Infinity in the UI counter: gen % k must
    // never be NaN (undefined seed).
    expect(buildAutoPlan(index, { count: 1, seedGeneration: Number.MAX_VALUE, ratings: voteRatings }).variantIds).toEqual([1])
    expect(buildAutoPlan(index, { count: 1, seedGeneration: Infinity, ratings: voteRatings }).variantIds).toEqual([1])
    expect(buildAutoPlan(index, { count: 1, seedGeneration: -3, ratings: voteRatings }).variantIds).toEqual([1])
    expect(buildAutoPlan(index, { count: 1, seedGeneration: NaN, ratings: voteRatings }).variantIds).toEqual([1])
  })

  test('scaled base meals ceil their container rows (ADR-0017)', () => {
    // Base 1 owns 1/2 pkg of ingA, planned at 12 servings (factor 2) →
    // ceil(0.5·2) = 1 package committed. Candidates 2 (another 1/2 pkg
    // ingA) and 3 (1/2 pkg of fresh ingB) both cost 1 marginal package.
    // Tie on score AND rating → lower id seeds first.
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
      '3': { i: [[1, 0.5, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 2,
      baseIds: [1],
      baseServings: new Map([[1, 12]]),
      ratings: ratings([
        [2, 0.9],
        [3, 0.9],
      ]),
    })
    expect(plan.variantIds).toEqual([2, 3])
    // Ledger: ingA 1 (scaled) + 0.5 + 0.5 = ceil(2.0) = 2, ingB 0.5 = 1.
    expect(plan.packagesBought).toBe(3)
  })

  test('unscaled base keeps v1 ledger behavior', () => {
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 1,
      baseIds: [1],
      ratings: ratings([[2, 0.5]]),
    })
    expect(plan.packagesBought).toBe(1)
  })
})

describe('buildAutoPlan v3 (ADR-0031 household favourites)', () => {
  /** Two candidates whose every scoring term is equal: same (zero) waste,
   *  same rating, no tags. Only `favoriteIds` can break the tie. */
  function tiedIndex(): PackIndex {
    return idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
    })
  }

  test('absent favoriteIds == v2 arithmetic (the e2e pin contract)', () => {
    const index = tiedIndex()
    const req = {
      count: 3,
      ratings: ratings([
        [1, 0.5],
        [2, 0.5],
        [3, 0.5],
      ]),
    }
    expect(buildAutoPlan(index, req).variantIds).toEqual([1, 2, 3])
    // An EMPTY set must be indistinguishable from an absent one.
    expect(buildAutoPlan(index, { ...req, favoriteIds: new Set<number>() }).variantIds).toEqual([
      1, 2, 3,
    ])
  })

  test('favourite bonus flips an exact tie', () => {
    const index = tiedIndex()
    const req = {
      count: 3,
      ratings: ratings([
        [1, 0.5],
        [2, 0.5],
        [3, 0.5],
      ]),
    }
    // Slot 1 is the seed (rating-only ranking, so id 1); slots 2-3 would
    // take 2 then 3 — but 3 is a household favourite, so it wins slot 2.
    expect(buildAutoPlan(index, { ...req, favoriteIds: new Set([3]) }).variantIds).toEqual([1, 3, 2])
  })

  test('the bonus never outvotes waste', () => {
    // Same shape as the "package marginal cost outweighs any rating gap"
    // case: 0.05 < 1 opened package, so the container-free recipe still
    // wins even when the opening one is a favourite AND better rated.
    const index = idx({
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
      '3': { i: [[1, 2, 0, 0]], s: 1 },
    })
    const plan = buildAutoPlan(index, {
      count: 2,
      ratings: ratings([
        [1, 0.5],
        [2, 0.5],
        [3, 0.5],
      ]),
      favoriteIds: new Set([3]),
    })
    expect(plan.variantIds).toEqual([1, 3])
  })

  test('bonus does not move the rotating seed', () => {
    // Favouriting the LOWEST-rated candidate must not let it anchor the
    // pack: the seed ranks on rating alone (ADR-0031).
    const index = tiedIndex()
    const plan = buildAutoPlan(index, {
      count: 1,
      ratings: ratings([
        [1, 0.9],
        [2, 0.2],
        [3, 0.2],
      ]),
      favoriteIds: new Set([2]),
    })
    expect(plan.variantIds).toEqual([1])
  })

  test('an over-sized rating gap still outranks a favourite bonus', () => {
    // FAVORITE_BONUS (0.05) < one rating swing: a 0.4 rating gap
    // (0.25*0.4 = 0.1) cannot be flipped by the bonus alone.
    const index = tiedIndex()
    const req = { count: 2 }
    const baseline = ratings([
      [1, 0.6],
      [2, 0.6],
      [3, 0.6],
    ])
    const withoutFavorite = buildAutoPlan(index, { ...req, ratings: baseline })
    const withFavorite = buildAutoPlan(index, {
      ...req,
      ratings: ratings([
        [1, 0.6],
        [2, 0.2],
        [3, 0.6],
      ]),
      favoriteIds: new Set([2]),
    })
    expect(withoutFavorite.variantIds).toEqual([1, 2])
    expect(withFavorite.variantIds).toEqual([1, 3])
  })
})

describe('buildAutoPlanProposals (ADR-0080)', () => {
  test('exports PROPOSAL_COUNT = 3', () => {
    expect(PROPOSAL_COUNT).toBe(3)
  })

  test('returns up to 3 proposals from the top-rated window', () => {
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
      '4': { i: [], s: 0 },
      '5': { i: [], s: 0 },
    })
    const req = {
      count: 1,
      ratings: ratings([
        [1, 0.9],
        [2, 0.85],
        [3, 0.8],
        [4, 0.75],
        [5, 0.7],
      ]),
    }
    const proposals = buildAutoPlanProposals(index, req)
    expect(proposals).toHaveLength(PROPOSAL_COUNT)
    // Every proposal is a distinct pack, and each is exactly its seed at count 1.
    const seedIds = proposals.map((p) => p.seedId)
    expect(new Set(seedIds).size).toBe(3)
    expect(proposals.map((p) => p.variantIds)).toEqual([[1], [2], [3]])
    // No base → no continuity proposal.
    expect(proposals.every((p) => p.kind === 'rated')).toBe(true)
  })

  test('fewer eligible candidates than PROPOSAL_COUNT → fewer proposals', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 } })
    const proposals = buildAutoPlanProposals(index, { count: 1 })
    expect(proposals).toHaveLength(2)
  })

  test('waste-first ranking: a 4-package proposal ranks above an 8-package one regardless of seed rating', () => {
    // Seed 1 is the highest-rated but anchors an 8-package pack; seed 2
    // rates lower but its pack (sharing completion) buys fewer packages.
    const index = idx({
      '1': { i: [[0, 8, 1, 1]], s: 1 },
      '2': { i: [[0, 4, 1, 1]], s: 1 },
      '3': { i: [[1, 6, 1, 1]], s: 1 },
      '4': { i: [[0, 0.5, 1, 1]], s: 1 },
    })
    const proposals = buildAutoPlanProposals(index, {
      count: 2,
      ratings: ratings([
        [1, 0.9],
        [2, 0.8],
        [3, 0.7],
        [4, 0.1],
      ]),
    })
    expect(proposals.map((p) => p.seedId)).toEqual([2, 3, 1])
    expect(proposals.map((p) => p.packagesBought)).toEqual([5, 7, 9])
    // Sorted ascending by packagesBought — waste first.
    const pkgs = proposals.map((p) => p.packagesBought)
    expect([...pkgs].sort((a, b) => a - b)).toEqual(pkgs)
  })

  test('add mode: continuity seed (lowest marginal cost vs the base ledger) is pinned proposal #1', () => {
    const index = idx({
      '10': { i: [[0, 2, 1, 1]], s: 1 }, // base: 2 pkg of ingA
      '1': { i: [[0, 0.5, 1, 1]], s: 1 }, // shares ingA — marginal 1
      '5': { i: [[1, 2, 1, 1]], s: 1 }, // opens ingB — marginal 2
      '6': { i: [[2, 2, 1, 1]], s: 1 }, // opens ingC — marginal 2
    })
    const proposals = buildAutoPlanProposals(index, {
      count: 1,
      baseIds: [10],
      ratings: ratings([
        [1, 0.5],
        [5, 0.9],
        [6, 0.8],
      ]),
    })
    expect(proposals).toHaveLength(3)
    // The LOWEST-rated sharing candidate anchors proposal #1 — the ledger
    // extends instead of opening new packages.
    expect(proposals[0].seedId).toBe(1)
    expect(proposals[0].kind).toBe('continuity')
    expect(proposals.slice(1).every((p) => p.kind === 'rated')).toBe(true)
    // packagesBought describes base + additions (2 + 0.5 → 3 packages).
    expect(proposals[0].packagesBought).toBe(3)
    // Base meals never appear as picks.
    expect(proposals[0].variantIds).toEqual([1])
    expect(proposals.every((p) => !p.variantIds.includes(10))).toBe(true)
  })

  test('continuity tie → smoothed rating desc; full tie → lower id', () => {
    const base = { '10': { i: [[0, 2, 1, 1]], s: 1 } }
    const sharers = {
      '1': { i: [[0, 0.5, 1, 1]], s: 1 },
      '2': { i: [[0, 0.5, 1, 1]], s: 1 },
    }
    const higherRatedWins = buildAutoPlanProposals(idx({ ...base, ...sharers }), {
      count: 1,
      baseIds: [10],
      ratings: ratings([
        [1, 0.5],
        [2, 0.9],
      ]),
    })
    expect(higherRatedWins[0]).toMatchObject({ seedId: 2, kind: 'continuity' })
    const lowerIdWins = buildAutoPlanProposals(idx({ ...base, ...sharers }), {
      count: 1,
      baseIds: [10],
      ratings: ratings([
        [1, 0.9],
        [2, 0.9],
      ]),
    })
    expect(lowerIdWins[0]).toMatchObject({ seedId: 1, kind: 'continuity' })
  })

  test('window rotation: generation w starts the window at rank w mod 3, wrapping', () => {
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
      '3': { i: [], s: 0 },
      '4': { i: [], s: 0 },
      '5': { i: [], s: 0 },
    })
    const req = {
      count: 1,
      ratings: ratings([
        [1, 0.9],
        [2, 0.85],
        [3, 0.8],
        [4, 0.75],
        [5, 0.7],
      ]),
    }
    const seedsOf = (gen: number) =>
      buildAutoPlanProposals(index, { ...req, seedGeneration: gen }).map((p) => p.seedId)
    expect(seedsOf(0)).toEqual([1, 2, 3])
    expect(seedsOf(1)).toEqual([2, 3, 4])
    expect(seedsOf(2)).toEqual([3, 4, 5])
    // mod 3 wraps: generation 3 shows generation 0's window again.
    expect(seedsOf(3)).toEqual([1, 2, 3])
  })

  test('dedupe: a continuity seed that coincides with a window seed is replaced by the next distinct one', () => {
    const index = idx({
      '10': { i: [[0, 2, 1, 1]], s: 1 },
      '1': { i: [[0, 0.5, 1, 1]], s: 1 }, // top-rated AND lowest marginal → continuity + window[0]
      '2': { i: [[1, 2, 1, 1]], s: 1 },
      '3': { i: [[2, 2, 1, 1]], s: 1 },
    })
    const proposals = buildAutoPlanProposals(index, {
      count: 1,
      baseIds: [10],
      ratings: ratings([
        [1, 0.9],
        [2, 0.8],
        [3, 0.7],
      ]),
    })
    const seedIds = proposals.map((p) => p.seedId)
    expect(seedIds).toEqual([1, 2, 3]) // all distinct, continuity pinned
    expect(new Set(seedIds).size).toBe(3)
    expect(proposals[0].kind).toBe('continuity')
  })

  test('determinism: same request → identical proposal list', () => {
    const index = idx({
      '1': { i: [[0, 3, 1, 1]], s: 1 },
      '2': { i: [[0, 2, 1, 1]], s: 1 },
      '3': { i: [[1, 2, 1, 1]], s: 1 },
      '4': { i: [[1, 1, 1, 1]], s: 1 },
      '5': { i: [[2, 2, 1, 1]], s: 1 },
    })
    const req = {
      count: 3,
      seedGeneration: 1,
      ratings: ratings([
        [1, 0.9],
        [2, 0.8],
        [3, 0.75],
        [4, 0.6],
        [5, 0.5],
      ]),
    }
    expect(JSON.stringify(buildAutoPlanProposals(index, req))).toBe(
      JSON.stringify(buildAutoPlanProposals(index, req)),
    )
  })

  test('add mode: baseIds footprints pre-commit into EVERY proposal (shared packages)', () => {
    const index = idx({
      '10': { i: [[0, 2, 1, 1]], s: 1 },
      '1': { i: [[0, 1, 1, 1]], s: 1 },
      '2': { i: [[1, 2, 1, 1]], s: 1 },
      '3': { i: [[2, 2, 1, 1]], s: 1 },
      '4': { i: [[3, 2, 1, 1]], s: 1 },
      '5': { i: [[4, 2, 1, 1]], s: 1 },
    })
    const proposals = buildAutoPlanProposals(index, {
      count: 2,
      baseIds: [10],
      ratings: ratings([
        [1, 0.9],
        [2, 0.8],
        [3, 0.7],
        [4, 0.6],
        [5, 0.5],
      ]),
    })
    // Every pack pays for the base's ingA container (2 pkg) plus its own.
    expect(proposals.every((p) => p.packagesBought >= 3)).toBe(true)
  })

  test('empty pool → no proposals', () => {
    expect(buildAutoPlanProposals(idx({}), { count: 4 })).toEqual([])
  })

  test('a one-candidate pool still yields its proposal at ANY generation (qodo round 1)', () => {
    const index = idx({ '1': { i: [], s: 0 } })
    for (const gen of [0, 1, 2, 7]) {
      const proposals = buildAutoPlanProposals(index, { count: 1, seedGeneration: gen })
      expect(proposals).toHaveLength(1)
      expect(proposals[0].seedId).toBe(1)
    }
  })

  test('a two-candidate pool shows BOTH seeds from every generation (cyclic window)', () => {
    const index = idx({
      '1': { i: [], s: 0 },
      '2': { i: [], s: 0 },
    })
    const req = {
      count: 1,
      ratings: ratings([
        [1, 0.9],
        [2, 0.8],
      ]),
    }
    const gen1 = buildAutoPlanProposals(index, { ...req, seedGeneration: 1 })
    expect(gen1).toHaveLength(2)
    // Old behavior returned an EMPTY list at generation 2 (start past the
    // last seed); the cyclic walk keeps every seed reachable. The ranked
    // OUTPUT order is waste-first (0 packages tie → rating desc), so the
    // window rotation shows up in WHICH seeds are chosen, never the order.
    const gen2 = buildAutoPlanProposals(index, { ...req, seedGeneration: 2 })
    expect(gen2).toHaveLength(2)
    expect(gen2.map((p) => p.seedId).sort((a, b) => a - b)).toEqual([1, 2])
  })

  test('add mode: a continuity seed at the LAST window position still leaves 3 distinct cards (qodo round 1)', () => {
    const index = idx({
      '10': { i: [[0, 2, 1, 1]], s: 1 },
      '1': { i: [[0, 0.5, 1, 1]], s: 1 }, // lowest-rated AND lowest marginal → continuity at window[2]
      '2': { i: [[1, 2, 1, 1]], s: 1 },
      '3': { i: [[2, 2, 1, 1]], s: 1 },
    })
    const proposals = buildAutoPlanProposals(index, {
      count: 1,
      baseIds: [10],
      seedGeneration: 1,
      ratings: ratings([
        [1, 0.7],
        [2, 0.8],
        [3, 0.9],
      ]),
    })
    const seedIds = proposals.map((p) => p.seedId)
    expect(seedIds).toHaveLength(3)
    expect(new Set(seedIds).size).toBe(3)
    expect(proposals[0]).toMatchObject({ seedId: 1, kind: 'continuity' })
    // The rated cards come from the non-continuity seeds, rotating from
    // the generation's window start.
    expect([...seedIds.slice(1)].sort()).toEqual([2, 3])
  })

  test('pool exhaustion warnings ride along on each proposal (qodo round 1)', () => {
    const index = idx({ '1': { i: [], s: 0 }, '2': { i: [], s: 0 } })
    const proposals = buildAutoPlanProposals(index, { count: 4 })
    expect(proposals).toHaveLength(2)
    for (const p of proposals) {
      expect(p.warnings).toEqual(['Pool exhausted at 2/4 meals'])
    }
  })
})
