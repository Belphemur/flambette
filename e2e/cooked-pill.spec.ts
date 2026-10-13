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
 * converges on the SAME post-cook prompt. The pill belongs to the END of
 * the recipe — its trigger is a sentinel riding the THIRD-FROM-LAST step
 * (the LAST THREE steps; the owner refinement that replaced the old
 * section-level trigger, which on desktop was in view on load) — it hides
 * once the recipe is already cooked today, and its tap records through
 * the ONE plan.markCooked path.
 */

/**
 * Scroll the LAST step into view — where the pill's tail sentinel rides
 * (third-from-last, ADR-0083 addendum): the tail's arrival is what lights
 * the pill, on BOTH layouts.
 */
async function revealSteps(page: Page) {
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
}

test('the pill stays down until the LAST steps scroll into view (both layouts)', async ({
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
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await revealSteps(page)
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
