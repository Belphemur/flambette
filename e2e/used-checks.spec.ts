import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * ADR-0103 (owner ruling 2026-11-26): "I used that ingredient" is SESSION
 * state, not a persisted record. The cooking session keeps its own Set for
 * the whole session (step navigation does NOT clear it); the recipe-detail
 * sheet keeps its own ref and hands it to cooking once on Start cooking.
 * A re-cook, a re-visit and an app reload all start with a clean sheet.
 *
 * The checked rows still use the ONE servings-independent canonical key
 * (step:line:base-nameKey) and the ADR-0081 presentation.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

async function openDetail(page: Page, variantId: number) {
  await page.goto(`/recipe/${variantId}`)
  await expect(page.getByTestId('detail-step').first()).toBeVisible({ timeout: 15_000 })
}

/** Deep-link to a recipe, add it to the plan, start cooking. */
async function startCookingAt(page: Page, variantId: number) {
  await openDetail(page, variantId)
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible({ timeout: 15_000 })
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

/**
 * Grilled Chicken Caesar Wrap with Grape Tomatoes (6 servings, 11 steps).
 * Step 2's detail lines ("zest and juice from 1 ½ lemon", "juice of ¾ lemon")
 * are imprecise as quantities, so the card derives ONE measured row for
 * `3 lemons` (ADR-0022).
 */
const LEMON_WRAP = 5132

test('a cooking tick survives step navigation within the session', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  const row = cooking.getByTestId('measured-chip').first()
  await expect(row).toContainText('lemon')
  const check = row.getByTestId('measured-check')
  await expect(check).not.toBeChecked()

  await row.click()
  await expect(check).toBeChecked()
  await expect(row.locator('span').first()).toHaveClass(/bg-success/)
  await expect(row.locator('.line-through')).toHaveCount(2)

  // Walking away and back must NOT clear it — the old per-step reset was
  // the defect ADR-0103 removes.
  await cooking.getByTestId('cook-previous').click()
  await cooking.getByTestId('cook-next').click()
  await expect(check).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('a detail tick is visible when entering cooking from that sheet', async ({ page }) => {
  await openDetail(page, LEMON_WRAP)
  const step2 = page.getByTestId('detail-step').nth(1)
  await expect(step2).toContainText('lemon')
  const detailRow = step2.getByTestId('detail-measured-check-row').first()
  const detailCheck = detailRow.getByTestId('detail-measured-check')
  await expect(detailCheck).not.toBeChecked()

  // ADR-0081 presentation on detail too: full-row tap target, success
  // checkbox and struck-through muted text after the tap (ADR-0072).
  await detailRow.click()
  await expect(detailCheck).toBeChecked()
  await expect(detailRow.locator('span').first()).toHaveClass(/bg-success/)
  await expect(detailRow.locator('.line-through')).toHaveCount(2)

  // Start cooking performs the one-shot handoff from this sheet's Set.
  await page.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  await cooking.getByTestId('cook-next').click()
  await expect(cooking.getByTestId('measured-check')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('nothing survives a re-cook', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  const row = cooking.getByTestId('measured-chip').first()
  await row.click()
  await expect(row.getByTestId('measured-check')).toBeChecked()

  await cooking.getByTestId('mark-cooked').click()
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()
  await page.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)

  // A fresh cook session for the same recipe starts with an empty Set.
  await page.goto(`/cooking/${LEMON_WRAP}`)
  const again = page.getByRole('dialog', { name: /Cooking / })
  await expect(again).toBeVisible()
  await again.getByTestId('cook-next').click()
  await expect(again.getByTestId('measured-check')).not.toBeChecked()

  // And so does a fresh visit to the detail sheet.
  await openDetail(page, LEMON_WRAP)
  const detailRow = page.getByTestId('detail-step').nth(1).getByTestId('detail-measured-check-row').first()
  await expect(detailRow.getByTestId('detail-measured-check')).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('nothing survives a page reload', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  await cooking.getByTestId('measured-chip').first().click()
  await expect(cooking.getByTestId('measured-check')).toBeChecked()

  await page.reload()
  const reloaded = page.getByRole('dialog', { name: /Cooking / })
  await expect(reloaded).toBeVisible()
  // The step cursor is session-scoped too (reload starts at step 1).
  await reloaded.getByTestId('cook-next').click()
  await expect(reloaded.getByTestId('measured-check')).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})
