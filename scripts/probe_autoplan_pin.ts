/**
 * Probe: does the pinned Auto-Plan PROPOSAL still hold after a catalog sync?
 *
 * The e2e pins the generation-0 PRE-SELECTED proposal as [13443, 6389,
 * 11982, 6167] (ADR-0080): the CHEAPEST of the waste-ranked proposals —
 * packagesBought ASC, then seed rating DESC, then seed id ASC. A catalog
 * sync changes the candidate set, so the pin is only valid if the
 * arithmetic is unchanged. Run this BEFORE
 * `bunx playwright test e2e/auto-plan.spec.ts` so a pin break is
 * diagnosed here instead of in a browser.
 *
 *     bun run scripts/probe_autoplan_pin.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAutoPlanProposals } from '../src/lib/packPlanner'

const PINNED = [13443, 6389, 11982, 6167]

/** Must match the `autoPlanRuleset` default in src/stores/ui.ts: the
 *  default pack is a DINNER pack, and a probe that mirrors the call
 *  without that constraint is not a mirror. It used to be, which is how
 *  the 0f74ee6 re-pin captured a set containing an "Apple Slices" snack
 *  and then reported a healthy pin broken. */
const DEFAULT_RULESET = 'dinner'

const index = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/pack_index.json'), 'utf8')
)
const builder = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/builder_data.json'), 'utf8')
)
// ADR-0054: the household's own recipes merge into the catalog at load and
// ride in dataById, so the mirror has to include them (the app's eligible
// loop iterates catalog.dataById).
const userPayload = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/data/user_recipes.json'), 'utf8')
)
const userEntries: any[] = userPayload.recipes ?? []

const metaById = new Map<number, any>([
  ...builder.variant_meta.map((m: any) => [m.id, m] as const),
  ...userEntries.map((r: any) => [r.meta.id, r.meta] as const),
])

// Mirror useAutoPlan.runAutoPlan exactly (no diets, ruleset 'any', ADD mode):
// every catalog variant is eligible, and ratings are Bayesian-smoothed toward
// the ELIGIBLE-slice mean with the variant's own rating_count as the weight.
const RATING_PRIOR_WEIGHT = 10

const eligible = [...builder.feasible_variants, ...userEntries.map((r: any) => r.meta.id)].filter(
  (v: number) => metaById.get(v)?.ruleset === DEFAULT_RULESET,
)
const mean =
  eligible.reduce((a: number, v: number) => a + (metaById.get(v)?.rating ?? 0), 0) /
  Math.max(1, eligible.length)

const ratings = new Map<number, number>()
for (const v of eligible) {
  const m = metaById.get(v)
  const count = m?.rating_count ?? 0
  ratings.set(v, (((m?.rating ?? 0) * count + mean * RATING_PRIOR_WEIGHT) / (count + RATING_PRIOR_WEIGHT)))
}

const proposals = buildAutoPlanProposals(index as any, {
  count: 4,
  seedGeneration: 0,
  excludeIds: [],
  ratings,
  tags: new Map([...builder.variant_meta, ...userEntries.map((r: any) => r.meta)].map((m: any) => [m.id, m.variety_tag_ids ?? []])),
})

// Mirror AutoPlanDialog.preselectedProposalIndex exactly: the CHEAPEST
// proposal, ties → first in the ranked array.
let best = 0
for (let i = 1; i < proposals.length; i++) {
  if (proposals[i].packagesBought < proposals[best].packagesBought) best = i
}
const got = [...proposals[best].variantIds]
console.log(`catalog: ${builder.feasible_variants.length} variants`)
console.log(
  `proposals: ${proposals.map((p) => `#${p.seedId}(${p.packagesBought} pkg)`).join(' ')}`,
)
console.log(`pinned : [${PINNED.join(', ')}]`)
console.log(`actual : [${got.join(', ')}]`)
const same = got.length === PINNED.length && got.every((v, i) => v === PINNED[i])
if (same) {
  console.log('PIN HOLDS')
} else {
  console.log('PIN BROKEN — update PINNED_DEFAULT_IDS in e2e/auto-plan.spec.ts')
  for (const v of got) console.log(`   ${v}: ${metaById.get(v)?.name}`)
}
process.exit(same ? 0 : 1)
