import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  visibleVariantIds,
  waitForCatalog,
} from './helpers'

/**
 * The detail "Cooked this?" pill (ADR-0083 addendum): marking a cook from
 * the recipe detail page — for the person who never enters cooking mode —
 * converges on the SAME post-cook prompt. Owner FINAL ruling (2026-10-13,
 * floating restored): the pill FLOATS, exactly as Stitch designed — ONE
 * pill fixed to the viewport at the content's right edge (~120px above
 * the bottom nav), NOT hooked to anything: content scrolls under it while
 * it stays put. Its trigger is the tail sentinel riding the
 * THIRD-FROM-LAST step: the pill appears only once scrolling reaches that
 * step, stays visible while the tail scrolls under it, and hides again
 * when the scroll moves back above the zone. ICON-ONLY: accent dot +
 * CookingPot glyph — the accessible name carries the words. Hides once
 * the recipe is already cooked today; a tap records through the ONE
 * plan.markCooked path.
 */

/**
 * Scroll the LAST step into view — past the pill's tail sentinel (the
 * third-from-last step): the sentinel's arrival is what lights the pill,
 * on BOTH layouts.
 */
async function revealSteps(page: Page) {
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
}

/**
 * Scroll the page so step `i`'s top edge sits just inside the viewport
 * bottom — for the tail sentinel this is the pill's trigger point.
 * Deterministic substitute for scrollIntoViewIfNeeded, which CENTERS its
 * target and can drag later steps into the viewport with it.
 */
async function scrollStepToViewportEdge(page: Page, i: number) {
  await page.evaluate((idx) => {
    const el = document.querySelectorAll('[data-test="detail-step"]')[idx]
    if (!el) throw new Error(`step ${idx} not found`)
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, top - window.innerHeight + 10)
  }, i)
}

/** The pill's floating geometry, read from the DOM: the fixed wrapper's
 * computed position plus the pill button's offsets from the viewport's
 * right/bottom edges and its absolute x/y (for the stays-put check). */
async function pillFloatBox(page: Page) {
  return page.getByTestId('cooked-pill').evaluate((el) => {
    const wrap = el.closest('.pointer-events-none') ?? el
    const cs = getComputedStyle(wrap)
    const r = el.getBoundingClientRect()
    return {
      position: cs.position,
      right: Math.round(window.innerWidth - r.right),
      bottom: Math.round(window.innerHeight - r.bottom),
      x: Math.round(r.x),
      y: Math.round(r.y),
    }
  })
}

/** The floating contract at ONE scroll position: exactly ONE pill,
 * `position: fixed`, at its fixed offset above the bottom nav (the
 * safe-area inset is 0 in tests), never scrolled off with the content —
 * and ICON-ONLY (no words; the accessible name carries them). */
async function expectFloatingPill(page: Page) {
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const pill = page.getByTestId('cooked-pill')
  const box = await pillFloatBox(page)
  expect(box.position).toBe('fixed')
  // ~120px above the bottom nav (safe-area 0 in tests), on the content's
  // right edge with the wrapper's px-4 gutter — never negative, never
  // pressed against the viewport edge.
  expect(box.bottom).toBeGreaterThanOrEqual(100)
  expect(box.bottom).toBeLessThanOrEqual(140)
  expect(box.right).toBeGreaterThanOrEqual(12)
  // Icon-only: no words in the pill — the accessible name carries them.
  await expect(pill).toHaveText('')
  await expect(pill.locator('svg')).toHaveCount(1)
  await expect(pill).toHaveAttribute('aria-label', 'Cooked this?')
  return box
}

test('the pill stays down until the LAST steps scroll into view, then floats (both layouts)', async ({
  page,
}) => {
  await blockExternalRequests(page)
  // Variant 6123 (Mexican Chicken Soup…) has 21 steps, so the tail
  // sentinel — the 19th — sits far below the fold on BOTH layouts. That
  // pins the owner-reported case directly: on desktop the instructions
  // COLUMN is in view on load, and the pill must still stay down until
  // the tail arrives.
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  // `detail-title` renders from meta BEFORE the async getRecipe fetch
  // renders the step list — wait for the list before counting, or the
  // count races to 0 (kody, PR #84).
  const steps = page.getByTestId('detail-step')
  await expect(steps.first()).toBeVisible()
  const stepCount = await steps.count()
  expect(stepCount).toBeGreaterThan(3)

  // Before any scroll: NO pill anywhere.
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  // ABOVE the zone (a middle step): still no pill, even though a step IS
  // visible — the pill exists only from the third-from-last step on.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  // Reaching the tail: exactly ONE pill, at its FIXED floating position.
  await scrollStepToViewportEdge(page, stepCount - 3)
  await expectFloatingPill(page)
  await expectZeroMealimeRequests(page)
})

test('the floating pill STAYS PUT while the tail scrolls under it, and hides above the zone', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  // Same meta-before-doc race as above: the list must exist before the
  // count is read (kody, PR #84).
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  const stepCount = await page.getByTestId('detail-step').count()

  // Enter the tail zone and read the pill's viewport position.
  await scrollStepToViewportEdge(page, stepCount - 3)
  const first = await expectFloatingPill(page)

  // Scroll DEEPER into the tail: the content moves, the pill does not —
  // same viewport position, still exactly one.
  await scrollStepToViewportEdge(page, stepCount - 1)
  const second = await expectFloatingPill(page)
  expect(second.x).toBe(first.x)
  expect(second.y).toBe(first.y)

  // Scrolling back ABOVE the zone takes the pill away again.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('pill tap records the cook and raises the prompt; Done lands on History', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const [id] = await visibleVariantIds(page)
  // Planned meal: the pill's mark must take it OFF the plan (plan-aware,
  // the ONE markCooked path — ADR-0032/0083).
  await page.evaluate((variantId) => {
    localStorage.setItem(
      'mealime-planner:v1:plan',
      JSON.stringify({ plan: [{ variantId, servings: 2 }], customItems: [], clearedIngredients: {} }),
    )
  }, id)
  await page.goto(`/recipe/${id}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await revealSteps(page)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)

  await page.getByTestId('cooked-pill').click()
  // The modal IS the acknowledgment — no toast on this path either.
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)
  // The record exists the moment the prompt is up.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties
          ?.$pinia
        return ((pinia?.state?.value?.plan?.cookedHistory ?? []) as unknown[]).length
      }),
    )
    .toBe(1)

  // Done: History, where the entry just landed — and the planned meal
  // left the plan.
  await prompt.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByTestId('history-row').first()).toBeVisible()
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('pill Undo removes the record and STAYS on the detail page', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await revealSteps(page)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  await page.getByTestId('cooked-pill').click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the pill offers itself again.
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('the pill is absent when the recipe is already cooked today', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const [id] = await visibleVariantIds(page)
  await page.evaluate((variantId) => {
    localStorage.setItem(
      'mealime-planner:v1:plan',
      JSON.stringify({
        plan: [],
        customItems: [],
        clearedIngredients: {},
        cookedHistory: [{ variantId, cookedAt: Date.now(), id: 'seed-today' }],
      }),
    )
  }, id)
  await page.goto(`/recipe/${id}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  // Even with the TAIL in view — the pill's trigger fully satisfied —
  // today's cook suppresses the pill.
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
