import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  waitForCatalog,
} from './helpers'

/**
 * Scroll restoration on back-from-recipe (ADR-0061).
 *
 * vue-router 5 records the leaving page's scroll offset into its history
 * state and hands it back to `scrollBehavior()` as `savedPosition` on
 * back/forward (POP) navigations. The router now returns it, so going back
 * from a recipe detail lands the recipes list where the user left it.
 * PUSH navigations (card → detail, header logo, tab switches) keep
 * starting at the top.
 */

/** Poll window.scrollY until it is within `tolerance` px of `expected`. */
async function expectScrollY(page: Page, expected: number, tolerance = 2): Promise<void> {
  await expect
    .poll(
      async () => {
        const y = await page.evaluate(() => window.scrollY)
        return Math.abs(y - expected)
      },
      { timeout: 5_000, message: `scrollY never settled within ${tolerance}px of ${expected}` },
    )
    .toBeLessThanOrEqual(tolerance)
}

/**
 * Click a recipe-card link that is already fully inside the viewport at
 * REAL mouse coordinates. A locator click() runs scrollIntoViewIfNeeded
 * first, which on narrow viewports CENTERS a tall card link — moving the
 * scroll the router is about to record into history state. A raw mouse
 * click never scrolls.
 */
async function clickInViewCard(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLElement>('[data-test="recipe-card-link"]'),
    )
    const el = links.find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height > 0
    })
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  expect(box, 'no recipe-card link fully in view after scrolling').not.toBeNull()
  await page.mouse.click(box!.x, box!.y)
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

test('back from a recipe restores the list scroll position', async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 2000))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  await clickInViewCard(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()

  await page.getByTestId('detail-back').click()
  await expect(page.getByTestId('detail-title')).toHaveCount(0)
  await expectScrollY(page, 2000)
})

test('browser back (page.goBack) restores the list scroll position', async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 2000))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  await clickInViewCard(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()

  await page.goBack()
  await expect(page.getByTestId('detail-title')).toHaveCount(0)
  await expectScrollY(page, 2000)
})

test('push navigations still land at the top', async ({ page }) => {
  // Detail view → header logo: a PUSH to the recipes list starts at top.
  await page.evaluate(() => window.scrollTo(0, 2000))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await clickInViewCard(page)
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await page.getByTestId('home-link').click()
  await waitForCatalog(page)
  const yAfterHome = await page.evaluate(() => window.scrollY)
  expect(yAfterHome).toBe(0)

  // Tab switch: Plan then back to Recipes is a PUSH both ways — no
  // savedPosition — so the list starts at the top again.
  await page.evaluate(() => window.scrollTo(0, 2000))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await gotoTab(page, 'Plan')
  await gotoTab(page, 'Recipes')
  await waitForCatalog(page)
  const yAfterTabs = await page.evaluate(() => window.scrollY)
  expect(yAfterTabs).toBe(0)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})
