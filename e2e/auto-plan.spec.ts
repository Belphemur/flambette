import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  dismissJoinCongrats,
  expectZeroMealimeRequests,
  gotoTab,
  liveRoomCode,
  waitForCatalog,
} from './helpers'

/**
 * Auto-Plan (ADR-0024 + ADR-0027 v2): deterministic waste-first pack
 * builder with completion (add) semantics, rating smoothing, variety-tag
 * penalty and a rotating seed.
 *
 * The default 4-pack for a FRESH profile is PINNABLE — v2 defaults:
 * ruleset dinner, add mode on an empty plan, generation 0. The pin
 * changed from phase 19's [4908, 6185, 6729, 12069] BY DESIGN (smoothing
 * killed the 1-2-vote 1.0s; the ruleset filter killed the dessert; the
 * whole pack is dinner now). Any catalog or scoring change breaks the
 * pin loudly — that is the point.
 */

// The generation-0 4-pack after the 2,759-recipe catalog sync (2026-10-02).
// The 29 new recipes change the eligible-slice rating mean AND enter the
// candidate pool, so the arithmetic legitimately moves — but only inside the
// DINNER slice: `ui.autoPlanRuleset` defaults to 'dinner', so that is the
// eligible set the seed ranks over.
//
// The 0f74ee6 re-pin here ([17452, 23775, 19678, 22308]) was captured from
// `scripts/probe_autoplan_pin.ts` while that probe mirrored the planner with
// NO ruleset constraint, so it sampled the whole catalog and picked up
// "Apple Slices with Cinnamon-Honey Peanut Butter" — a snack, in a pack the
// app can never generate. The probe now applies the dinner default and
// reports the pack below as HOLDS. A pin is only worth anything if the thing
// producing it is a faithful mirror; verify with the probe, not by eye.
// The generation-0 pre-selected proposal under ADR-0080 (fresh profile,
// dinner, empty plan, replace-on-empty press): the CHEAPEST of the three
// waste-ranked proposals — the 4-package pack anchored on #13443, down
// from the 8-package rating-ranked v2 anchor #17452. The old pin breaking
// loudly IS the contract working (ADR-0027 §Consequences, ADR-0080).
const PINNED_DEFAULT_IDS = [13443, 6389, 11982, 6167]

/** Open + generate in the Auto-Plan dialog with the DEFAULT count 4. */
async function generate(page: Page): Promise<void> {
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  // The count input persists across dialog opens within a page — pin the
  // default explicitly so helpers are order-independent.
  await page.getByTestId('auto-plan-count').fill('4')
  await page.getByTestId('auto-plan-count').blur()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
}

/** Apply (add mode) / confirm (replace mode) the generated pack. */
async function confirm(page: Page): Promise<void> {
  await page.getByTestId('auto-plan-confirm').click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeHidden()
}

/** Generate with a fixed meals count via the number input. */
async function generateWithCount(page: Page, count: number): Promise<void> {
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-count').fill(String(count))
  await page.getByTestId('auto-plan-count').blur()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
}

/** Variant ids currently in the persisted plan (via Pinia). */
async function plannedIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    const entries = pinia?.state?.value?.plan?.plan ?? []
    return entries.map((e: { variantId: number }) => e.variantId)
  })
}

/** Full plan entries {variantId, servings} via Pinia. */
async function plannedEntries(page: Page): Promise<Array<{ variantId: number; servings: number }>> {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    const entries = pinia?.state?.value?.plan?.plan ?? []
    return entries.map((e: { variantId: number; servings: number }) => ({
      variantId: e.variantId,
      servings: e.servings,
    }))
  })
}

/** Force the persisted seed generation (determinism control). */
async function setGeneration(page: Page, generation: number): Promise<void> {
  await page.evaluate((g) => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    pinia.state.value.ui.autoPlanGeneration = g
  }, generation)
}

/** Read the persisted Auto-Plan seed generation (via Pinia). */
async function readGeneration(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return pinia?.state?.value?.ui?.autoPlanGeneration as number
  })
}

/**
 * Click the dialog's Generate/Regenerate button. The previous pack's
 * tiles stay mounted for the whole await, so "a tile is visible" is NOT
 * a completion signal (qodo PR #14 thread 2) — waiting on it let a
 * Regenerate press read the old pack back. `previewIds` below waits on
 * the dialog's busy state, which IS the only honest "this pack is final"
 * signal, so the press helper stays a plain click.
 */
async function pressGenerate(page: Page): Promise<void> {
  await page.getByTestId('auto-plan-generate').click()
}

/** Variant ids of the SELECTED proposal card in the open preview (ADR-0080). */
async function previewIds(page: Page): Promise<number[]> {
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  // A finished run leaves "Generating…"; a FAILED one leaves the previous
  // preview up, which is also a settled state to read.
  await expect(page.getByTestId('auto-plan-generate')).not.toHaveText('Generating…', { timeout: 20_000 })
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 20_000 })
  // Scope to the SELECTED card — every card renders its own tiles.
  const tiles = await page
    .locator('[data-test="auto-plan-proposal-selected"] [data-test^="auto-plan-meal-"]')
    .all()
  if (tiles.length === 0) throw new Error('no preview tiles in the selected proposal card')
  const ids: number[] = []
  for (const t of tiles) {
    const raw = await t.getAttribute('data-test')
    if (raw) ids.push(Number(raw.replace('auto-plan-meal-', '')))
  }
  return ids
}

/**
 * The press's PROPOSAL SET: the union of every card's tiles (ADR-0080
 * §Decision 4 — what a Regenerate press rotates is the window, i.e. this
 * set, even when the cheapest pre-selected pack stays the same).
 */
async function proposalSetIds(page: Page): Promise<number[]> {
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  // Same settle waits as previewIds: the press's tiles stay mounted for
  // the whole await, so the busy state is the honest completion signal.
  await expect(page.getByTestId('auto-plan-generate')).not.toHaveText('Generating…', { timeout: 20_000 })
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 20_000 })
  const tiles = await page
    .locator('[data-test^="auto-plan-proposal"] [data-test^="auto-plan-meal-"]')
    .all()
  if (tiles.length === 0) throw new Error('no proposal cards')
  const ids = new Set<number>()
  for (const t of tiles) {
    const raw = await t.getAttribute('data-test')
    if (raw) ids.add(Number(raw.replace('auto-plan-meal-', '')))
  }
  return [...ids].sort((a, b) => a - b)
}

/** Category (builder_data) for each variant id. */
async function metaFor(page: Page, ids: number[]): Promise<Array<{ category?: string; ruleset?: string }>> {
  return page.evaluate(async (variantIds) => {
    const bd = await (await fetch('/data/builder_data.json')).json()
    return variantIds.map((id: number) => ({
      category: bd.variant_data[String(id)]?.category_name,
      ruleset: bd.variant_meta.find((m: { id: number }) => m.id === id)?.ruleset,
    }))
  }, ids)
}

/** Packages number claimed by the SELECTED proposal card (ADR-0080). */
async function previewPackages(page: Page): Promise<number> {
  const text = await page
    .locator('[data-test="auto-plan-proposal-selected"] [data-test="auto-plan-proposal-packages"]')
    .textContent()
  const m = text?.match(/(\d+)/)
  if (!m) throw new Error(`selected proposal missing packages: ${text}`)
  return Number(m[1])
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('fresh profile: generates the pinned 4-meal dinner pack, grocery derives', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generate(page)
  await confirm(page)

  // Exact pinned pack + authored servings, visible in the plan list.
  expect(await plannedEntries(page)).toEqual(
    PINNED_DEFAULT_IDS.map((variantId) => ({ variantId, servings: 6 })),
  )

  // Plan list renders 4 meal rows.
  await expect(page.locator('main ul > li')).toHaveCount(4)

  // Derived grocery has content for the pack.
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main').getByRole('listitem').first()).toBeVisible({
    timeout: 15_000,
  })
  await expectZeroMealimeRequests(page)
})

test('proposals: the cheapest card is pre-selected and every card shows its packages line (ADR-0080)', async ({
  page,
}) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 20_000 })

  // Three cards (PROPOSAL_COUNT), each with its own "buys N packages"
  // line — and exactly ONE selected marker.
  const cards = page.locator('[data-test="auto-plan-proposal"], [data-test="auto-plan-proposal-selected"]')
  await expect(cards).toHaveCount(3)
  const lines = page.getByTestId('auto-plan-proposal-packages')
  await expect(lines).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(lines.nth(i)).toContainText(/buys \d+ packages?/)
  }

  // Waste-first made visible: the SELECTED card's packages number is the
  // minimum across the cards.
  const pkgs = (await lines.allTextContents()).map(
    (t) => Number(t.match(/(\d+)/)![1]),
  )
  const selected = page.getByTestId('auto-plan-proposal-selected')
  await expect(selected).toHaveCount(1)
  const selectedPkgs = Number(
    (await selected.getByTestId('auto-plan-proposal-packages').textContent())!.match(/(\d+)/)![1],
  )
  expect(selectedPkgs).toBe(Math.min(...pkgs))
  await expectZeroMealimeRequests(page)
})

test('proposals: selecting a different card changes what Confirm applies (ADR-0080)', async ({
  page,
}) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 20_000 })

  const cards = page.locator('[data-test="auto-plan-proposal"], [data-test="auto-plan-proposal-selected"]')
  await expect(cards).toHaveCount(3)

  async function cardIds(index: number): Promise<number[]> {
    const tiles = cards.nth(index).locator('[data-test^="auto-plan-meal-"]')
    const raws = await tiles.evaluateAll((els) =>
      els.map((el) => (el.getAttribute('data-test') ?? '').replace('auto-plan-meal-', '')),
    )
    return raws.filter(Boolean).map(Number)
  }

  const preselected = await cardIds(0)
  // Pick a card whose pack differs from the pre-selected one — the floor
  // pack is cheapest and may well be the ONLY 4-package proposal.
  let target = -1
  for (let i = 0; i < 3; i++) {
    if (JSON.stringify(await cardIds(i)) !== JSON.stringify(preselected)) {
      target = i
      break
    }
  }
  expect(target).toBeGreaterThanOrEqual(0)

  await cards.nth(target).click()
  await expect(page.getByTestId('auto-plan-proposal-selected')).toHaveCount(1)
  // Confirm applies ONLY the selected proposal (ADR-0080 Decision 5).
  await expect(page.getByTestId('auto-plan-confirm')).toBeEnabled({ timeout: 20_000 })
  const chosen = await cardIds(target) // read BEFORE confirm closes the dialog
  await confirm(page)
  expect(await plannedIds(page)).toEqual(chosen)
  await expectZeroMealimeRequests(page)
})

test('determinism: same generation → same ids across regenerations', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await generate(page)
  await confirm(page)
  const first = await plannedIds(page)
  expect(first).toEqual(PINNED_DEFAULT_IDS)

  // Clear the plan through the UI, pin the generation back to 0 (the
  // first apply advanced the persisted counter), regenerate: the pack
  // must be identical for the same (catalog, generation).
  await page.getByRole('button', { name: 'Clear plan' }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await setGeneration(page, 0)
  await generate(page)
  await confirm(page)
  expect(await plannedIds(page)).toEqual(first)
  await expectZeroMealimeRequests(page)
})

test('rotation: a Regenerate press rolls the seed, every apply rotates it (ADR-0033)', async ({
  page,
}) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await setGeneration(page, 0)

  // The FIRST press of a dialog reads "Generate" and has no earlier pack
  // to differ from, so it keeps the stored generation (0 → the pinned
  // default pack's seed). This is what keeps the load-bearing pins honest.
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  const first = await previewIds(page)
  expect(first[0]).toBe(PINNED_DEFAULT_IDS[0])
  expect(await readGeneration(page)).toBe(0)

  // From here the button reads "Regenerate" and EVERY press must roll the
  // seed: re-running the same generation would rebuild the identical
  // proposal set, which makes the affordance dead (ADR-0033, ADR-0080 §4).
  // What rotates is the PROPOSAL WINDOW — the card SET differs even when
  // the cheapest pre-selected pack stays the same (the waste-floor pack
  // wins every window it appears in; that is waste-first working).
  await expect(page.getByTestId('auto-plan-generate')).toHaveText('Regenerate')
  const firstSet = await proposalSetIds(page)
  await pressGenerate(page)
  const second = await previewIds(page)
  const secondSet = await proposalSetIds(page)
  expect(await readGeneration(page)).toBe(1)
  expect(secondSet).not.toEqual(firstSet)

  await pressGenerate(page)
  const third = await previewIds(page)
  const thirdSet = await proposalSetIds(page)
  expect(await readGeneration(page)).toBe(2)
  expect(thirdSet).not.toEqual(secondSet)

  // The apply-time advance is KEPT: confirming the pack shown at
  // generation 2 leaves the counter at 3 for the next dialog, so the
  // next pack is never a replay of the one just applied.
  await confirm(page)
  expect(await plannedIds(page)).toEqual(third)
  expect(await readGeneration(page)).toBe(3)
  await expectZeroMealimeRequests(page)
})

test('rotation: a FIXED generation stays stable, successive ones differ', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // Open, read the press's PROPOSAL SET from the preview cards, then
  // close WITHOUT confirming. Each open is a first press, so the pinned
  // generation is what the run uses — the determinism control for the
  // window itself.
  async function firstProposalSet(): Promise<number[]> {
    await page.getByTestId('auto-plan-button').first().click()
    await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
    await pressGenerate(page)
    const ids = await proposalSetIds(page)
    await page.getByTestId('auto-plan-cancel').click()
    await page.getByRole('button', { name: 'Close auto-plan' }).click()
    await expect(page.getByTestId('auto-plan-dialog')).toBeHidden()
    return ids
  }

  await setGeneration(page, 0)
  const gen0 = await firstProposalSet()
  await setGeneration(page, 1)
  const gen1 = await firstProposalSet()
  expect(gen1).not.toEqual(gen0)
  // Stable under repeat of the same generation.
  await setGeneration(page, 1)
  expect(await firstProposalSet()).toEqual(gen1)
  await setGeneration(page, 0)
  expect(await firstProposalSet()).toEqual(gen0)
  await expectZeroMealimeRequests(page)
})

test('count stepper: 1 meal and 10 meals (new meals only)', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generateWithCount(page, 1)
  await confirm(page)
  const ids = await plannedIds(page)
  expect(ids).toHaveLength(1)
  // Gen 0 pre-selects the CHEAPEST proposal (ADR-0080): the 4-package
  // anchor #13443, not the 8-package rating-ranked seed #17452.
  expect(ids[0]).toBe(PINNED_DEFAULT_IDS[0])

  // Reopen; bump the count to 10 by pressing the + stepper.
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  const plus = page.getByTestId('auto-plan-count-plus')
  for (let i = 0; i < 9; i++) await plus.click()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await confirm(page)
  const all = await plannedIds(page)
  expect(all).toHaveLength(11)
  // No duplicates: the base meal is never re-picked (add mode).
  expect(new Set(all).size).toBe(11)
  await expectZeroMealimeRequests(page)
})

test('add mode: pre-seeded plan keeps its meals and appends exactly N', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generateWithCount(page, 1)
  await confirm(page)
  const base = await plannedIds(page)
  expect(base).toEqual([PINNED_DEFAULT_IDS[0]])

  await generateWithCount(page, 3)
  await confirm(page)
  const combined = await plannedIds(page)
  expect(combined).toHaveLength(4)
  // The base stayed in place (still first) and the additions are new ids.
  expect(combined[0]).toBe(PINNED_DEFAULT_IDS[0])
  expect(new Set(combined).size).toBe(4)
  await expectZeroMealimeRequests(page)
})

test('add mode shares waste with the base (combined packages ≤ separate sums)', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // A: one meal alone (gen 0). Cancel — nothing applied, generation stays.
  await setGeneration(page, 0)
  await generateWithCount(page, 1)
  const pAlone = await previewPackages(page)
  await page.getByTestId('auto-plan-cancel').click()
  await page.getByRole('button', { name: 'Close auto-plan' }).click()

  // B: three meals alone (same generation 0, empty plan). Cancel.
  await generateWithCount(page, 3)
  const pThree = await previewPackages(page)
  await page.getByTestId('auto-plan-cancel').click()
  await page.getByRole('button', { name: 'Close auto-plan' }).click()

  // C: apply the single meal, then generate 3 MORE with the SAME
  // generation 0: the combined pack shares the base's packages.
  await setGeneration(page, 0)
  await generateWithCount(page, 1)
  await confirm(page)
  await setGeneration(page, 0)
  await generateWithCount(page, 3)
  const pCombined = await previewPackages(page)

  expect(pCombined).toBeLessThanOrEqual(pAlone + pThree)
  await expectZeroMealimeRequests(page)
})

test('ruleset select: dessert-only run yields only desserts', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-ruleset').click()
  await page.getByTestId('auto-plan-option-dessert').click()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await confirm(page)

  const ids = await plannedIds(page)
  expect(ids.length).toBe(4)
  const metas = await metaFor(page, ids)
  for (const m of metas) expect(m.ruleset).toBe('dessert')
  await expectZeroMealimeRequests(page)
})

test('the taxonomy dropdown offers Lunch and Snack, and Lunch plans only simple meals', async ({ page }) => {
  // ADR-0046 §2.2: the dialog's meal-type options come from
  // mealTypeFilter's exports — the old hard-coded RULESETS list had
  // drifted and left Lunch (`simple`, the biggest occasion) and Snack
  // unreachable from Auto-Plan. The label↔ruleset mapping is the thing
  // that must not silently flip: picking LUNCH must yield ruleset
  // 'simple' meals, which is what the tail of this test pins.
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-ruleset').click()
  const menu = page.getByTestId('auto-plan-ruleset-menu')
  await expect(menu).toBeVisible()
  // Any + the five offered occasions.
  await expect(menu.getByRole('option')).toHaveCount(6)
  await expect(menu.getByRole('option', { name: /^Lunch, \d+ recipes$/ })).toBeVisible()
  await expect(menu.getByRole('option', { name: /^Snack, \d+ recipes$/ })).toBeVisible()

  await page.getByTestId('auto-plan-option-simple').click()
  await expect(page.getByTestId('auto-plan-ruleset')).toContainText('Lunch')
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await confirm(page)

  const ids = await plannedIds(page)
  expect(ids.length).toBe(4)
  const metas = await metaFor(page, ids)
  for (const m of metas) expect(m.ruleset).toBe('simple')
  await expectZeroMealimeRequests(page)
})

test('empty pack (pool exhausted) can never erase or modify the plan', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // dessert + meat leaves no candidates in the catalog → empty pack.
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-ruleset').click()
  await page.getByTestId('auto-plan-option-dessert').click()
  await page.getByTestId('auto-plan-category').click()
  await page.getByTestId('auto-plan-option-meat').click()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-preview')).toBeVisible({ timeout: 15_000 })

  // The apply button stays disabled; the plan is untouched either way.
  await expect(page.getByTestId('auto-plan-confirm')).toBeDisabled()
  await page.getByRole('button', { name: 'Close auto-plan' }).click()
  expect(await plannedIds(page)).toEqual([])
  await expectZeroMealimeRequests(page)
})

test('undo restores the exact previous plan in ADD mode (ids + servings)', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // Seed plan: one meal, then bump its servings by hand.
  await generateWithCount(page, 1)
  await confirm(page)
  const seedId = (await plannedIds(page))[0]
  const metaName = await page.evaluate(async (id) => {
    const bd = await (await fetch('/data/builder_data.json')).json()
    return bd.variant_meta.find((m: { id: number }) => m.id === id)?.name
  }, seedId)
  await page.getByRole('button', { name: `More servings of ${metaName}` }).click()
  await page.getByRole('button', { name: `More servings of ${metaName}` }).click()

  // Snapshot AFTER the bumps — undo restores the plan as it was right
  // before generation (servings included).
  const before = await plannedEntries(page)
  expect(before).toEqual([{ variantId: seedId, servings: 8 }])

  // Generate a 4-meal ADDITION over it, then undo.
  await generate(page)
  await confirm(page)
  expect(await plannedIds(page)).toHaveLength(5)
  const toast = page.locator('[data-test="autoplan-toast-toast"]')
  await expect(toast).toBeVisible()
  await toast.getByTestId('auto-plan-undo').click()
  await expect.poll(() => plannedEntries(page)).toEqual(before)
  await expectZeroMealimeRequests(page)
})

test('cancel keeps the current plan untouched', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generate(page)
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible()
  await page.getByTestId('auto-plan-cancel').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeHidden()
  await page.getByRole('button', { name: 'Close auto-plan' }).click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeHidden()
  expect(await plannedIds(page)).toEqual([])
  await expectZeroMealimeRequests(page)
})

test('room sync: generated plan reaches the second context', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  await a.goto('/plan')
  await expect(a.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // A generates the default pack FIRST so the Plan tab shows the
  // Share button (it only renders on a non-empty plan).
  await generate(a)
  await confirm(a)

  // Start a live room from A's share sheet.
  await a.getByRole('button', { name: 'Share', exact: true }).click()
  await a.getByTestId('start-room').click()
  const code = await liveRoomCode(a)
  const roomUrl = `${a.url().replace(/\/plan.*$/, '')}/plan?room=${code}`

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toHaveAttribute('aria-label', /^Live room /, { timeout: 10_000 })
  await dismissJoinCongrats(b)

  // The plan generated in A arrives in B: A keeps it, B joins mid-plan.
  await expect
    .poll(
      async () => {
        return b.evaluate(() => {
          const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
          return JSON.stringify(pinia?.state?.value?.plan?.plan?.map((e: { variantId: number }) => e.variantId))
        })
      },
      { timeout: 15_000 },
    )
    .toBe(JSON.stringify(PINNED_DEFAULT_IDS))
  await expectZeroMealimeRequests(a)
  await expectZeroMealimeRequests(b)
})

test('diet chip active → generated plan respects it', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await page.getByTestId('diet-chip-vegetarian').click()
  await gotoTab(page, 'Plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generate(page)
  await confirm(page)
  const ids = await plannedIds(page)
  expect(ids.length).toBeGreaterThan(0)
  const metas = await metaFor(page, ids)
  for (const m of metas) expect(m.category).toBe('vegetarian')
  await expectZeroMealimeRequests(page)
})

test('backup export/import round-trips the auto-plan ui slices', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // Change the persisted settings through the dialog.
  await page.getByTestId('auto-plan-button').first().click()
  await page.getByTestId('auto-plan-mode-replace').click()
  await page.getByTestId('auto-plan-ruleset').click()
  await page.getByTestId('auto-plan-option-breakfast').click()
  await page.getByRole('button', { name: 'Close auto-plan' }).click()
  await page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    pinia.state.value.ui.autoPlanGeneration = 42
  })

  // Export via the Settings tab's backup UI, then wipe + import.
  await gotoTab(page, 'Settings')
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-settings').click()
  const download = await downloadPromise
  const path = await download.path()

  await page.evaluate(() => localStorage.clear())
  await page.reload()
  // The reload lands back on Settings — the Auto-Plan button only
  // renders on the Plan tab.
  await gotoTab(page, 'Plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await gotoTab(page, 'Settings')
  await page.getByTestId('import-settings').click()
  await page.getByTestId('import-settings-input').setInputFiles(path)
  // The import confirmation dialog (validate-first, atomic).
  await page.getByTestId('import-settings-confirm').click()
  // Wait for the import to finish before navigating away.
  await expect(page.getByTestId('import-settings')).toBeVisible({ timeout: 15_000 })

  await gotoTab(page, 'Plan')
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-mode-replace')).toHaveAttribute('aria-checked', 'true')
  // The dropdown is a button trigger, not a `<select>`: the persisted
  // ruleset surfaces as the trigger's label (ADR-0046 §2.4).
  await expect(page.getByTestId('auto-plan-ruleset')).toContainText('Breakfast')
  const gen = await page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return pinia.state.value.ui.autoPlanGeneration
  })
  expect(gen).toBe(42)
  await expectZeroMealimeRequests(page)
})

// ---------------------------------------------------------------------------
// Mobile scroll contract (post-ship, ADR-0046 §4): the sheet sits low in a
// phone window and its dropdown popups used to run straight past the
// viewport edge — the owner's screenshot showed the meal-type menu cut at
// the fold with no way to reach Dinner. The popup now clamps to the space
// below its trigger and scrolls inside (the Headless UI anchor-padding
// contract), and the sheet itself scrolls once the preview grid grows.
// ---------------------------------------------------------------------------
test('dropdown popups clamp to the window and scroll to reach every option', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 560 })
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()

  // Meal type: the popup must not run past the bottom of the window…
  const mealMenu = page.getByTestId('auto-plan-ruleset-menu')
  await page.getByTestId('auto-plan-ruleset').click()
  await expect(mealMenu).toBeVisible()
  let box = (await mealMenu.boundingBox())!
  expect(box!.y + box!.height).toBeLessThanOrEqual(560)
  // …and the clamped popup scrolls: the last option (Dinner) is reachable.
  await page.getByTestId('auto-plan-option-dinner').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('auto-plan-option-dinner')).toBeInViewport()
  await page.keyboard.press('Escape')

  // Protein: same contract from the row below it — even less room there.
  const proteinMenu = page.getByTestId('auto-plan-category-menu')
  await page.getByTestId('auto-plan-category').click()
  await expect(proteinMenu).toBeVisible()
  box = (await proteinMenu.boundingBox())!
  expect(box!.y + box!.height).toBeLessThanOrEqual(560)
  await page.getByTestId('auto-plan-option-vegetarian').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('auto-plan-option-vegetarian')).toBeInViewport()
  await expectZeroMealimeRequests(page)
})

test('the sheet keeps BOTH ends reachable once the preview grid grows', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 560 })
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await generate(page)
  const dialog = page.getByTestId('auto-plan-dialog')
  // The scrim is `items-end`, so an unclamped panel overflows UPWARD and
  // clips the header + close button off the top of the window.
  await expect(dialog.getByRole('button', { name: 'Close auto-plan' })).toBeInViewport()
  // The preview's confirm row is inside the panel's own scroll.
  const confirmBtn = page.getByTestId('auto-plan-confirm')
  await confirmBtn.scrollIntoViewIfNeeded()
  await expect(confirmBtn).toBeInViewport()
  await expectZeroMealimeRequests(page)
})
