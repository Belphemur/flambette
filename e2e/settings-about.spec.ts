import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests } from './helpers'

/**
 * ADR-0096: the Settings About card owns its own changelog trigger (it no
 * longer defers solely to the header version button), links the repo, and
 * offers the always-accessible `/welcome` hero via a quiet "What is
 * Flambette?" link. These are fresh-context assertions — `/settings` is
 * not a hero route, so no returning-user redirect is in play here.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  // /settings is a plain route (no hero guard); the app shell still loads
  // the catalog behind the loader, so wait for the About card to mount.
  await page.goto('/settings')
  await expect(page.getByTestId('about-card')).toBeVisible()
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the About info tile opens the changelog modal', async ({ page }) => {
  // The info tile is now a real button (not a decorative span) and opens
  // the SAME ui-store slot the header version button does.
  await page.getByTestId('about-changelog').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  // The modal fetched changelog.json: at least one version row rendered.
  await expect(modal.locator('[data-test^="changelog-version-"]').first()).toBeVisible({
    timeout: 10_000,
  })
})

test('the GitHub tile links the repo in a new tab', async ({ page }) => {
  const link = page.getByTestId('about-github')
  await expect(link).toHaveAttribute('href', 'https://github.com/Belphemur/flambette')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noreferrer')
  await expect(link).toHaveAttribute('aria-label', 'Flambette on GitHub')
})

test('the "What is Flambette?" link navigates to the /welcome hero', async ({ page }) => {
  await page.getByTestId('about-welcome').click()
  await expect(page).toHaveURL(/\/welcome$/)
  // The hero renders (fresh context — not redirected to /recipes).
  await expect(page.getByTestId('home-hero')).toBeVisible()
  // And the bottom nav stays hidden on the hero route.
  await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0)
})
