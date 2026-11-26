import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0103 (owner ruling 2026-11-26): the checkbox target is the step's
 * OWN detail line — the prose list IS the checklist, no separate card.
 * Every line matching >=1 line_item is checkable, precise prose included;
 * the amount always comes from the line item (never invented). Cooking's
 * used-set is a device-local 24h session in the ui store; detail stays
 * ephemeral. The ADR-0022 imprecise-only derivation remains available to
 * other consumers, but no longer decides row eligibility here.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/** Deep-link to a recipe, bump servings, add it to the plan, start cooking. */
async function startCookingAt(page: Page, variantId: number, servings = 6) {
  await page.goto(`/recipe/${variantId}`)
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible({ timeout: 15_000 })
  for (let i = 6; i < servings; i++) {
    await sheet.getByRole('button', { name: 'More servings' }).click()
  }
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return cooking
}

/**
 * Grilled Chicken Caesar Wrap with Grape Tomatoes (6 servings, 11 steps).
 * Step 2's detail list says "zest and juice from 1 ½ lemon" and
 * "juice of ¾ lemon": both are imprecise as *quantities*, while the
 * line_items say `3 lemons`.
 */
const LEMON_WRAP = 5132

test('a matched step line gets a checklist row, scaled with the servings', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)

  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('zest and juice from 1 ½ lemon')).toBeVisible()

  // The prose list itself is the checklist: no disclosure, no second card.
  const card = cooking.getByTestId('measured-amounts')
  await expect(card).toBeVisible()
  await expect(card).toContainText('This step uses')
  await expect(card.getByTestId('measured-count')).toContainText('ingredient')
  const lemonRow = card.getByTestId('measured-chip').filter({ hasText: /lemon/i }).first()
  await expect(lemonRow).toContainText('lemons')
  await expect(lemonRow).toContainText('3')

  // The row is a REAL checkbox: role/checked state queryable.
  const check = lemonRow.getByTestId('measured-check')
  await expect(check).not.toBeChecked()
  await lemonRow.click()
  await expect(check).toBeChecked()
  // Checked = the success family, struck-through muted text (ADR-0072):
  // the class is the contract, asserted on the box element.
  const box = lemonRow.locator('span').first()
  await expect(box).toHaveClass(/bg-success/)
  await expect(lemonRow.locator('.line-through')).toHaveCount(2)

  // Unchecking restores the row.
  await lemonRow.click()
  await expect(check).not.toBeChecked()
  await expect(box).not.toHaveClass(/bg-success/)
  await expect(lemonRow.locator('.line-through')).toHaveCount(0)

  // The dressing step carries the same line, and navigating there shows
  // ITS row (the session keeps earlier ticks).
  for (let i = 0; i < 4; i++) await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText('juice of ¾ lemon')).toBeVisible()
  await expect(
    cooking.getByTestId('measured-chip').filter({ hasText: /lemon/i }).first(),
  ).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('checked state survives steps within one cook session (ADR-0103)', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const row = cooking.getByTestId('measured-chip').first()
  await row.click()
  await expect(row.getByTestId('measured-check')).toBeChecked()

  // The old ADR-0081 assertion was "walking away and back resets the
  // checklist". ADR-0103 keeps one Set for the WHOLE cook session: the
  // tick survives the round trip, but dies with the session.
  await cooking.getByRole('button', { name: /Previous/ }).click()
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(row.getByTestId('measured-check')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('measured rows scale with the planned servings', async ({ page }) => {
  // Same recipe at 12 servings: the 3 lemons double.
  const cooking = await startCookingAt(page, LEMON_WRAP, 12)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const card = cooking.getByTestId('measured-amounts')
  await expect(card).toBeVisible()
  const lemonRow = card.getByTestId('measured-chip').filter({ hasText: /lemon/i }).first()
  await expect(lemonRow).toContainText('6')
  await expect(lemonRow).toContainText('lemons')
  await expectZeroMealimeRequests(page)
})

test('all-precise step lines still render checkable rows (recipe 5995)', async ({ page }) => {
  // The owner's live-preview reproduction: recipe 5995's 17 steps all carry
  // parseable prose amounts, so the old imprecision gate rendered NO row
  // anywhere and the decorative checkbox spans were the only visible boxes.
  // Deep-link: the owner's preview observation was on /cooking/5995 and
  // the plan membership is irrelevant to row eligibility.
  await page.goto('/cooking/5995')
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  const rows = cooking.getByTestId('measured-chip')
  // Walk the real catalog until the first matched detail line if step 1
  // has none — every step here is all-precise.
  for (let i = 0; i < 17 && (await rows.count()) === 0; i++) {
    const next = cooking.getByRole('button', { name: /Next/ })
    if (!(await next.isEnabled())) break
    await next.click()
  }
  const row = rows.first()
  await expect(row).toBeVisible()
  const check = row.getByTestId('measured-check')
  await expect(check).not.toBeChecked()
  await row.click()
  await expect(check).toBeChecked()
  await expect(row.locator('span').first()).toHaveClass(/bg-success/)
  await expectZeroMealimeRequests(page)
})
