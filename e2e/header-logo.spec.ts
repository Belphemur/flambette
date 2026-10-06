import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab, waitForCatalog } from './helpers'

/**
 * The header logo ("Flambette") is the homepage anchor. Clicking it always
 * returns the user to the Recipes list — the canonical home route (`/`).
 *
 * This covers three surfaces the design cares about:
 *  - from another tab (Plan, Grocery, …) the logo is a one-tap home button;
 *  - on the Recipes tab itself the click is idempotent and scrolls to top;
 *  - no navigation occurs while cooking or shopping (fullscreen modes hide
 *    the header entirely, so the trigger must not exist there).
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the logo links home from another tab', async ({ page }) => {
  await page.goto('/')
  await waitForCatalog(page)
  // Wander to a sibling tab, then the logo is the one-tap home button.
  await gotoTab(page, 'Plan')

  // The logo is the one home anchor on the persistent header.
  const homeLink = page.getByTestId('home-link')
  await expect(homeLink).toHaveAttribute('aria-label', 'Recipes list')

  await homeLink.click()
  // Recipes is the `/` route; it is the active tab.
  await expect(page).toHaveURL(/\/$/)
  const recipesTab = page.locator('nav[aria-label="Main navigation"] button', { hasText: 'Recipes' })
  await expect(recipesTab).toHaveAttribute('aria-current', 'page')
})

test('the logo is idempotent on the home route', async ({ page }) => {
  await page.goto('/')
  // Wait for the catalog grid so there is real scroll height below the fold.
  await waitForCatalog(page)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  // Same-page click: scrolls to top, does not re-navigate.
  await page.getByTestId('home-link').click()
  await expect(page).toHaveURL(/\/$/)
  // The same-route click scrolled back to the top (behavior: 'instant').
  const scrollY = await page.evaluate(() => window.scrollY)
  expect(scrollY).toBe(0)
})

test('the logo is absent in fullscreen modes', async ({ page }) => {
  // Cooking view hides the header; the logo must not be a dead click target.
  await page.goto('/cooking/10003')
  await expect(page.getByTestId('home-link')).toHaveCount(0)
  // The APP SHELL's header — a direct child of the shell. CookingView
  // renders its OWN `<header>` (name + progress) once the recipe metadata
  // resolves, so an unscoped `locator('header')` races the cooking view's
  // mount and counts 1 (CI shard failure at 37395779304).
  await expect(page.locator('[data-test="app-shell"] > header')).toHaveCount(0)
})
