import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  openFirstRecipeDetail,
  visibleVariantIds,
  waitForCatalog,
} from './helpers'

/**
 * The detail "Cooked this?" pill (ADR-0083 addendum): marking a cook from
 * the recipe detail page — for the person who never enters cooking mode —
 * converges on the SAME post-cook prompt. The pill rides the TITLE ROW of
 * each of the LAST THREE STEPS — inline at the number badge's level, never
 * over the step text (owner refinement, 2026-10-13: the fixed overlay
 * blocked the prose on both layouts; "going from title to title"). The
 * trigger is STRUCTURAL (the tail steps simply carry the pill), so no
 * IntersectionObserver is involved — its callbacks never fire in hidden or
 * occluded tabs, which was the Firefox no-pill report. Hides once the
 * recipe is already cooked today, and its tap records through the ONE
 * plan.markCooked path.
 */

/** How many of the LAST steps carry the pill. */
const TAIL = 3

async function openDetail(page: Page) {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()
}

test('exactly the LAST three steps carry the pill, in their title rows (mobile)', async ({
  page,
}) => {
  // Structural: the pills render with the step list itself — no scroll
  // precondition at all (and therefore nothing for a hidden-tab IO
  // quirk to swallow). Variant 6123 has 21 steps, so the tail is far
  // below the fold on load — the pills are still THERE, unpinned from
  // any viewport state.
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  const pills = page.getByTestId('cooked-pill')
  await expect(pills).toHaveCount(TAIL)
  // Every pill lives INSIDE one of the last three step cards, and none
  // of the earlier steps carries one.
  const steps = page.getByTestId('detail-step')
  const total = await steps.count()
  expect(total).toBeGreaterThanOrEqual(TAIL)
  for (let i = total - TAIL; i < total; i++) {
    await expect(steps.nth(i).getByTestId('cooked-pill')).toHaveCount(1)
  }
  for (let i = 0; i < total - TAIL; i++) {
    await expect(steps.nth(i).getByTestId('cooked-pill')).toHaveCount(0)
  }
  // The pill sits in the step's TITLE row (beside the number badge),
  // strictly BEFORE the prose it must never cover.
  const firstPillStep = steps.nth(total - TAIL)
  const titleRow = firstPillStep.locator('xpath=div[1]')
  await expect(titleRow.getByTestId('cooked-pill')).toHaveCount(1)
  await expectZeroMealimeRequests(page)
})

test('the same structural contract on desktop (no observer dependency)', async ({
  page,
}) => {
  // The Firefox report: on a browser whose IntersectionObserver never
  // delivered in the user's tab, the floating pill never appeared. The
  // inline pill is plain conditional rendering — this leg pins that.
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    'phone layout: covered by the mobile leg above',
  )
  await openDetail(page)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(TAIL)
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

  // The tail pill rides the last step's title row — scroll it into view
  // and press it.
  const lastPill = page.getByTestId('cooked-pill').last()
  await lastPill.scrollIntoViewIfNeeded()
  await lastPill.click()
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
  await expectZeroMealimeRequests(page)
})

test('pill Undo removes the record and STAYS on the detail page', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  const lastPill = page.getByTestId('cooked-pill').last()
  await lastPill.scrollIntoViewIfNeeded()
  await lastPill.click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the tail pills offer themselves
  // again.
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(TAIL)
  await expectZeroMealimeRequests(page)
})

test('the pill is absent everywhere when the recipe is already cooked today', async ({
  page,
}) => {
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
  // The tail steps render — but carry no pill: today's cook suppresses it.
  await expect(page.getByTestId('detail-step').last()).toBeVisible()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
