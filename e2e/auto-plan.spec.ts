import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * Auto-Plan (ADR-0024): deterministic waste-first pack builder.
 * The planner is a pure lib, so the default 4-meal output for a FRESH
 * profile is PINNABLE: [4908, 6185, 6729, 12069] on the committed
 * catalog. Any catalog or scoring change breaks these pins loudly —
 * that is the point.
 */

const PINNED_DEFAULT_IDS = [4908, 6185, 6729, 12069]

/** Open + generate in the Auto-Plan dialog (defaults). */
async function generate(page: Page): Promise<void> {
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
}

/** Confirm the generated pack; the dialog closes. */
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

/** Category (builder_data category_name) for each variant id. */
async function categoriesFor(page: Page, ids: number[]): Promise<(string | undefined)[]> {
  return page.evaluate(async (variantIds) => {
    const bd = await (await fetch('/data/builder_data.json')).json()
    return variantIds.map((id: number) => bd.variant_data[String(id)]?.category_name)
  }, ids)
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('fresh profile: generates the pinned 4-meal pack, grocery derives', async ({ page }) => {
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

test('determinism: generate → clear → generate → same ids', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })
  await generate(page)
  await confirm(page)
  const first = await plannedIds(page)
  expect(first).toEqual(PINNED_DEFAULT_IDS)

  await page.getByRole('button', { name: 'Clear plan' }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  await generate(page)
  await confirm(page)
  expect(await plannedIds(page)).toEqual(first)
  await expectZeroMealimeRequests(page)
})

test('count stepper: 1 meal and 10 meals', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generateWithCount(page, 1)
  await confirm(page)
  expect(await plannedIds(page)).toHaveLength(1)

  // Reopen; bump the count to 10 by pressing the + stepper.
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  const plus = page.getByTestId('auto-plan-count-plus')
  for (let i = 0; i < 9; i++) await plus.click()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await confirm(page)
  const ids = await plannedIds(page)
  expect(ids).toHaveLength(10)
  // No duplicates in a pack.
  expect(new Set(ids).size).toBe(10)
  await expectZeroMealimeRequests(page)
})

test('category: vegetarian pack is entirely vegetarian', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-category').selectOption('vegetarian')
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await confirm(page)

  const ids = await plannedIds(page)
  expect(ids.length).toBe(4)
  const cats = await categoriesFor(page, ids)
  for (const c of cats) expect(c).toBe('vegetarian')
  await expectZeroMealimeRequests(page)
})

test('undo restores the exact previous plan (ids + servings)', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  // Seed plan: generate 1 meal, then double its servings by hand.
  await generateWithCount(page, 1)
  await confirm(page)
  const seed = (await plannedEntries(page))[0]
  expect(seed).toBeTruthy()
  const metaName = await page.evaluate(async (id) => {
    const bd = await (await fetch('/data/builder_data.json')).json()
    return bd.variant_meta.find((m: { id: number }) => m.id === id)?.name
  }, seed.variantId)
  await page.getByRole('button', { name: `More servings of ${metaName}` }).click()
  await page.getByRole('button', { name: `More servings of ${metaName}` }).click()

  // Snapshot AFTER the bumps — undo restores the plan as it was right
  // before generation (servings included).
  const before = await plannedEntries(page)
  expect(before).toEqual([{ variantId: seed.variantId, servings: 8 }])

  // Generate a 4-meal pack over it, then undo.
  await generate(page)
  await confirm(page)
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
  // Close without confirming.
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
  await expect(a.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })
  const chipTitle = await a.getByTestId('room-chip').getAttribute('title')
  const code = chipTitle!.match(/Live room ([a-z0-9-]+)/)![1]
  const roomUrl = `${a.url().replace(/\/plan.*$/, '')}/plan?room=${code}`

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

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

test('changed choices invalidate the generated pack', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })

  // Changing the protein after Generate must clear the stale result.
  await page.getByTestId('auto-plan-category').selectOption('vegetarian')
  await expect(page.getByTestId('auto-plan-confirm')).toBeHidden()
  await expectZeroMealimeRequests(page)
})

test('diet chip active → generated plan respects it', async ({ page }) => {
  await page.goto('/')
  await waitForCatalog(page)
  await page.getByTestId('diet-chip-vegetarian').click()
  await gotoTab(page, 'Plan')
  await expect(page.getByTestId('auto-plan-button').first()).toBeVisible({ timeout: 15_000 })

  await generate(page)
  await confirm(page)
  const ids = await plannedIds(page)
  expect(ids.length).toBeGreaterThan(0)
  const cats = await categoriesFor(page, ids)
  for (const c of cats) expect(c).toBe('vegetarian')
  await expectZeroMealimeRequests(page)
})
