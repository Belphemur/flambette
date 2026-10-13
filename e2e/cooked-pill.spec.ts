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
 * converges on the SAME post-cook prompt. The owner's icon-static ruling
 * (2026-10-13, superseding the slide contract): the pill rides the title
 * rows of the LAST THREE preparation steps, STATIC structural rendering —
 * every one of the tail steps carries one with NO scroll precondition, NO
 * scroll tracking and NO observer — and the pill is ICON-ONLY (a
 * CookingPot glyph; the accessible name carries the words). Hides once
 * the recipe is already cooked today; a tap records through the ONE
 * plan.markCooked path.
 */

async function openDetail(page: Page) {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()
}

/** The static-tail contract read back from the DOM: exactly
 * min(steps, 3) pills, each inside its step's title row (the FIRST div —
 * the number-badge row, strictly before the prose), earlier steps carry
 * none. No scroll precondition — the pills render with the steps. */
async function expectTailPills(page: Page) {
  const steps = page.getByTestId('detail-step')
  const stepCount = await steps.count()
  expect(stepCount).toBeGreaterThan(0)
  const expected = Math.min(stepCount, 3)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(expected)
  for (let i = stepCount - expected; i < stepCount; i++) {
    await expect(
      steps.nth(i).locator('xpath=div[1]').getByTestId('cooked-pill'),
    ).toHaveCount(1)
    // Icon-only: no words in the pill — the accessible name carries them.
    const pill = steps.nth(i).locator('xpath=div[1]').getByTestId('cooked-pill')
    await expect(pill).toHaveText('')
    await expect(pill.locator('svg')).toHaveCount(1)
    await expect(pill).toHaveAttribute(
      'aria-label',
      `Cooked this? (reached step ${i + 1})`,
    )
  }
  for (let i = 0; i < stepCount - expected; i++) {
    await expect(steps.nth(i).getByTestId('cooked-pill')).toHaveCount(0)
  }
  return stepCount
}

test('the last three steps each carry the icon pill, static (mobile)', async ({
  page,
}) => {
  await blockExternalRequests(page)
  // 21 steps: the instructions start far below the fold — the pills are
  // rendered with the steps anyway (structural, no scroll tracking).
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expectTailPills(page)
  await expectZeroMealimeRequests(page)
})

test('the same static-tail contract on desktop, live from load', async ({
  page,
}) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    'phone layout: covered by the mobile leg above',
  )
  await openDetail(page)
  await expectTailPills(page)
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

  // The pill sits on the tail step's title row — no scroll needed.
  await page.getByTestId('cooked-pill').first().click()
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

test('pill Undo removes the record and STAYS on the detail page', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await page.getByTestId('cooked-pill').first().click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the tail pills offer themselves
  // again — static, no scroll needed.
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  await expectTailPills(page)
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
  // Scrolling deep into the tail changes nothing: today's cook
  // suppresses the pill wherever the scroll lands.
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('detail-step').last()).toBeInViewport()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
