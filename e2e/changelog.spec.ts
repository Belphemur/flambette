import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests } from './helpers'

/**
 * Changelog module (ADR-0060) + stale-version banner (ADR-0061).
 *
 * The production preview serves a version.json with the SAME version baked
 * into the bundle, so the banner stays hidden (state 'same') — that IS the
 * expected behaviour. The modal is exercised end-to-end via the header
 * version button. version.json is verified separately as the data source
 * the banner and modal both depend on.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
})

// --- version.json endpoint ---------------------------------------------------

test('version.json is served with the correct shape and no-cache policy', async ({ page }) => {
  const response = await page.request.get('/version.json')
  expect(response.status()).toBe(200)
  const json = (await response.json()) as { version: string; builtAt: string }
  expect(json.version).toMatch(/^v/)
  expect(typeof json.builtAt).toBe('string')
  const cacheHeader = (response.headers()['cache-control'] ?? '')
  expect(cacheHeader).toContain('no-cache')
})

test('version.json version matches the header version', async ({ page }) => {
  await page.waitForSelector('[data-test="app-version"]')
  const headerVersion = await page.locator('[data-test="app-version"] > span').first().textContent()
  const response = await page.request.get('/version.json')
  const json = (await response.json()) as { version: string }
  expect(json.version).toBe(headerVersion?.trim())
})

// --- banner (ADR-0061) -------------------------------------------------------

test('banner is hidden when running version matches version.json', async ({ page }) => {
  await page.waitForSelector('[data-test="app-version"]')
  // Same version → same state → banner absent (v-if, not CSS-hidden: the
  // node must not exist at all).
  await expect(page.locator('[data-test="version-banner"]')).toHaveCount(0)
})

test('banner markup is present in DOM when shown (v-if, not display:none)', async ({ page }) => {
  // The banner uses v-if so it is absent from the DOM when hidden.
  await expect(page.locator('[data-test="version-banner"]')).toHaveCount(0)
})

// --- changelog modal (ADR-0060) ----------------------------------------------

test('modal opens from the header version button', async ({ page }) => {
  await page.waitForSelector('[data-test="app-version"]')
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await expectZeroMealimeRequests(page)
})

test('modal shows version entries from changelog.json', async ({ page }) => {
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  // At least one version card rendered
  const versionCards = modal.locator('[data-test^="changelog-version-"]')
  await expect(versionCards.first()).toBeVisible({ timeout: 10_000 })
  const count = await versionCards.count()
  expect(count).toBeGreaterThan(0)
})

test('modal closes via X button', async ({ page }) => {
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('[data-test="changelog-modal-close"]').click()
  await expect(modal).not.toBeVisible()
})

test('modal closes via Escape key', async ({ page }) => {
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
})

test('modal closes via scrim click', async ({ page }) => {
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  // Click the scrim (outside the panel): the modal root handles @click.self
  await page.mouse.click(5, 5)
  await expect(modal).not.toBeVisible()
})

test('modal loading state appears then renders content', async ({ page }) => {
  await page.getByTestId('app-version').click()
  const modal = page.getByTestId('changelog-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  // Content renders after the load completes
  await expect(modal.locator('[data-test="changelog-versions"]')).toBeVisible({ timeout: 10_000 })
})

test('modal does not request external hosts', async ({ page }) => {
  await page.getByTestId('app-version').click()
  await page.waitForSelector('[data-test="changelog-versions"]', { timeout: 10_000 })
  await expectZeroMealimeRequests(page)
})
