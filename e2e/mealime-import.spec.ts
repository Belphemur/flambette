import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab } from './helpers'

/**
 * Import from Mealime (ADR-0058, amended: FULL OVERRIDE): the one-shot
 * migration before Mealime's 2026-10-21 shutdown. The app NEVER contacts
 * mealime.com — the bookmarklet runs on the Mealime site and the paste box
 * here is the only ingress, so these specs assert the paste surface
 * end-to-end (section, bookmarklet link, atomic import with a report,
 * malformed-paste refusal).
 *
 * Fixture ids are real catalog bridges: recipe_id 121 → variant 4914,
 * recipe_id 182 → variant 5377 (matched by name), 3949 → seeded favourite
 * 36222, and 999999 is a deliberate miss.
 *
 * The first-run seed is the builder snapshot's `favourited_feasible_variants`
 * — 56 ids. Neither 4914 nor 5377 is in it; 36222 and 4788 are. With the
 * override semantics an import tombstones every seed id its payload does
 * not carry: test 2 removes all 56, test 3 removes the other 55.
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
  // Step 3 is a real clickable link to the Mealime login page.
  const login = page.getByTestId('mealime-login-link')
  await expect(login).toHaveAttribute('href', 'https://my.mealime.com')
  await expect(login).toHaveAttribute('target', '_blank')
  // A click on THIS page is the wrong origin — it must not navigate or run.
  await link.click()
  await expect(page).toHaveURL(/\/settings/)
})

test('pasting a payload imports favourites and reports id/name/missing/removed counts', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill(PAYLOAD)
  await page.getByTestId('mealime-import-button').click()
  const report = page.getByTestId('mealime-import-report')
  await expect(report).toContainText('2 favourites imported (1 by id, 1 by name)')
  // Full override (ADR-0058 amended): the 56-seed set loses everything the
  // payload does not carry — and neither matched variant was seeded, so
  // all 56 seed stars are tombstoned.
  await expect(report).toContainText(
    '56 previously favourited recipes were removed — the import replaces your favourites with this Mealime set.',
  )
  await expect(report).toContainText('1 could not be matched: Gone From The Catalog')
  await expect(report).toContainText('1 duplicate entry was skipped')

  // The star is real: the imported recipe's detail view shows it favourited.
  await page.goto('/recipe/4914')
  await expect(
    page.getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()

  // And the override is real: a seeded favourite left the set.
  await page.goto('/recipe/36222')
  await expect(
    page.getByRole('button', { name: 'Add to favourites' }),
  ).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('a single-recipe import overrides the seeded set down to that one recipe', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  // 3949 resolves to seeded favourite 36222: already starred, so
  // added === 0 — but the override still tombstones the other 55 seeds.
  await page.getByTestId('mealime-import-input').fill(
    JSON.stringify({
      source: 'flambette-bookmarklet',
      favourites: [{ recipe_id: 3949, name: 'Lentil Green Curry' }],
    }),
  )
  await page.getByTestId('mealime-import-button').click()
  const report = page.getByTestId('mealime-import-report')
  await expect(report).toContainText('1 favourite imported (1 by id,')
  await expect(report).toContainText('55 previously favourited recipes were removed')
  // The honest zero for the honest case: nothing NEW was added.
  await expect(report).not.toContainText('1 new.')

  // The one payload recipe stays starred; a seed NOT in the payload is gone.
  await page.goto('/recipe/36222')
  await expect(
    page.getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()
  await page.goto('/recipe/4788')
  await expect(
    page.getByRole('button', { name: 'Add to favourites' }),
  ).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('an all-miss payload is reported, not applied — favourites survive the override', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  // Every row misses: 999999 is a deliberate miss, and the name matches
  // nothing. Nothing matched = a match-layer failure, NOT a user opinion
  // (ADR-0058 amended) — the seeded set must survive untouched.
  await page.getByTestId('mealime-import-input').fill(
    JSON.stringify({
      source: 'flambette-bookmarklet',
      favourites: [{ recipe_id: 999_999, name: 'Gone From The Catalog' }],
    }),
  )
  await page.getByTestId('mealime-import-button').click()
  const report = page.getByTestId('mealime-import-report')
  await expect(report).toContainText('Nothing could be matched to recipes in this app.')
  await expect(report).toContainText('1 could not be matched: Gone From The Catalog')
  await expect(report).not.toContainText('removed')
  // A match-layer failure is NOT a success — no modal.
  await expect(page.getByTestId('mealime-import-modal')).toHaveCount(0)

  // The seed is intact — no tombstone storm wiped it.
  await page.goto('/recipe/36222')
  await expect(
    page.getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('a successful paste opens the success modal with counts and the imported tiles', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill(PAYLOAD)
  await page.getByTestId('mealime-import-button').click()

  // The SUCCESS modal (not the inline report alone): headline with the
  // counts, then the preview tiles (image + title per recipe).
  const modal = page.getByTestId('mealime-import-modal')
  await expect(modal).toBeVisible()
  await expect(page.getByTestId('mealime-import-modal-headline')).toHaveText(
    '2 favourites imported — 1 by id, 1 by name',
  )
  const preview = page.getByTestId('mealime-import-preview')
  await expect(preview.getByTestId('mealime-import-preview-tile')).toHaveCount(2)
  const firstTile = preview.getByTestId('mealime-import-preview-tile').first()
  await expect(firstTile.getByRole('img')).toHaveAttribute(
    'alt',
    /Grape Tomato, Basil & Ricotta Flatbread Pizza/i,
  )
  await expect(firstTile).toContainText('Grape Tomato, Basil & Ricotta Flatbread Pizza')

  // Done closes the modal; focus returns to the Import button; the
  // inline report is still on screen underneath.
  await page.getByTestId('mealime-import-modal-done').click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByTestId('mealime-import-button')).toBeFocused()
  await expect(page.getByTestId('mealime-import-report')).toContainText(
    '2 favourites imported (1 by id, 1 by name)',
  )

  // The star is real (existing assertion path, repeated under the modal).
  await page.goto('/recipe/4914')
  await expect(page.getByRole('button', { name: 'Remove from favourites' })).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('a second identical paste reports "already match" in the modal (the honest zero)', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill(PAYLOAD)
  await page.getByTestId('mealime-import-button').click()
  await page.getByTestId('mealime-import-modal-done').click()

  // Same payload again: added === 0 && removed === 0. The user still asked
  // to SEE the success — the modal opens and says what happened.
  await page.getByTestId('mealime-import-input').fill(PAYLOAD)
  await page.getByTestId('mealime-import-button').click()
  await expect(page.getByTestId('mealime-import-modal')).toBeVisible()
  await expect(page.getByTestId('mealime-import-modal-headline')).toHaveText(
    'Your favourites already match — 2 recipes',
  )
  await expect(page.getByTestId('mealime-import-preview')).toBeVisible()

  await expectZeroMealimeRequests(page)
})

test('a malformed paste errors and applies nothing', async ({ page }) => {
  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('mealime-import-input').fill('this is not json')
  await page.getByTestId('mealime-import-button').click()
  await expect(page.getByText(/Couldn't import — the pasted text is not valid JSON/)).toBeVisible()
  await expect(page.getByTestId('mealime-import-report')).toHaveCount(0)
  await expect(page.getByTestId('mealime-import-modal')).toHaveCount(0)

  // No partial state: the fixture recipe is NOT favourited.
  await page.goto('/recipe/4914')
  await expect(page.getByRole('button', { name: 'Add to favourites' })).toBeVisible()

  await expectZeroMealimeRequests(page)
})
