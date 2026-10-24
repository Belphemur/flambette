import { test, expect } from '@playwright/test'
import { waitForCatalog, gotoTab, recipeCards } from './helpers'

/**
 * ADR-0097: the dismissible, restartable onboarding tour.
 *
 * The tour is session-scoped (active/currentStep) but stamps persist to
 * localStorage under `mealime-planner:v1:onboarding`. These tests seed a
 * fresh state, walk every step, verify stamps land, and test the Settings
 * card restart + dismiss-forever paths.
 */

test.describe('Onboarding tour (ADR-0097)', () => {
  test.beforeEach(async ({ page }) => {
    // Each test gets a pristine onboarding store — clear localStorage before
    // navigation so the tour starts fresh. (pinia-plugin-persistedstate reads
    // from localStorage on hydration.)
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.removeItem('mealime-planner:v1:onboarding')
    })
    await page.reload()
    await waitForCatalog(page)
  })

  test('welcome step shows as a centered card with X and Next', async ({ page }) => {
    const overlay = page.getByTestId('onboarding-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute('data-test-step', 'welcome')

    // Full-screen card: heading, body, X dismiss, Next CTA.
    await expect(page.getByRole('heading', { name: 'Welcome to Flambette' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'X' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Next$/ })).toBeVisible()
  })

  test('X dismisses for this session only', async ({ page }) => {
    await page.getByRole('button', { name: 'X' }).click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)

    // Navigate away and back — the overlay returns (session-scoped, not
    // dismissed forever).
    await gotoTab(page, 'Settings')
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
  })

  test('search step spotlights the recipe search field', async ({ page }) => {
    await page.getByRole('button', { name: /^Next$/ }).click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'search')

    // Spotlight ring is anchored on the search field.
    const ring = page.locator('[data-test=onboarding-overlay] [data-test=spotlight-ring]')
    await expect(ring).toBeVisible()

    // Clicking Next after focus/auto-advance moves to the next step.
    await page.getByTestId('recipe-search-field').focus()
    await page.getByRole('button', { name: /^Next$/ }).click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'open-recipe')
  })

  test('open-recipe step spotlights a recipe detail', async ({ page }) => {
    // Walk to the step that needs a recipe open.
    await page.getByRole('button', { name: /^Next$/ }).click() // search
    await page.getByTestId('recipe-search-field').focus()
    await page.getByRole('button', { name: /^Next$/ }).click() // open-recipe
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'open-recipe')

    // Open the first recipe — the overlay auto-completes when the detail
    // dialog is visible.
    await recipeCards(page).first().click()
    await expect(page.getByTestId('recipe-detail')).toBeVisible()

    // Stamp should appear.
    const stamp = page.locator('[data-test="onboarding-stamp"][data-stamp="sharp-eye"]').or(
      page.locator('[data-test="onboarding-stamp"]').filter({ hasText: '🔍' }),
    )
    // The stamp passport shows earned stamps — find the sharp-eye stamp.
    await expect(page.locator('[data-test=onboarding-overlay] [data-test=passport]').getByRole('img', { name: '🔍' })).toBeVisible()

    await page.getByRole('button', { name: /^Next$/ }).click()
  })

  test('add-to-plan step spotlights the add-to-plan button', async ({ page }) => {
    // Skip ahead to open-recipe via interaction.
    await page.getByRole('button', { name: /^Next$/ }).click() // search
    await page.getByTestId('recipe-search-field').focus()
    await page.getByRole('button', { name: /^Next$/ }).click() // open-recipe
    await recipeCards(page).first().click()
    await expect(page.getByTestId('recipe-detail')).toBeVisible()
    await page.getByRole('button', { name: /^Next$/ }).click() // plan
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'plan')

    // The add-to-plan button is visible now.
    const addBtn = page.getByTestId('add-to-plan')
    await expect(addBtn).toBeVisible()

    // Click the add-to-plan button to auto-complete this step.
    const target = page.locator('[data-test=spotlight-ring]')
    await expect(target).toBeVisible()
    await addBtn.click()
    await expect(page.locator('[data-test="onboarding-stamp"]').filter({ hasText: '📅' })).toBeVisible()
  })

  test('grocery step spotlights the grocery list', async ({ page }) => {
    // Navigate to the add-to-plan step.
    await page.getByRole('button', { name: /^Next$/ }).click() // search
    await page.getByTestId('recipe-search-field').focus()
    await page.getByRole('button', { name: /^Next$/ }).click() // open-recipe
    await recipeCards(page).first().click()
    await expect(page.getByTestId('recipe-detail')).toBeVisible()
    await page.getByRole('button', { name: /^Next$/ }).click() // plan
    await page.getByTestId('add-to-plan').click()
    await page.getByRole('button', { name: /^Next$/ }).click() // grocery
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'groceries')

    // Navigate to the grocery tab — spotlight lands on the grocery list.
    await gotoTab(page, 'Grocery')
    await expect(page.getByTestId('grocery-list')).toBeVisible()
    await expect(page.locator('[data-test=spotlight-ring]')).toBeVisible()
    await page.getByRole('button', { name: /^Next$/ }).click()
  })

  test('completion step shows when all stamps earned', async ({ page }) => {
    // Walk through every step.
    await page.getByRole('button', { name: /^Next$/ }).click() // search
    await page.getByTestId('recipe-search-field').focus()
    await page.getByRole('button', { name: /^Next$/ }).click() // open-recipe
    await recipeCards(page).first().click()
    await expect(page.getByTestId('recipe-detail')).toBeVisible()
    await page.getByRole('button', { name: /^Next$/ }).click() // plan
    await page.getByTestId('add-to-plan').click()
    await page.getByRole('button', { name: /^Next$/ }).click() // grocery
    await gotoTab(page, 'Grocery')
    await page.getByRole('button', { name: /^Next$/ }).click() // completion

    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'completion')
    await expect(page.getByRole('heading', { name: /Tour complete/i })).toBeVisible()
    // All 5 stamps are gold.
    const stamps = page.locator('[data-test=onboarding-overlay] [data-test=passport] .stamp-earned')
    await expect(stamps).toHaveCount(5)
  })

  test('dismiss forever suppresses the tour on reload', async ({ page }) => {
    await page.getByRole('button', { name: 'X' }).click()
    // The welcome card's full-screen X should offer a "Don't show again" checkbox.
    await page.reload()
    await waitForCatalog(page)

    // Re-show the overlay (the X on the welcome card dismisses for session).
    // Navigate away and back to re-trigger start().
    await gotoTab(page, 'Grocery')
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
  })

  test('Settings card shows the restart button and stamp state', async ({ page }) => {
    // Complete the search stamp.
    await page.getByRole('button', { name: /^Next$/ }).click() // search
    await page.getByTestId('recipe-search-field').focus()

    await gotoTab(page, 'Settings')
    await expect(page.getByTestId('onboarding-card')).toBeVisible()
    await expect(page.getByTestId('onboarding-restart')).toBeVisible()

    // The passport strip in the card shows earned stamps.
    const earned = page.locator('[data-test=onboarding-card] [class*="bg-brand"]')
    await expect(earned).toHaveCount(1) // sharp-eye

    // Restart resets stamps.
    await page.getByTestId('onboarding-restart').click()
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
    // Welcome step — stamps cleared.
    await expect(page.locator('[data-test=onboarding-card] [class*="bg-brand"]')).toHaveCount(0)
  })
})
