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
 * the recipe (it shows while the instructions section is in view), hides
 * once the recipe is already cooked today, and its tap records through
 * the ONE plan.markCooked path.
 */

/** Scroll the preparation steps into view — where the pill lives. */
async function revealSteps(page: Page) {
  await page.getByTestId('detail-step').first().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
}

test('the pill appears when the steps scroll into view and is absent before (mobile)', async ({
  page,
}) => {
  // On the phone layout the steps sit below the hero and ingredients, so
  // the pill must NOT be up at page top. On desktop the ingredient list
  // and steps compose side by side — in view immediately — so this
  // "absent before scroll" leg is phone-only.
  test.skip(
    (page.viewportSize()?.width ?? 0) >= 1024,
    'desktop composes steps beside the ingredients — in view on load',
  )
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
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
  // Even with the steps fully in view, today's cook suppresses the pill.
  await page.getByTestId('detail-step').first().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
