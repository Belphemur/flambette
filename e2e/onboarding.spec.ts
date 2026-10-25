import { test, expect } from '@playwright/test'
import { waitForCatalog, gotoTab } from './helpers'

/**
 * ADR-0097: the dismissible, restartable onboarding tour.
 *
 * Each test gets a fresh browser context (empty localStorage), so the
 * onboarding store starts in its initial state — start() fires after
 * catalog load and the welcome step appears.
 */

test.describe('Onboarding tour (ADR-0097)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/recipes')
    // ADR-0097: wait for the catalog WITHOUT dismissing the tour —
    // this is the onboarding spec, the tour must stay visible.
    await waitForCatalog(page, false)
  })

  test('welcome step shows as a centered card with Start tour + Skip', async ({ page }) => {
    const overlay = page.getByTestId('onboarding-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute('data-test-step', 'welcome')
    await expect(page.getByRole('heading', { name: 'Welcome to Flambette' })).toBeVisible()
    await expect(page.getByTestId('onboarding-start-tour')).toBeVisible()
    await expect(page.getByTestId('onboarding-skip-intro')).toBeVisible()
  })

  test('Start tour navigates to search step with spotlight ring', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'search')
    await expect(page.getByTestId('spotlight-ring')).toBeVisible()
  })

  test('focusing the search field earns the sharp-eye stamp', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    await expect(page).toHaveURL(/\/recipes/)
    await page.getByTestId('recipe-search-field').focus()
    await expect.poll(async () => {
      const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
      const state = JSON.parse(ls || '{}')
      return state.rewards?.includes('sharp-eye')
    }, { timeout: 5000 }).toBe(true)
  })

  test('skip tour dismisses for this session only', async ({ page }) => {
    await page.getByTestId('onboarding-skip-intro').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    // dismissedForever is true — overlay does NOT return.
    await gotoTab(page, 'Settings')
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
  })

  test('Settings card shows restart button and stamp state', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    await page.getByTestId('recipe-search-field').focus()
    await gotoTab(page, 'Settings')
    const card = page.getByTestId('onboarding-card')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('onboarding-restart')).toBeVisible()
    // One stamp earned (sharp-eye) — a gold badge in the passport strip.
    const earned = card.locator('[class*="bg-brand"][class*="text-on-brand"]')
    await expect(earned).toHaveCount(1)
  })

  test('restart from Settings clears stamps and shows welcome', async ({ page }) => {
    // Earn a stamp first.
    await page.getByTestId('onboarding-start-tour').click()
    await page.getByTestId('recipe-search-field').focus()
    // Restart from Settings.
    await gotoTab(page, 'Settings')
    await page.getByTestId('onboarding-restart').click()
    // Back on Recipes — welcome card appears.
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'welcome')
    // Stamps are cleared in localStorage.
    const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
    const state = JSON.parse(ls || '{}')
    expect(state.rewards).toEqual([])
    expect(state.completedSteps).toEqual([])
  })
})
