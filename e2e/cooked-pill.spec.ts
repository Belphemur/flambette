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
 * converges on the SAME post-cook prompt. The owner's "slide" ruling
 * (2026-10-13): exactly ONE pill exists at a time, hooked INLINE on the
 * title row of the LATEST step that has entered the viewport, handing off
 * to the next step's title as the scroll advances ("only visible on the
 * visible instruction, always the latest one"). The tracking is a passive
 * rAF-throttled scroll read — NO IntersectionObserver (its callbacks never
 * fire in hidden or occluded tabs, the Firefox no-pill report). Hides once
 * the recipe is already cooked today; a tap records through the ONE
 * plan.markCooked path.
 */

/** The index of the step currently carrying the pill, from the DOM's own
 * geometry (the contract read back independently of the component's ref
 * bookkeeping): the max step index whose top edge is inside the viewport. */
async function latestVisibleStep(page: Page): Promise<number> {
  return page.evaluate(() => {
    const vh = window.innerHeight
    let latest = -1
    document.querySelectorAll('[data-test="detail-step"]').forEach((el, i) => {
      if (el.getBoundingClientRect().top < vh) latest = i
    })
    return latest
  })
}

async function openDetail(page: Page) {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()
}

test('exactly ONE pill, on the latest step whose title entered the viewport (mobile)', async ({
  page,
}) => {
  await blockExternalRequests(page)
  // 21 steps: the instructions start far below the fold.
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  // Before any scroll into the instructions there is NO visible step, so
  // there is no pill anywhere (the pill belongs to a visible instruction).
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  const steps = page.getByTestId('detail-step')
  // Scroll step 4 (index 3) into view: the pill hooks the LATEST step the
  // geometry says is visible (scrollIntoViewIfNeeded CENTERS the target,
  // so more steps than the target may have entered — the pill follows the
  // geometry, never the target index).
  await steps.nth(3).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const first = await latestVisibleStep(page)
  expect(first).toBeGreaterThanOrEqual(3)
  // Exactly one pill, inside THAT step's title row, and no earlier step
  // carries one.
  await expect(steps.nth(first).locator('xpath=div[1]').getByTestId('cooked-pill')).toHaveCount(1)
  for (let i = 0; i < first; i++) {
    await expect(steps.nth(i).getByTestId('cooked-pill')).toHaveCount(0)
  }

  // Handoff: scrolling deeper MOVES the pill — still exactly one, now on
  // the new latest step, never stacked.
  await steps.nth(first + 3).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const second = await latestVisibleStep(page)
  expect(second).toBeGreaterThan(first)
  await expect(steps.nth(second).locator('xpath=div[1]').getByTestId('cooked-pill')).toHaveCount(1)

  // The pill rides title → title: it is always in the step's FIRST div
  // (the number-badge row), strictly before the prose it must never cover.
  const pillBox = page.getByTestId('cooked-pill')
  const prose = steps.nth(second).locator('p').first()
  const pill = await pillBox.boundingBox()
  const text = await prose.boundingBox()
  expect(pill).toBeTruthy()
  expect(text).toBeTruthy()
  expect(pill!.y).toBeLessThan(text!.y)
  await expectZeroMealimeRequests(page)
})

test('the same one-pill slide contract on desktop, live from load', async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    'phone layout: covered by the mobile leg above',
  )
  await openDetail(page)
  // The pill hooks the LATEST step the geometry says is visible — live
  // from load when the instructions start in the viewport (the owner's
  // desktop screenshot), zero pills when nothing is visible yet, and no
  // observer to fail silently either way.
  const initial = await latestVisibleStep(page)
  const steps = page.getByTestId('detail-step')
  if (initial < 0) {
    // Test viewport too shallow for a step card: contract = no pill.
    await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  } else {
    await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
    await expect(steps.nth(initial).locator('xpath=div[1]').getByTestId('cooked-pill')).toHaveCount(1)
  }
  // And it slides with the scroll, one at a time.
  await steps.nth(Math.max(initial, 0) + 4).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const after = await latestVisibleStep(page)
  expect(after).toBeGreaterThan(initial)
  await expect(steps.nth(after).locator('xpath=div[1]').getByTestId('cooked-pill')).toHaveCount(1)
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

  // The pill rides the latest visible step — scroll a step into view and
  // press the pill that hooks its title row.
  await page.getByTestId('detail-step').nth(2).scrollIntoViewIfNeeded()
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
  await expectZeroMealimeRequests(page)
})

test('pill Undo removes the record and STAYS on the detail page', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await page.getByTestId('detail-step').nth(2).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  await page.getByTestId('cooked-pill').click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the pill offers itself again —
  // exactly one, still hooked on the latest visible step.
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
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
  // Scrolling deep into the steps changes nothing: today's cook
  // suppresses the pill wherever the scroll lands.
  await page.getByTestId('detail-step').nth(3).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('detail-step').nth(3)).toBeInViewport()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
