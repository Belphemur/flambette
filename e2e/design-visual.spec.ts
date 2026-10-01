import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * Visual identity: the DESIGN.md token layer, the wider desktop
 * container, and the nav icon hover contract (ADR-0035).
 *
 * Two rules shape these specs:
 *  - A HOVER state is a mouse affordance. It must exist on the Desktop
 *    project and must be provably ABSENT on the touch project, so the
 *    "no hover animation ships to touch" half is asserted on Pixel 7
 *    rather than assumed.
 *  - Pixels are not asserted (no screenshot baselines in this repo). What
 *    is asserted is the computed contract: container width, transition
 *    property, and the resolved transform.
 */

const DESKTOP_VIEWPORT = { width: 1400, height: 900 }

test.describe('desktop width', () => {
  test('the app shell uses the wider fluid container at 1400px', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only presentation')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const shell = page.locator('[data-test="app-shell"]')
    const box = await shell.boundingBox()
    expect(box).not.toBeNull()
    // Fluid up to the cap: it fills the generous cap and never overflows
    // the window (DESIGN.md `spacing.container` = 1100px).
    expect(box!.width).toBeGreaterThan(900)
    expect(box!.width).toBeLessThanOrEqual(1100)
    expect(box!.width).toBeLessThanOrEqual(1400)

    const nav = page.locator('nav[aria-label="Main navigation"] > div')
    const navBox = await nav.boundingBox()
    expect(navBox!.width).toBeCloseTo(box!.width, 0)
  })

  test('the recipe grid gains columns with the extra width', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only presentation')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const cards = page.locator('[data-test="recipe-card"]')
    const boxes = []
    for (let i = 0; i < 5; i++) boxes.push((await cards.nth(i).boundingBox())!)
    const firstRow = boxes.filter((b) => Math.abs(b.y - boxes[0].y) < 2)
    // 2 columns on a phone, 3 at `sm`, 5 at `xl` — a 1400px window must
    // show more than the phone layout, or the width did nothing.
    expect(firstRow.length).toBeGreaterThanOrEqual(4)
    for (const b of boxes) expect(b.width).toBeGreaterThan(150)

    // The desktop metadata band carries type, energy, time and sodium.
    const band = cards.first().getByTestId('recipe-meta-band')
    await expect(band).toBeVisible()
    await expect(band).toContainText(/kcal/)
    await expect(band).toContainText(/min/)
    await expect(band.locator('[data-test^="recipe-type-"]')).toHaveCount(1)
    await expect(band).toContainText(/mg/)
  })

  test('the recipe detail lays ingredients and instructions side by side', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'desktop-only presentation')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    await page.locator('[data-test="recipe-card"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const ingredients = dialog.getByRole('heading', { name: /Ingredients/ })
    const instructions = dialog.getByRole('heading', { name: /^Instructions$/ })
    await expect(ingredients).toBeVisible()
    await expect(instructions).toBeVisible()
    const a = (await ingredients.boundingBox())!
    const b = (await instructions.boundingBox())!
    // Same row = the two-column desktop reading; stacked = phone layout.
    expect(Math.abs(a.y - b.y)).toBeLessThan(40)
    expect(b.x).toBeGreaterThan(a.x)

    // Energy and sodium wear their semantic hues (DESIGN.md tokens).
    await expect(dialog.locator('[data-test="recipe-meta-band"]')).toHaveCount(0)
    await expectZeroMealimeRequests(page)
  })
})

test.describe('nav icon hover (pointer)', () => {
  test('the nav icon lifts 2px and tints to the primary token', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'pointer affordance only')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const tab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Plan' })
    const icon = tab.locator('svg.nav-tab-icon')
    await expect(icon).toBeVisible()

    const idle = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, transition: s.transitionProperty, duration: s.transitionDuration }
    })
    expect(idle.transform).toBe('none')
    expect(idle.transition).toContain('transform')
    expect(idle.transition).toContain('color')
    expect(idle.duration).toContain('0.15s')

    await tab.hover()
    await expect
      .poll(async () => icon.evaluate((el) => getComputedStyle(el).transform))
      .not.toBe('none')
    const hovered = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, color: s.color }
    })
    // translateY(-2px) => a matrix whose f component is -2.
    expect(hovered.transform).toContain('matrix')
    expect(hovered.transform).toContain('-2')
    expect(hovered.color).not.toBe('rgb(120, 113, 108)')
  })

  test('reduced motion drops the lift and keeps the tint', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'pointer affordance only')
    await page.setViewportSize(DESKTOP_VIEWPORT)
    await blockExternalRequests(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await waitForCatalog(page)

    const tab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Plan' })
    const icon = tab.locator('svg.nav-tab-icon')
    const idle = await icon.evaluate((el) => getComputedStyle(el).transitionProperty)
    expect(idle).toBe('color')

    await tab.hover()
    const state = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, color: s.color }
    })
    expect(state.transform).toBe('none')
    expect(state.color).not.toBe('rgb(120, 113, 108)')
  })
})

test.describe('touch viewport never gets the hover affordance', () => {
  test('no hover transition, no lift, and the phone card layout is intact', async ({ page, isMobile }) => {
    test.skip(isMobile !== true, 'touch project only')
    await blockExternalRequests(page)
    await page.goto('/')
    await waitForCatalog(page)

    const icon = page.locator('nav[aria-label="Main navigation"] svg.nav-tab-icon').first()
    await expect(icon).toBeVisible()
    const state = await icon.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, duration: s.transitionDuration }
    })
    // The rule is inside `@media (hover: hover)`, which never matches a
    // touch viewport: the CSS default (`all` at 0s) is still in force, so
    // there is no 150ms animation, no transform and no stuck hover tint.
    expect(state.duration).toBe('0s')
    expect(state.transform).toBe('none')

    const cards = page.locator('[data-test="recipe-card"]')
    const boxes = []
    for (let i = 0; i < 3; i++) boxes.push((await cards.nth(i).boundingBox())!)
    // Two columns on a phone — the desktop band must not appear here.
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2)
    expect(Math.abs(boxes[0].y - boxes[2].y)).toBeGreaterThan(2)
    await expect(cards.first().getByTestId('recipe-meta-band')).toBeHidden()

    const shell = await page.locator('[data-test="app-shell"]').boundingBox()
    const viewport = page.viewportSize()!
    expect(shell!.width).toBeLessThanOrEqual(viewport.width)
    await expectZeroMealimeRequests(page)
  })
})