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
 * The detail "Cooked this?" pill (ADR-0083 addendum, pill-round rulings
 * 2026-10-13): marking a cook from the recipe detail page — for the
 * person who never enters cooking mode — converges on the SAME post-cook
 * prompt. OWNER FINAL contract: the pill FLOATS (ONE pill fixed to the
 * viewport at the content's right edge, ~120px above the bottom nav,
 * content scrolls under it) and is ALWAYS offered — recipes cook
 * repeatedly, so the cooked-today suppression is RETIRED; the pill shows
 * on every visit once the tail sentinel (the THIRD-FROM-LAST step) is
 * met. The prompt is a PULSING WIGGLE of the pot icon only: 5 rounds of
 * 2 s wiggles with pauses growing 2/4/6/8 s, then it stops for the page
 * load. A flick beyond ~24px in ANY direction dismisses the pill FOR
 * THAT RECIPE persistently (device-local); a shorter movement is a tap
 * recording through the ONE plan.markCooked path.
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

/** The wiggle lives (and dies) on the CookingPot svg: read its computed
 * animation-name — the scoped build suffixes the keyframes' name
 * (`pill-wiggle-<hash>`), so callers match the PREFIX and treat 'none'
 * as the idle/stop verdict. */
async function svgAnimationName(page: Page) {
  return page
    .getByTestId('cooked-pill')
    .locator('svg')
    .evaluate((el) => getComputedStyle(el).animationName)
}

const WIGGLE_ANIM = /^pill-wiggle/

/** The household plan store's cookedHistory length, read through pinia. */
async function cookedHistoryLength(page: Page) {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties
      ?.$pinia
    return ((pinia?.state?.value?.plan?.cookedHistory ?? []) as unknown[]).length
  })
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
  // same viewport position, still exactly one. (The Firefox "pill is
  // moving" drift pin: the fixed wrapper must hold across scroll on
  // EVERY project, Firefox included via playwright.pill-firefox.ts.)
  await scrollStepToViewportEdge(page, stepCount - 1)
  const second = await expectFloatingPill(page)
  expect(second.x).toBe(first.x)
  expect(second.y).toBe(first.y)

  // Scrolling back ABOVE the zone takes the pill away again.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the pot WIGGLES when the pill first appears — icon only, pulsing, then stops for the page load', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await revealSteps(page)
  await expectFloatingPill(page)

  // The WIGGLE is on the CookingPot svg ONLY: the icon animates, the
  // pill button never does (owner: "make the pot wiggle, only the
  // icon"). First appearance starts round 1 immediately — the class (and
  // its animation-name) is present right away.
  const svg = page.getByTestId('cooked-pill').locator('svg')
  await expect.poll(() => svgAnimationName(page)).toMatch(WIGGLE_ANIM)
  await expect(page.getByTestId('cooked-pill')).toHaveText('')
  const buttonAnim = await page
    .getByTestId('cooked-pill')
    .evaluate((el) => getComputedStyle(el).animationName)
  expect(buttonAnim).not.toMatch(WIGGLE_ANIM)

  // PULSING cadence (owner ruling): wiggle 2 s, pause, wiggle 2 s, pause
  // — pauses grow 2/4/6/8 s; five rounds, ~30 s window. Mid-pattern
  // (~10 s in): a later round is running.
  await page.waitForTimeout(9_000)
  await expect.poll(() => svgAnimationName(page)).toMatch(WIGGLE_ANIM)

  // After the 5TH round the wiggle stops permanently for this page load
  // (~32 s since appearance) — the pill itself REMAINS.
  await page.waitForTimeout(22_000)
  expect(await svgAnimationName(page)).toBe('none')
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  // The prompt is decorative: nothing was recorded by wiggling.
  expect(await cookedHistoryLength(page)).toBe(0)
  await expect(page.getByTestId('detail-title')).toContainText(name)
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
    .poll(async () => cookedHistoryLength(page))
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

test('a flick in ANY direction dismisses the pill persistently for that recipe', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await revealSteps(page)
  await expectFloatingPill(page)

  // Flick DOWN-RIGHT past the ~24px threshold — ANY direction dismisses
  // (owner: "going left right up or down on it should discard it").
  const pill = page.getByTestId('cooked-pill')
  const box = await pill.boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy + 40, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  // The gesture must never record a cook — only a TAP does.
  expect(await cookedHistoryLength(page)).toBe(0)

  // Reload: the dismissal PERSISTS for this recipe (device-local) — the
  // pill never comes back on 6123, however far you scroll.
  await page.reload()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)

  // A DIFFERENT recipe still offers its pill — the dismissal is per
  // recipe, not global.
  await page.goto('/recipes')
  await waitForCatalog(page)
  const ids = await visibleVariantIds(page)
  const other = ids.find((id) => id !== 6123) ?? ids[0]
  await page.goto(`/recipe/${other}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toBeVisible()
  await expectZeroMealimeRequests(page)
})