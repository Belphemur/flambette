import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab } from './helpers'

/**
 * Import from Mealime (ADR-0058): the one-shot migration before Mealime's
 * 2026-10-21 shutdown. The app NEVER contacts mealime.com — the bookmarklet
 * runs on the Mealime site and the paste box here is the only ingress, so
 * these specs assert the paste surface end-to-end (section, bookmarklet
 * link, atomic import with a report, malformed-paste refusal).
 *
 * Fixture ids are real catalog bridges: recipe_id 121 → variant 4914,
 * recipe_id 182 → variant 5377 (matched by name), 3949 → seeded favourite
 * 36222, and 999999 is a deliberate miss.
 */

const PAYLOAD = JSON.stringify({
  source: 'flambette-bookmarklet',
  generatedAt: '2026-10-06T00:00:00Z',
  favourites: [
    { recipe_id: 121, name: 'Grape Tomato, Basil & Ricotta Flatbread Pizza with Arugula Salad' },
    { recipe_id: 121, name: 'Duplicate of the first row' },
    { recipe_id: 999_999, name: 'Gone From The Catalog' },
    { name: 'spicy orange tofu broccoli with basmati rice' },
  ],
})

async function openSettings(page: Page): Promise<void> {
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('mealime-import-section')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('section shows the shutdown notice, steps and the draggable bookmarklet link', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await expect(page.getByTestId('mealime-import-notice')).toContainText('21 October 2026')
  const link = page.getByTestId('mealime-bookmarklet-link')
  await expect(link).toContainText('Flambette: copy my favourites')
  await expect(link).toHaveAttribute('href', /^javascript:/)
  // A click on THIS page is the wrong origin — it must not navigate or run.
  await link.click()
  await expect(page).toHaveURL(/\/settings/)
})

test('pasting a payload imports favourites and reports id/name/missing counts', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill(PAYLOAD)
  await page.getByTestId('mealime-import-button').click()
  const report = page.getByTestId('mealime-import-report')
  await expect(report).toContainText('2 favourites imported (1 by id, 1 by name)')
  await expect(report).toContainText('1 could not be matched: Gone From The Catalog')
  await expect(report).toContainText('1 duplicate entry was skipped')

  // The star is real: the imported recipe's detail view shows it favourited.
  await page.goto('/recipe/4914')
  await expect(
    page.getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('an all-already-favourited import succeeds with an honest "nothing new"', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill(
    JSON.stringify({
      source: 'flambette-bookmarklet',
      favourites: [{ recipe_id: 3949, name: 'Lentil Green Curry' }],
    }),
  )
  await page.getByTestId('mealime-import-button').click()
  await expect(page.getByTestId('mealime-import-report')).toContainText(
    'already in your favourites — nothing new to add',
  )
})

test('a malformed paste errors and applies nothing', async ({ page }) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill('this is not json')
  await page.getByTestId('mealime-import-button').click()
  await expect(page.getByText(/Couldn't import — the pasted text is not valid JSON/)).toBeVisible()
  await expect(page.getByTestId('mealime-import-report')).toHaveCount(0)

  // No partial state: the fixture recipe is NOT favourited.
  await page.goto('/recipe/4914')
  await expect(page.getByRole('button', { name: 'Add to favourites' })).toBeVisible()

  await expectZeroMealimeRequests(page)
})
