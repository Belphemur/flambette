import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, waitForCatalog } from './helpers'

/**
 * ADR-0081 composition pins that are about LAYOUT rather than behaviour:
 * the slim header (title truncate + mono progress line + thin tomato bar),
 * the dominant step text, and the two-card row — side by side at desktop
 * INSIDE the 672px measure, stacked on a phone.
 */

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/** Open the cooking session of a recipe by id (no plan entry needed). */
async function startCookingRecipe(page: Page, id: number) {
  await page.goto(`/cooking/${id}`)
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible({ timeout: 15_000 })
  return cooking
}

test('the slim header carries the mono progress line and the thin tomato bar', async ({ page }) => {
  const cooking = await startCookingRecipe(page, 5132)

  await expect(cooking.getByTestId('cook-serves')).toContainText('serves')
  await expect(cooking.getByTestId('step-counter')).toContainText('Step 1 /')
  // The close affordance sits on the RIGHT of the header (ADR-0081's
  // render) and keeps its accessible name — the timer-confirmation path
  // (qodo 4128519620) depends on it.
  const close = cooking.getByRole('button', { name: 'Close cooking mode' })
  await expect(close).toBeVisible()
  const header = cooking.locator('header')
  await expect(close).toHaveAccessibleName('Close cooking mode')
  expect((await close.boundingBox())!.x).toBeGreaterThan(
    (await header.boundingBox())!.x + (await header.boundingBox())!.width / 2,
  )

  // The thin tomato progress bar: 1 / 13 views ≈ 7.7% filled, tomato.
  const bar = cooking.getByTestId('cook-progress')
  await expect(bar).toBeVisible()
  await expect(bar.locator('div').first()).toHaveClass(/bg-brand/)
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByTestId('step-counter')).toContainText('Step 2 /')
  const width = await bar
    .locator('div')
    .first()
    .evaluate((el) => (el as HTMLElement).style.width)
  expect(Number.parseFloat(width)).toBeGreaterThan(10)
  await expectZeroMealimeRequests(page)
})

test('the checkable detail lines and timer card stay inside the reading measure', async ({ page }) => {
  // ADR-0103: the checklist lives IN the step's prose list — there is no
  // second card beside the timer card any more.
  const cooking = await startCookingRecipe(page, 5132)
  await cooking.getByRole('button', { name: /Next/ }).click()
  const checklist = cooking.getByTestId('measured-amounts')
  const timer = cooking.getByTestId('timer-card')
  await expect(checklist).toBeVisible()
  await expect(timer).toBeVisible()

  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 900 })
    const cb = (await checklist.boundingBox())!
    const tb = (await timer.boundingBox())!
    // Desktop richness never widens the column (ADR-0073); on both
    // layouts the prose checklist sits ABOVE the timer card.
    expect(cb.width).toBeLessThanOrEqual(672 + 2)
    expect(tb.width).toBeLessThanOrEqual(672 + 2)
    expect(cb.y + cb.height).toBeLessThanOrEqual(tb.y + 2)
  }
  await expectZeroMealimeRequests(page)
})

test('the timer card labels its quick-start pills, never as detections', async ({ page }) => {
  // 10085 has NO timer sidecar: the collapsed default is deterministic
  // (a hinted step now reports its detection in the collapsed header —
  // pinned in cooking-timers.spec).
  const cooking = await startCookingRecipe(page, 10085)
  const card = cooking.getByTestId('timer-card')
  // No hint on this view: the COLLAPSED default (ADR-0081 addendum) is
  // its "Set a Timer" disclosure row alone. (A hinted step reports the
  // detection in that same row — pinned in cooking-timers.spec.)
  const disclose = cooking.getByTestId('timer-disclose')
  await expect(disclose).toBeVisible()
  await expect(disclose).toContainText('Set a Timer')
  await expect(disclose).toContainText('No timer running for this step.')
  await expect(disclose).toHaveAttribute('aria-expanded', 'false')
  await disclose.click()
  await expect(disclose).toHaveAttribute('aria-expanded', 'true')
  await expect(card).toContainText('Quick start')
  // The render's pills: mono digits, "1 min" / "3 min" / "5 min".
  await expect(card.getByTestId('timer-preset-1')).toContainText('1 min')
  await expect(card.getByTestId('timer-preset-3')).toContainText('3 min')
  await expect(card.getByTestId('timer-preset-5')).toContainText('5 min')
  // A step with no hint shows the honest banner NEXT TO the presets —
  // presets are the cook's own quick-start, never dressed up as
  // detections (ADR-0081 decision 4).
  await expect(cooking.getByTestId('timer-no-hint')).toContainText(
    'No cook time mentioned in this step — set one if needed.',
  )
  await expectZeroMealimeRequests(page)
})
