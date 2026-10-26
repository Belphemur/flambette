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
 * The detail mark (ADR-0083 → ADR-0098): marking a cook from the recipe
 * detail page — for the person who never enters cooking mode — converges
 * on the SAME post-cook prompt, raised from the ONE plan.markCooked path.
 *
 * ADR-0098 split: the floating "Cooked this?" pill is DESKTOP-ONLY
 * (`lg+`) and keeps every ADR-0083 desktop ruling — always offered once
 * the tail sentinel (the THIRD-FROM-LAST step) is met, pulsing pot wiggle
 * (5 rounds, pauses 2/4/6/8 s, then stops for the page load), flick
 * beyond ~24px dismisses FOR THAT RECIPE (device-local), full text label
 * from `2xl`, free-margin placement at `xl+`. On mobile (below `lg`) the
 * inline `detail-cook-cta` button replaces it after the step list —
 * always offered, pressable repeatedly, same mark path and prompt. The
 * two surfaces never co-exist.
 */

/** Tailwind's `lg` breakpoint — the desktop threshold. */
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024

/**
 * Scroll the LAST step into view — past the pill's tail sentinel (the
 * third-from-last step): the sentinel's arrival is what lights the pill,
 * on desktop only.
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
      width: Math.round(r.width),
    }
  })
}

/** The DESKTOP floating contract at ONE scroll position: exactly ONE
 * pill, `position: fixed`, in the free page margin at xl+, never scrolled
 * off with the content, ICON-ONLY below 2xl (the accessible name carries
 * the words). Desktop-only since ADR-0098 — mobile has the inline CTA. */
async function expectFloatingPill(page: Page) {
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  const pill = page.getByTestId('cooked-pill')
  const box = await pillFloatBox(page)
  expect(box.position).toBe('fixed')
  // Desktop (xl+): the pill lives OUTSIDE the 1100px app container —
  // its LEFT edge anchors 1.5rem past the container's right edge, in
  // the free page margin, so it can never overlay the step text
  // (owner ruling 2026-10-14). `box.x` is the pill's left edge.
  const vw = page.viewportSize()?.width ?? 0
  const containerRight = (vw + 1100) / 2
  expect(box.x).toBeGreaterThanOrEqual(containerRight + 22)
  expect(box.x).toBeLessThanOrEqual(containerRight + 26)
  // Entirely inside the viewport still (translate must never clip).
  expect(box.x + box.width).toBeLessThanOrEqual(vw - 4)
  expect(box.bottom).toBeGreaterThanOrEqual(96)
  expect(box.bottom).toBeLessThanOrEqual(124)
  if (vw >= 1536) {
    // From 2xl the margin is wide enough for the FULL text label.
    await expect(pill.locator('.cooked-pill-label')).toBeVisible()
    await expect(pill.locator('.cooked-pill-label')).toHaveText('Cooked this?')
  } else {
    // xl-only widths: margin holds the ICON-ONLY pill (the ~130px
    // labelled pill would not fit between the container edge and the
    // viewport at 1280).
    await expect(pill.locator('.cooked-pill-label')).toBeHidden()
  }
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

/* ----------------------------------------------------------------------- */
/* Desktop (lg+): the floating pill — every ADR-0083 ruling survives.      */
/* ----------------------------------------------------------------------- */

test('the pill stays down until the LAST steps scroll into view, then floats', async ({ page }) => {
  test.skip(!isDesktop(page), 'desktop-only: the floating pill lives at lg+')
  await blockExternalRequests(page)
  // Variant 6123 (Mexican Chicken Soup…) has 21 steps, so the tail
  // sentinel — the 19th — sits far below the fold on both layouts. That
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

  // Before any scroll: NO pill anywhere, NO inline CTA on desktop either.
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // ABOVE the zone (a middle step): still no pill, even though a step IS
  // visible — the pill exists only from the third-from-last step on.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // Reaching the tail: exactly ONE pill, at its FIXED floating position.
  await scrollStepToViewportEdge(page, stepCount - 3)
  await expectFloatingPill(page)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the floating pill STAYS PUT while the tail scrolls under it, and hides above the zone', async ({ page }) => {
  test.skip(!isDesktop(page), 'desktop-only')
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
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // Scroll DEEPER into the tail: the content moves, the pill does not —
  // same viewport position, still exactly one. (The Firefox "pill is
  // moving" drift pin: the fixed wrapper must hold across scroll on
  // EVERY project, Firefox included via playwright.pill-firefox.ts.)
  await scrollStepToViewportEdge(page, stepCount - 1)
  const second = await expectFloatingPill(page)
  expect(second.x).toBe(first.x)
  expect(second.y).toBe(first.y)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // Scrolling back ABOVE the zone takes the pill away again.
  await scrollStepToViewportEdge(page, 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('the pot WIGGLES when the pill first appears — icon only, pulsing, then stops for the page load', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'desktop-only')
  test.setTimeout(60_000)
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await revealSteps(page)
  await expectFloatingPill(page)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // The WIGGLE is on the CookingPot svg ONLY: the icon animates, the
  // pill button never does (owner: "make the pot wiggle, only the
  // icon"). First appearance starts round 1 immediately — the class (and
  // its animation-name) is present right away.
  const svg = page.getByTestId('cooked-pill').locator('svg')
  await expect.poll(() => svgAnimationName(page)).toMatch(WIGGLE_ANIM)
  // The WIGGLE must never touch text: on this desktop-only test the
  // button never animates (the svg does) — pinned below.
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
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('pill tap records the cook and raises the prompt; Done lands on History', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'desktop-only')
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
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

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
  test.skip(!isDesktop(page), 'desktop-only')
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await revealSteps(page)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(1)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
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
  test.skip(!isDesktop(page), 'desktop-only')
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await revealSteps(page)
  await expectFloatingPill(page)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

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
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  // The gesture must never record a cook — only a TAP does.
  expect(await cookedHistoryLength(page)).toBe(0)

  // Reload: the dismissal PERSISTS for this recipe (device-local) — the
  // pill never comes back on 6123, however far you scroll.
  await page.reload()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  await page.getByTestId('detail-step').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

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
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('DESKTOP: the pill sits in the RIGHT MARGIN of the instructions column, never over the text; full label only where the margin fits it', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'desktop-only')
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  const stepCount = await page.getByTestId('detail-step').count()

  await scrollStepToViewportEdge(page, stepCount - 3)
  const box = await expectFloatingPill(page)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)

  // The step cards must stay CLEAR of the pill: the pill's left edge is
  // 1.5rem OUTSIDE the 1100px container edge (asserted by the helper) —
  // pin the step column's right edge too, so the no-overlap claim is
  // about the real layout, not just offsets.
  const stepRight = await page
    .getByTestId('detail-step')
    .last()
    .evaluate((el) => el.getBoundingClientRect().right)
  expect(box.x).toBeGreaterThanOrEqual(stepRight + 4)

  // At THIS project's width (1280) the label is hidden (icon-only — the
  // ~130px labelled pill would not fit the 90px margin). Widen to 2xl
  // (1536): the same page shows the FULL label, still outside the
  // container, never clipped — the wiggle stays svg-only throughout.
  await page.setViewportSize({ width: 1536, height: 800 })
  await page.waitForTimeout(300)
  const wide = await expectFloatingPill(page)
  await expect(page.getByTestId('detail-cook-cta')).toHaveCount(0)
  const label = page.getByTestId('cooked-pill').locator('.cooked-pill-label')
  await expect(label).toBeVisible()
  await expect(label).toHaveText('Cooked this?')
  // Container is centered: its right edge tracks the viewport — at 1536
  // it is (1536+1100)/2 = 1318, and the pill's left edge is 1.5rem past it.
  expect(wide.x).toBeGreaterThanOrEqual((1536 + 1100) / 2 + 22)
  expect(wide.x).toBeLessThanOrEqual((1536 + 1100) / 2 + 26)

  // The label NEVER wiggles: only the svg carries the animation.
  await expect.poll(() => svgAnimationName(page)).toMatch(WIGGLE_ANIM)
  const labelAnim = await label.evaluate((el) => getComputedStyle(el).animationName)
  expect(labelAnim).toBe('none')
  const buttonAnim = await page.getByTestId('cooked-pill').evaluate((el) => getComputedStyle(el).animationName)
  expect(buttonAnim).not.toMatch(WIGGLE_ANIM)
  await expectZeroMealimeRequests(page)
})

/* ----------------------------------------------------------------------- */
/* Mobile (below lg): the inline detail-cook-cta CTA.                       */
/* ----------------------------------------------------------------------- */

test('MOBILE: the inline CTA is visible after the step list; the floating pill never appears', async ({ page }) => {
  test.skip(isDesktop(page), 'mobile-only (below lg)')
  await blockExternalRequests(page)
  await page.goto('/recipe/6123')
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  const stepCount = await page.getByTestId('detail-step').count()
  expect(stepCount).toBeGreaterThan(3)

  // The CTA appears in the DOM after the step list WITHOUT any scrolling.
  const cta = page.getByTestId('detail-cook-cta')
  await expect(cta).toBeVisible()
  await expect(cta).toHaveText(/Mark as cooked/)

  // Scrolling around the steps — even into the tail zone — must NOT
  // summon the desktop floating pill.
  await scrollStepToViewportEdge(page, stepCount - 3)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(cta).toBeVisible()

  await scrollStepToViewportEdge(page, stepCount - 1)
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expect(cta).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('MOBILE: tap the CTA records the cook, raises the prompt; Done lands on History', async ({
  page,
}) => {
  test.skip(isDesktop(page), 'mobile-only (below lg)')
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const [id] = await visibleVariantIds(page)
  // Planned meal: the mark takes it OFF the plan (plan-aware, ADR-0032).
  await page.evaluate((variantId) => {
    localStorage.setItem(
      'mealime-planner:v1:plan',
      JSON.stringify({ plan: [{ variantId, servings: 2 }], customItems: [], clearedIngredients: {} }),
    )
  }, id)
  await page.goto(`/recipe/${id}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()

  const cta = page.getByTestId('detail-cook-cta')
  await expect(cta).toBeVisible()
  expect(await cookedHistoryLength(page)).toBe(0)

  await cta.click()
  // The modal IS the acknowledgment — no toast on this path.
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect.poll(async () => cookedHistoryLength(page)).toBe(1)

  // Done: History, where the entry just landed — planned meal left the plan.
  await prompt.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByTestId('history-row').first()).toBeVisible()
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('MOBILE: the CTA can be pressed again (pressable more than once)', async ({ page }) => {
  test.skip(isDesktop(page), 'mobile-only (below lg)')
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const [id] = await visibleVariantIds(page)
  await page.goto(`/recipe/${id}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  const cta = page.getByTestId('detail-cook-cta')
  await expect(cta).toBeVisible()

  // First press: cook recorded, prompt raised.
  expect(await cookedHistoryLength(page)).toBe(0)
  await cta.click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect.poll(async () => cookedHistoryLength(page)).toBe(1)

  // Dismiss the prompt (Done -> /history), then come back.
  await prompt.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)

  // Second visit: the CTA is STILL there (no cooked-today suppression),
  // and pressing it AGAIN raises the prompt again — a recipe cooks
  // repeatedly.
  await page.goto(`/recipe/${id}`)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expect(cta).toBeVisible()
  await cta.click()
  await expect(prompt).toBeVisible()
  await expect.poll(async () => cookedHistoryLength(page)).toBe(2)

  await prompt.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)
  // Two records now.
  await gotoTab(page, 'History')
  const rows = page.getByTestId('history-row')
  expect(await rows.count()).toBe(2)
  await expectZeroMealimeRequests(page)
})

test('MOBILE: Undo removes the record and STAYS on the detail page with the CTA still present', async ({
  page,
}) => {
  test.skip(isDesktop(page), 'mobile-only (below lg)')
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await expect(page.getByTestId('detail-step').first()).toBeVisible()
  const cta = page.getByTestId('detail-cook-cta')
  await expect(cta).toBeVisible()

  await cta.click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()

  // Undo: record gone, user STAYS on detail (no session to resume).
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/history$/)
  await expect(page.getByTestId('detail-title')).toContainText(name)
  // The recipe reads uncooked again, and the CTA offers itself again.
  await expect(page.getByTestId('cook-history')).toHaveCount(0)
  expect(await cookedHistoryLength(page)).toBe(0)
  await expect(cta).toBeVisible()
  await expect(page.getByTestId('cooked-pill')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})
