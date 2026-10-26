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

  test('skip tour dismisses FOREVER and survives a reload', async ({ page }) => {
    await page.getByTestId('onboarding-skip-intro').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    // dismissedForever is true — overlay does NOT return, across tabs...
    await gotoTab(page, 'Settings')
    await gotoTab(page, 'Recipes')
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    // ...and across a full reload (the persisted dismissal must win).
    await page.reload()
    await waitForCatalog(page, false)
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    await expect.poll(async () => {
      const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
      return JSON.parse(ls || '{}').dismissedForever
    }).toBe(true)
  })

  test('Escape dismisses the tour (ADR-0097 §5) without closing the page behind it', async ({ page }) => {
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    // The Escape belonged to the overlay only — the recipes list is intact.
    await expect(page.getByRole('main')).toBeVisible()
    await expect.poll(async () => {
      const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
      return JSON.parse(ls || '{}').dismissedForever
    }).toBe(true)
  })

  test('clicking the welcome scrim dismisses the tour', async ({ page }) => {
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
    await page.getByTestId('onboarding-scrim').click({ position: { x: 10, y: 10 } })
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
  })

  test('skip-ahead through every step reaches the completion card with the passport', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    // Starting the tour EARNS first-taste (the welcome step is step 0).
    // "Got it" advances without a stamp — 4 presses: search → open → plan
    // → groceries (which navigates to /grocery) → completion.
    for (let i = 0; i < 4; i++) {
      await page.getByTestId('onboarding-got-it').click()
    }
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'completion')
    await expect(page.getByTestId('onboarding-complete')).toBeVisible()
    await expect(page.getByTestId('passport')).toBeVisible()
    // Skipped steps earned NO stamps — only first-taste (Start tour) did.
    await expect(page.getByTestId('onboarding-complete')).toContainText('1 of 5 stamps')
    // Finishing the tour is NOT a dismissal (qodo #11): dismissedForever
    // stays false, so Settings shows the earned state, not "Tour dismissed".
    await page.getByTestId('onboarding-start-cooking').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    await expect.poll(async () => {
      const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
      return JSON.parse(ls || '{}').dismissedForever
    }).toBe(false)
  })

  test('welcome step shows as a centered card with Start tour + Skip', async ({ page }) => {
    const overlay = page.getByTestId('onboarding-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute('data-test-step', 'welcome')
    await expect(page.getByRole('heading', { name: 'Welcome to Flambette' })).toBeVisible()
    await expect(page.getByTestId('onboarding-start-tour')).toBeVisible()
    await expect(page.getByTestId('onboarding-skip-intro')).toBeVisible()
    // Stitch welcome mock: the three feature rows introduce the app.
    await expect(page.getByText('hand-curated recipes')).toBeVisible()
    await expect(page.getByText('Waste-aware meal planning')).toBeVisible()
    await expect(page.getByText('No accounts. Live household sync')).toBeVisible()
  })

  test('Start tour navigates to search step with spotlight ring', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'search')
    await expect(page.getByTestId('spotlight-ring')).toBeVisible()
  })

  test('typing in the search field earns the sharp-eye stamp (focus alone never does)', async ({ page }) => {
    await page.getByTestId('onboarding-start-tour').click()
    await expect(page).toHaveURL(/\/recipes/)
    // qodo #5: FOCUS is not completion — the user taps the field to begin
    // typing and the tour must stay on the search step.
    await page.getByTestId('recipe-search-field').focus()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'search')
    // A real typed character completes the lesson.
    await page.getByTestId('recipe-search-field').fill('pasta')
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
    await page.getByTestId('recipe-search-field').fill('soup')
    await gotoTab(page, 'Settings')
    const card = page.getByTestId('onboarding-card')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('onboarding-restart')).toBeVisible()
    // Two stamps earned (first-taste on Start tour + sharp-eye on typing)
    // — gold badges in the passport strip. The strip wraps on narrow
    // viewports (qodo #8) so the badges stay inside the card.
    const earned = card.locator('[class*="bg-brand"][class*="text-on-brand"]')
    await expect(earned).toHaveCount(2)
  })

  test('restart from Settings clears stamps and shows welcome', async ({ page }) => {
    // Earn a stamp first.
    await page.getByTestId('onboarding-start-tour').click()
    await page.getByTestId('recipe-search-field').fill('soup')
    // Mid-tour navigation leaves the tour's surface → the tour ends
    // (stamps kept), which is what frees the nav bar to reach Settings.
    await gotoTab(page, 'Settings')
    await page.getByTestId('onboarding-restart').click()
    // Restart lands the tour on its home surface with a fresh welcome card.
    await expect(page).toHaveURL(/\/recipes$/)
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute('data-test-step', 'welcome')
    // Stamps are cleared in localStorage.
    const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
    const state = JSON.parse(ls || '{}')
    expect(state.rewards).toEqual([])
    expect(state.completedSteps).toEqual([])
  })
})

test.describe('Onboarding nav-driven start (ADR-0097 §3)', () => {
  test('starts when entering /recipes from the home hero — no refresh needed', async ({
    page,
  }) => {
    // Land on the home HERO (not a direct /recipes boot): the App.vue boot
    // gate only starts the tour when the device BOOTS on /recipes, so the
    // overlay must NOT appear here.
    await page.goto('/')
    await page.getByTestId('home-hero').waitFor()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)

    // The hero's primary CTA navigates IN-APP to /recipes. A SPA push does
    // NOT re-run App.vue's onMounted — the route watcher must start the tour.
    await page.getByTestId('hero-start-planning').click()
    await expect(page).toHaveURL(/\/recipes$/)

    // The Welcome step appears immediately, no hard refresh required.
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
    await expect(page.getByTestId('onboarding-overlay')).toHaveAttribute(
      'data-test-step',
      'welcome',
    )

    // Engaging it ("I've done this") earns the first-taste stamp.
    await page.getByTestId('onboarding-start-tour').click()
    await expect.poll(async () => {
      const ls = await page.evaluate(() => localStorage.getItem('mealime-planner:v1:onboarding'))
      return JSON.parse(ls || '{}').rewards?.includes('first-taste')
    }, { timeout: 5000 }).toBe(true)
  })
})
