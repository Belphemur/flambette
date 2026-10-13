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
 * converges on the SAME post-cook prompt. The owner's FINAL ruling
 * (2026-10-13, supersedes both the slide-final and icon-static notes):
 * the pill SLIDES WITHIN the LAST-THREE zone — no pill anywhere until
 * the scroll reaches the step that is 3 steps before the last; from
 * there exactly ONE pill rides the title row of the LATEST VISIBLE step,
 * handing off as steps enter/leave the viewport in both directions, and
 * vanishing again when the scroll moves above the zone. The icon-only
 * content is KEPT (a CookingPot glyph; the accessible name carries the
 * words). The tracking is a passive rAF-throttled scroll read — NO
 * IntersectionObserver. Hides once the recipe is already cooked today; a
 * tap records through the ONE plan.markCooked path.
 */

/** The index of the step currently carrying the pill, from the DOM's own
 * geometry (the contract read back independently of the component's ref
 * bookkeeping): the max step index whose top edge is inside the viewport.
 * This is EXACTLY the component's own visibility predicate. */
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

/**
 * Scroll the page so step `i`'s top edge sits just inside the viewport
 * bottom — the geometry then guarantees step `i` is the LATEST visible
 * step (later steps' tops are still below the fold: the step cards are
 * laid out in a plain ordered list with no overlap). Deterministic
 * substitute for scrollIntoViewIfNeeded, which CENTERS its target and
 * can drag later steps into the viewport with it.
 */
async function scrollStepToViewportEdge(page: Page, i: number) {
  await page.evaluate((idx) => {
    const el = document.querySelectorAll('[data-test="detail-step"]')[idx]
    if (!el) throw new Error(`step ${idx} not found`)
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, top - window.innerHeight + 10)
  }, i)
}

/** The zone contract for ONE scroll position: exactly one pill, hooked
 * in the LATEST visible step's title row (its FIRST div — the
 * number-badge row, strictly before the prose), ICON-ONLY (no words —
 * only the svg glyph; the accessible name carries them). */
async function expectOnePillOnLatest(page: Page) {
  const steps = page.getByTestId('detail-step')
  const latest = await latestVisibleStep(page)
  expect(latest).toBeGreaterThanOrEqual(0)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const pill = steps.nth(latest).locator('xpath=div[1]').getByTestId('cooked-pill')
  await expect(pill).toHaveCount(1)
  // Icon-only: no words in the pill — the accessible name carries them.
  await expect(pill).toHaveText('')
  await expect(pill.locator('svg')).toHaveCount(1)
  await expect(pill).toHaveAttribute(
    'aria-label',
    `Cooked this? (reached step ${latest + 1})`,
  )
  return latest
}

async function openDetail(page: Page) {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()
}

test('the pill slides within the last-3 zone only, one at a time (mobile)', async ({
  page,
}) => {
  await blockExternalRequests(page)
  // 21 steps: the instructions start far below the fold.
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  const steps = page.getByTestId('detail-step')
  const stepCount = await steps.count()
  expect(stepCount).toBeGreaterThan(3)
  const tailIndex = stepCount - 3

  // Before any scroll: no step visible, no pill anywhere.
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  // ABOVE the zone (a middle step): the gate keeps the pill away even
  // though a step IS visible — the zone is the only place it exists.
  await scrollStepToViewportEdge(page, 1)
  const above = await latestVisibleStep(page)
  expect(above).toBeGreaterThanOrEqual(0)
  expect(above).toBeLessThan(tailIndex)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  // ENTERING the zone: exactly one pill, on the latest visible step.
  await scrollStepToViewportEdge(page, tailIndex)
  const entered = await expectOnePillOnLatest(page)
  expect(entered).toBe(tailIndex)
  // No earlier step carries one — never more than one at a time.
  for (let i = 0; i < entered; i++) {
    await expect(steps.nth(i).getByTestId('cooked-pill')).toHaveCount(0)
  }

  // Handoff: scrolling deeper MOVES the pill to the next step's title
  // row — still exactly one, never stacked.
  await scrollStepToViewportEdge(page, tailIndex + 1)
  const handed = await expectOnePillOnLatest(page)
  expect(handed).toBeGreaterThan(entered)

  // Back-hop: scrolling back up returns the pill to the earlier step.
  await scrollStepToViewportEdge(page, tailIndex)
  const back = await expectOnePillOnLatest(page)
  expect(back).toBeLessThan(handed)

  // Leaving the zone (back above length-3) removes the pill entirely.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the same slide-in-tail contract on desktop, live from load', async ({ page }) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    'phone layout: covered by the mobile leg above',
  )
  await openDetail(page)
  const steps = page.getByTestId('detail-step')
  const stepCount = await steps.count()
  const tailIndex = stepCount - 3
  // From load the pill can only exist if the scroll already reaches the
  // tail zone — read the geometry, never assume (desktop layouts differ).
  const initial = await latestVisibleStep(page)
  if (initial < tailIndex) {
    await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  } else {
    await expectOnePillOnLatest(page)
  }
  // And it slides with the scroll, one at a time, only inside the zone.
  await scrollStepToViewportEdge(page, tailIndex)
  const entered = await expectOnePillOnLatest(page)
  expect(entered).toBe(tailIndex)
  await scrollStepToViewportEdge(page, tailIndex + 1)
  const handed = await expectOnePillOnLatest(page)
  expect(handed).toBeGreaterThan(entered)
  // Above the zone: gone.
  await scrollStepToViewportEdge(page, 0)
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

  // Reach the tail zone — the only place the pill exists — and press it.
  const stepCount = await page.getByTestId('detail-step').count()
  await scrollStepToViewportEdge(page, stepCount - 1)
  await expectOnePillOnLatest(page)
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

test('pill Undo removes the record and STAYS on the detail page', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  const stepCount = await page.getByTestId('detail-step').count()
  await scrollStepToViewportEdge(page, stepCount - 1)
  const before = await expectOnePillOnLatest(page)
  await page.getByTestId('cooked-pill').click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the pill offers itself again —
  // exactly one, still hooked on the latest visible tail step (the
  // scroll never moved, so the same step carries it).
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  const after = await expectOnePillOnLatest(page)
  expect(after).toBe(before)
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
  // Scrolling deep INTO the tail zone changes nothing: today's cook
  // suppresses the pill wherever the scroll lands.
  const stepCount = await page.getByTestId('detail-step').count()
  await scrollStepToViewportEdge(page, stepCount - 1)
  await expect(page.getByTestId('detail-step').last()).toBeInViewport()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})