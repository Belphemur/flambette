import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * ADR-0103 owner ruling 2026-11-26 (final): the checkbox target is the
 * step's own DETAIL LINE. Every matched line — precise prose included —
 * is a real full-row checkbox; an unmatched line stays plain prose.
 * Cooking's used-set is a device-local, 24h-capped ui-store session keyed
 * by recipe id (survives reload, cleared by recordCook); detail is fully
 * ephemeral and shares ONE set between its step rows and prep-card rows.
 * Start cooking hands the step keys into the session once.
 *
 * The key stays servings-independent: step:line:BASE-nameKey.
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

/** Param-only SPA navigation (no document reload, so the route record is reused). */
async function spaCookingRoute(page: Page, id: number) {
  await page.evaluate((next) => {
    const url = new URL(window.location.href)
    url.pathname = `/cooking/${next}`
    window.history.pushState(window.history.state, '', url)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }, id)
}

/** Backdate the persisted session stamp beyond the 24h TTL. */
async function backdateCookingSession(page: Page, recipeId: number) {
  await page.evaluate(({ id, cutoff }) => {
    const key = 'mealime-planner:v1:ui'
    const ui = JSON.parse(localStorage.getItem(key) ?? '{}')
    ui.cookingUsedSets[id].startedAt = cutoff
    localStorage.setItem(key, JSON.stringify(ui))
  }, { id: recipeId, cutoff: Date.now() - 25 * 60 * 60 * 1000 })
}

/**
 * Grilled Chicken Caesar Wrap with Grape Tomatoes (6 servings, 11 steps).
 * Step 2's detail lines include an imprecise lemon line whose line item is
 * `3 lemons`, plus a precise line for garlic — BOTH are checkable now.
 */
const LEMON_WRAP = 5132

async function lemonRow(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  // Scoped by text: the row order follows the authored detail lines.
  return page.getByTestId('measured-chip').filter({ hasText: /lemon/i }).first()
}

test('a cooking tick survives step navigation within the session', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  const row = await lemonRow(page)
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

test('a cooking tick survives a reload while the session is under 24h', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  await (await lemonRow(page)).click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()

  await page.reload()
  const reloaded = page.getByRole('dialog', { name: /Cooking / })
  await expect(reloaded).toBeVisible()
  // The step CURSOR stays session-scoped (reload starts at step 1); the
  // used-set does NOT — it came back from the persisted ui slice.
  await reloaded.getByTestId('cook-next').click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('a session older than 24h starts clean (read-time expiry)', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  await (await lemonRow(page)).click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()

  await backdateCookingSession(page, LEMON_WRAP)
  await page.reload()
  const stale = page.getByRole('dialog', { name: /Cooking / })
  await expect(stale).toBeVisible()
  await stale.getByTestId('cook-next').click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('recordCook clears the session: a re-cook starts clean', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  await cooking.getByTestId('cook-next').click()
  await (await lemonRow(page)).click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()

  await cooking.getByTestId('mark-cooked').click()
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()
  await page.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)

  await page.goto(`/cooking/${LEMON_WRAP}`)
  const again = page.getByRole('dialog', { name: /Cooking / })
  await expect(again).toBeVisible()
  await again.getByTestId('cook-next').click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).not.toBeChecked()

  // Detail stays fully ephemeral too — a re-visit starts clean.
  await openDetail(page, LEMON_WRAP)
  const detailCheck = page
    .getByTestId('detail-step')
    .nth(1)
    .getByTestId('detail-measured-check')
    .first()
  await expect(detailCheck).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('switching cooking ids keeps each recipe\'s own live session', async ({ page }) => {
  const cooking = await startCookingAt(page, LEMON_WRAP)
  const originalLabel = await cooking.getAttribute('aria-label')
  await cooking.getByTestId('cook-next').click()
  await (await lemonRow(page)).click()
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()

  // Same route record, different param: the shell key remounts CookingView.
  await spaCookingRoute(page, 10003)
  const other = page.getByRole('dialog', { name: /Cooking / })
  await expect(other).toBeVisible()
  await expect(other).not.toHaveAttribute('aria-label', originalLabel ?? '')

  // Returning to the SAME id within 24h resumes its own used-set (the
  // in-memory step cursor survives the in-app hop by design).
  await spaCookingRoute(page, LEMON_WRAP)
  const resumed = page.getByRole('dialog', { name: /Cooking / })
  await expect(resumed).toBeVisible()
  await expect(resumed.getByTestId('step-counter')).toContainText('Step 2 /')
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('a detail tick is visible when entering cooking from that sheet', async ({ page }) => {
  await openDetail(page, LEMON_WRAP)
  const step2 = page.getByTestId('detail-step').nth(1)
  await expect(step2).toContainText('lemon')
  const detailRow = step2.getByTestId('detail-measured-check-row').filter({ hasText: /lemon/i }).first()
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
  await expect((await lemonRow(page)).getByTestId('measured-check')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('a detail step tick and its prep-card ingredient row are ONE check', async ({ page }) => {
  await openDetail(page, LEMON_WRAP)
  const stepRow = page
    .getByTestId('detail-step')
    .nth(1)
    .getByTestId('detail-measured-check-row')
    .filter({ hasText: /lemon/i })
    .first()
  const ingredientRow = page
    .getByTestId('detail-ingredient-row')
    .filter({ hasText: /lemon/i })
    .first()
  const stepCheck = stepRow.getByTestId('detail-measured-check')
  const ingredientCheck = ingredientRow.locator('input[type=checkbox]')
  await expect(stepCheck).not.toBeChecked()
  await expect(ingredientCheck).not.toBeChecked()

  await stepRow.click()
  await expect(stepCheck).toBeChecked()
  await expect(ingredientCheck).toBeChecked()

  // Unticking either view unchecks the other (ADR-0103 decision 3b).
  await ingredientRow.click()
  await expect(ingredientCheck).not.toBeChecked()
  await expect(stepCheck).not.toBeChecked()
  await expectZeroMealimeRequests(page)
})

test('the sr-only measured checkbox rings its row for keyboard focus only', async ({ page }) => {
  await openDetail(page, LEMON_WRAP)
  const row = page
    .getByTestId('detail-step')
    .nth(1)
    .getByTestId('detail-measured-check-row')
    .filter({ hasText: /lemon/i })
    .first()
  const check = row.getByTestId('detail-measured-check')
  const label = row.locator('label')

  // Tab back INTO the checkbox: keyboard-driven focus must match
  // :focus-visible even though the input itself is sr-only.
  await check.focus()
  await page.keyboard.press('Tab')
  await expect(check).not.toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(check).toBeFocused()
  await expect(label).toHaveCSS('outline-style', 'solid')
  await expect(label).toHaveCSS('outline-width', '2px')

  // A pointer tap focuses the same input but must NOT show the ring.
  await row.click()
  await expect(check).toBeChecked()
  await expect(label).toHaveCSS('outline-style', 'none')
  await expectZeroMealimeRequests(page)
})
