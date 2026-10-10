import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab, waitForCatalog } from './helpers'

/**
 * The header logo ("Flambette") is the home anchor (ADR-0078 Q3): on
 * `/recipes` it scrolls to top (the list is already the destination —
 * a no-op push would discard the reader's scroll), from every OTHER tab
 * it navigates to the hero `/`, and on `/` itself it scrolls to top.
 *
 * This covers the surfaces the design cares about:
 *  - from another tab (Plan, Grocery, …) the logo is a one-tap home button
 *    that lands on the hero;
 *  - on the recipes list the click is idempotent and scrolls to top;
 *  - no navigation occurs while cooking or shopping (fullscreen modes hide
 *    the header entirely, so the trigger must not exist there).
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the logo goes to the hero from another tab', async ({ page }) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  // Wander to a sibling tab, then the logo is the one-tap home button.
  await gotoTab(page, 'Plan')

  // ADR-0078 Q3: from a non-recipes tab the logo's aria-label is "Home".
  const homeLink = page.getByTestId('home-link')
  await expect(homeLink).toHaveAttribute('aria-label', 'Home')

  await homeLink.click()
  // The hero route `/`; the hero renders and the bottom nav is absent.
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('home-hero')).toBeVisible()
  await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0)
})

test('the logo is idempotent on the recipes list (scroll to top)', async ({ page }) => {
  await page.goto('/recipes')
  // Wait for the catalog grid so there is real scroll height below the fold.
  await waitForCatalog(page)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  // Q3: on /recipes the label names what the click does.
  await expect(page.getByTestId('home-link')).toHaveAttribute(
    'aria-label',
    'Back to top of recipes',
  )
  await page.getByTestId('home-link').click()
  // Same-route click: scrolls to top, does not re-navigate.
  await expect(page).toHaveURL(/\/recipes$/)
  // The same-route click scrolled back to the top (behavior: 'instant').
  const scrollY = await page.evaluate(() => window.scrollY)
  expect(scrollY).toBe(0)
})

test('the logo is idempotent on the hero', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home-hero')).toBeVisible()

  // Q3: on / the label is "Home" and the click stays on the hero.
  await expect(page.getByTestId('home-link')).toHaveAttribute('aria-label', 'Home')
  await page.getByTestId('home-link').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('home-hero')).toBeVisible()
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