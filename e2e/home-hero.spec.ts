import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * The home hero (ADR-0078): `/` is a statement of what the app is, never
 * the catalog grid. The recipes list moved to `/recipes` (route name
 * `recipes` unchanged); the hero route hides the bottom nav (the header
 * STAYS, Q2), routes into the catalog through "Start planning", and
 * opens the household modal from a REAL `room.create()` against the
 * relay — the code shown is the code the relay honoured, never a mock
 * (`olive-basin-saffron` is a rejected render fiction).
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the hero renders and the catalog grid does not', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home-hero')).toBeVisible()

  // The hero's own content: eyebrow, headline with the tomato emphasis,
  // the owner-ruled literal, the accepted no-connection phrasing.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Plan dinner together.')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('No account needed.')
  await expect(page.getByTestId('home-hero')).toContainText('2,500+ hand-curated recipes')
  await expect(page.getByTestId('home-hero')).toContainText('works even with no connection')
  // The count NEVER claims catalog accuracy, and "offline" is not the wording.
  await expect(page.getByTestId('home-hero')).not.toContainText('2,759')
  await expect(page.getByTestId('home-hero')).not.toContainText(/offline/i)

  // NOT the catalog grid.
  await expect(page.getByTestId('recipe-card-link').first()).toHaveCount(0)

  // Shell chrome per Q2: header present, bottom nav absent.
  await expect(page.locator('[data-test="app-shell"] > header')).toHaveCount(1)
  await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0)
})

test('"Start planning" routes to the recipes list', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('hero-start-planning').click()
  await expect(page).toHaveURL(/\/recipes$/)
  await waitForCatalog(page)
})

test('the household modal flow against the relay: create → code → copy link → browse', async ({
  page,
}) => {
  await page.goto('/')

  // Create rolls the code CLIENT-side (ADR-0021) and dials the relay.
  await page.getByTestId('hero-create-household').click()
  const modal = page.getByTestId('household-modal')
  await expect(modal).toBeVisible({ timeout: 15_000 })

  // The REAL code, in JetBrains Mono — three words, not the render's mock.
  const code = page.getByTestId('household-code')
  await expect(code).toHaveText(/^[a-z]+-[a-z]+-[a-z]+$/)
  await expect(code).not.toHaveText('olive-basin-saffron')
  expect(await code.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i)

  // Copy room link: the verified-write path ALWAYS says something
  // (ADR-0023) — success toast or the hand-copy fallback, never silence.
  await page.getByTestId('household-copy-link').click()
  await expect(
    page.getByTestId('share-room-toast').or(page.getByTestId('toast')).first(),
  ).toBeVisible()

  // The modal's ONE filled intent closes it into the catalog.
  await page.getByTestId('household-browse-recipes').click()
  await expect(page).toHaveURL(/\/recipes$/)
  await waitForCatalog(page)
  await expect(page.getByTestId('household-modal')).toHaveCount(0)
})

test('closing the household modal restores the hero', async ({ page }) => {
  // The relay is reachable here (the config starts one), so this is the
  // happy dismissal path: Escape closes the modal and the hero is intact.
  // A FAILED create is covered by the room-error watcher (ADR-0019: toast,
  // never block) — the unit-level decision table pins its semantics.
  await page.goto('/')
  await page.getByTestId('hero-create-household').click()
  await expect(page.getByTestId('household-modal')).toBeVisible({ timeout: 15_000 })
  // Closing the modal (Escape) restores the hero exactly.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('home-hero')).toBeVisible()
})

test('the hero flips with the theme via tokens, not dark: pairs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('home-hero')).toBeVisible()

  const read = () =>
    page.evaluate(() => {
      // A value-strip card is a raised surface ON the page canvas.
      const card = document.querySelector<HTMLElement>('[data-test="home-hero"] .bg-surface-raised')!
      return {
        card: getComputedStyle(card).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
      }
    })

  const light = await read()
  // Warm Culinary Paper: #FBF8F2 canvas, #F4EFE6 card.
  expect(light.body).toBe('rgb(251, 248, 242)')
  expect(light.card).toBe('rgb(244, 239, 230)')

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  const dark = await read()
  // The SAME element resolves the flip — no dark: utility was named.
  expect(dark.body).toBe('rgb(23, 19, 16)')
  expect(dark.card).toBe('rgb(36, 28, 24)')
  expect(dark.card).not.toBe(light.card)
})