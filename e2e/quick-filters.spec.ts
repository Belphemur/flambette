import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * Unified quick filters (ADR-0027/0028) + the Auto-Plan preview (WS6).
 *
 * Covers, in order:
 *  - WS2: the "All diets" category dropdown is GONE and every diet and
 *    protein value is reachable as a chip in ONE group.
 *  - WS1: on a phone-width viewport no control of the filter bar sits
 *    alone on a line of its own (the old `ml-auto` sort select did).
 *  - WS3: the selection persists across a reload and travels in the room
 *    payload, so a second device sees it without a reload.
 *  - WS4: two devices with DIFFERENT persisted filter state join one room
 *    and converge — the household's selection wins, proven both ways.
 *  - WS6: the Auto-Plan dialog previews image + title per picked meal
 *    before the user accepts.
 */

const UI_KEY = 'mealime-planner:v1:ui'

/** The Recipes tab's result-count paragraph. */
function resultCount(page: Page) {
  return page.locator('p', { hasText: /\d+ recipes?/ })
}

async function expectResultCount(page: Page, n: number) {
  await expect(resultCount(page)).toContainText(`${n} recipes`, { timeout: 15_000 })
}

/** Current unified filter selection, read straight from the Pinia store. */
async function quickFilters(page: Page) {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return JSON.parse(JSON.stringify(pinia?.state?.value?.ui?.quickFilters ?? null))
  })
}

/** Seed a persisted ui blob BEFORE the app boots (divergent device state). */
async function seedUiState(page: Page, quickFiltersValue: unknown) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string)
    },
    [UI_KEY, JSON.stringify({ shareCookedHistory: false, quickFilters: quickFiltersValue, householdRoom: '' })],
  )
}

/** Start a live room from the Plan tab and return its code. */
async function startLiveRoom(page: Page): Promise<string> {
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const chip = page.getByTestId('room-chip')
  await expect(chip).toContainText('Live', { timeout: 20_000 })
  return (await chip.getAttribute('title'))!.match(/Live room ([a-z0-9-]+)/)![1]
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

test.describe('unified quick filters (WS2)', () => {
  test('the diets dropdown is gone and every value is a chip', async ({ page }) => {
    // The former control: aria-label "Filter by category", option "All diets".
    await expect(page.getByLabel('Filter by category')).toHaveCount(0)
    await expect(page.getByText('All diets')).toHaveCount(0)

    // One surface holds both halves.
    const group = page.getByTestId('quick-filters')
    await expect(group).toBeVisible()
    for (const value of ['any', 'fish', 'meat', 'vegetarian']) {
      await expect(page.getByTestId(`protein-chip-${value}`)).toBeVisible()
    }
    for (const diet of ['no-pork', 'no-shellfish', 'no-meat', 'vegetarian', 'vegan']) {
      await expect(page.getByTestId(`diet-chip-${diet}`)).toBeVisible()
    }
    await expectZeroMealimeRequests(page)
  })

  test('a protein chip narrows to that category and combines with a diet chip', async ({ page }) => {
    await page.getByTestId('protein-chip-fish').click()
    await expect(page.getByTestId('protein-chip-fish')).toHaveAttribute('aria-pressed', 'true')
    const afterProtein = Number((await resultCount(page).textContent())!.match(/(\d+) recipes?/)![1])
    expect(afterProtein).toBeGreaterThan(0)
    expect(afterProtein).toBeLessThan(2730)

    // Still an AND with the diet rules.
    await page.getByTestId('diet-chip-vegan').click()
    const afterBoth = Number((await resultCount(page).textContent())!.match(/(\d+) recipes?/)![1])
    expect(afterBoth).toBeLessThan(afterProtein)

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(page.getByTestId('protein-chip-any')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('diet-chip-vegan')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('sort-button')).toContainText('Top rated')
    await expectZeroMealimeRequests(page)
  })

  test('the compact sort menu reorders the list and survives a reload', async ({ page }) => {
    await page.getByTestId('sort-button').click()
    const menu = page.getByTestId('sort-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('sort-option-time').click()
    await expect(menu).toBeHidden()
    await expect(page.getByTestId('sort-button')).toContainText('Quickest')

    // The ORDER is the contract: ascending cooking minutes.
    const shown = await page.locator('main article p').allTextContents()
    const minutes = shown
      .map((t) => Number(t.match(/(\d+)\s*min/)?.[1] ?? NaN))
      .filter((n) => Number.isFinite(n))
    expect(minutes.length).toBeGreaterThan(1)
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]).toBeGreaterThanOrEqual(minutes[i - 1])

    await page.reload()
    await waitForCatalog(page)
    await expect(page.getByTestId('sort-button')).toContainText('Quickest')
    await expectZeroMealimeRequests(page)
  })
})

test.describe('filter bar layout on a phone (WS1)', () => {
  test('no control sits alone on a line of its own', async ({ page }) => {
    // The Pixel 7 project already runs this viewport; force it here too so
    // the assertion is identical in both projects.
    await page.setViewportSize({ width: 412, height: 915 })
    const controls = page.locator(
      '[data-test=cook-time-filter], [data-test=favourites-filter], [data-test=pro-filter], [data-test=sort-button]',
    )
    await expect(controls).toHaveCount(4)

    const boxes = []
    for (let i = 0; i < 4; i++) boxes.push(await controls.nth(i).boundingBox())
    const rows = new Map<number, number>()
    for (const box of boxes) {
      expect(box).not.toBeNull()
      // Two controls share a row when their vertical centres are within
      // half a control height of each other.
      const key = Math.round(box!.y / 20)
      rows.set(key, (rows.get(key) ?? 0) + 1)
    }
    for (const count of rows.values()) {
      expect(count, 'a filter control was orphaned on its own line').toBeGreaterThan(1)
    }
    await expectZeroMealimeRequests(page)
  })
})

test.describe('filter sync and join reconciliation (WS3 + WS4)', () => {
  test('the selection persists across a reload', async ({ page }) => {
    await page.getByTestId('protein-chip-vegetarian').click()
    await page.getByTestId('diet-chip-no-pork').click()
    await page.getByTestId('sort-button').click()
    await page.getByTestId('sort-option-calories').click()
    await page.getByLabel('Filter by max cook time').selectOption('30')
    const before = await quickFilters(page)

    await page.reload()
    await waitForCatalog(page)
    expect(await quickFilters(page)).toEqual(before)
    await expect(page.getByTestId('protein-chip-vegetarian')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('diet-chip-no-pork')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Filter by max cook time')).toHaveValue('30')
    await expectZeroMealimeRequests(page)
  })

  test('a second device in the room sees the selection without a reload', async ({ page, browser }) => {
    test.setTimeout(90_000)
    // The room controls need a planned meal, so plan one first.
    await page.locator('main article').first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
    const code = await startLiveRoom(page)

    const ctxB = await browser.newContext()
    const b = await ctxB.newPage()
    await blockExternalRequests(b)
    await b.goto(`/?room=${code}`)
    await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })

    // Device A changes the household selection.
    await page.goto('/')
    await waitForCatalog(page)
    await page.getByTestId('protein-chip-fish').click()
    await page.getByTestId('diet-chip-no-shellfish').click()

    // Device B converges live — no reload, no navigation.
    await expect(b.getByTestId('diet-chip-no-shellfish')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 20_000,
    })
    await expect(b.getByTestId('protein-chip-fish')).toHaveAttribute('aria-pressed', 'true')

    await ctxB.close()
    await expectZeroMealimeRequests(page)
  })

  test('a divergent joiner reconciles to the household selection (WS4)', async ({ browser }) => {
    test.setTimeout(120_000)
    // Device A owns the household state: a specific selection.
    const ctxA = await browser.newContext()
    const a = await ctxA.newPage()
    await blockExternalRequests(a)
    await a.goto('/')
    await waitForCatalog(a)
    await a.locator('main article').first().click()
    await a.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
    const code = await startLiveRoom(a)
    await a.goto('/')
    await waitForCatalog(a)
    await a.getByTestId('diet-chip-vegan').click()
    await a.getByTestId('sort-button').click()
    await a.getByTestId('sort-option-latest').click()
    const household = await quickFilters(a)

    // Device B joins with a DIFFERENT persisted selection.
    const ctxB = await browser.newContext()
    const b = await ctxB.newPage()
    await blockExternalRequests(b)
    await seedUiState(b, {
      diets: ['no-meat'],
      protein: 'meat',
      maxTime: 20,
      sortBy: 'calories',
      favOnly: true,
      proOnly: true,
    })
    await b.goto(`/?room=${code}`)
    await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 20_000 })

    // Household wins: B converges to A's selection.
    await expect
      .poll(async () => quickFilters(b), { timeout: 20_000 })
      .toEqual(household)
    await b.goto('/')
    await waitForCatalog(b)
    await expect(b.getByTestId('diet-chip-vegan')).toHaveAttribute('aria-pressed', 'true')
    await expect(b.getByTestId('protein-chip-any')).toHaveAttribute('aria-pressed', 'true')
    await expect(b.getByTestId('sort-button')).toContainText('Latest')

    // …and B's own changes flow back, so the household stays one thing.
    await b.getByTestId('diet-chip-no-pork').click()
    await expect
      .poll(async () => quickFilters(a), { timeout: 20_000 })
      .toMatchObject({ diets: ['vegan', 'no-pork'] })

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('Auto-Plan preview (WS6)', () => {
  test('the dialog previews image + title per meal before confirming', async ({ page }) => {
    await gotoTab(page, 'Plan')
    await page.getByTestId('auto-plan-button').first().click()
    await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
    await page.getByTestId('auto-plan-generate').click()
    await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })

    const preview = page.getByTestId('auto-plan-preview')
    await expect(preview).toBeVisible()
    const items = preview.getByTestId(/^auto-plan-meal-/)
    // One tile per picked meal, matching the count line above it.
    await expect(items).toHaveCount(4)
    for (let i = 0; i < 4; i++) {
      await expect(items.nth(i).locator('img')).toBeVisible()
      await expect(items.nth(i).locator('p').first()).not.toBeEmpty()
    }
    // The images are the offline local files, never a remote host.
    const srcs = await items.locator('img').evaluateAll((imgs) =>
      imgs.map((i) => (i as HTMLImageElement).getAttribute('src') ?? ''),
    )
    for (const src of srcs) expect(src).not.toMatch(/^https?:/i)

    // Confirming still works, and the plan is what was previewed.
    const titles = await items.locator('p').first().allTextContents()
    await page.getByTestId('auto-plan-confirm').click()
    await expect(page.getByTestId('auto-plan-dialog')).toBeHidden()
    for (const title of titles) {
      await expect(page.getByRole('heading', { level: 3, name: title.trim() })).toBeVisible({
        timeout: 15_000,
      })
    }
    await expectZeroMealimeRequests(page)
  })
})
