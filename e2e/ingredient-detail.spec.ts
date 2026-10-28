import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0100: the ingredient detail sheet + the per-line quantity override.
 *
 * Covering: the sheet opens from BOTH surfaces (Grocery tab AND Shop
 * view) by tapping the ingredient NAME; the credit renders only WITH a
 * photo (and substitutes hide when the corpus has no row); the qty
 * editor opens/edits/resets through the shared clamp; the override
 * rides the line's composition-stable identity — it SURVIVES a
 * contributing meal's removal while the line persists (other
 * contributors) and is swept when the line leaves the list entirely;
 * ShopView renders the override READ-ONLY. Offline enforcement
 * (zero mealime.com requests) rides every one of these flows; a search
 * expansion that would pull an external image is impossible by
 * construction (the corpus stores local webp paths only).
 */

/** A garlic row in the grocery list (the corpus's image+substitutes exemplar). */
function garlicRow(page: import('@playwright/test').Page) {
  return page.getByTestId('grocery-row').filter({ hasText: /garlic/i }).first()
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  // Recipe A: the first catalog recipe — carries garlic (same recipe the
  // grocery flow specs seed with).
  await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Grocery')
  await expect(garlicRow(page)).toBeVisible()
})

test('the sheet opens from the Grocery tab: name, amounts, photo, credit, substitutes', async ({
  page,
}) => {
  await page.getByTestId('grocery-name').filter({ hasText: /garlic/i }).first().click()
  const sheet = page.getByTestId('ingredient-detail')
  await expect(sheet).toBeVisible()

  // Title row: the display name and the merged amounts (mono data voice).
  await expect(page.getByTestId('ingredient-detail-name')).toHaveText(/garlic/i)
  await expect(page.getByTestId('ingredient-detail-amount')).toHaveText(/\d+ cloves/)

  // Garlic is a corpus row WITH an image (ADR-0099): the photo band +
  // its TheMealDB credit under it.
  await expect(page.getByTestId('ingredient-detail-image')).toBeVisible()
  await expect(page.getByTestId('ingredient-detail-credit')).toHaveText('Photo: TheMealDB')
  // The image is served LOCALLY (never themealdb.com) — asserted
  // globally by expectZeroMealimeRequests at the end.
  const src = await page.getByTestId('ingredient-detail-image').getAttribute('src')
  expect(src).toContain('/img/ingredients/')

  // Substitutes as prose on the sunken card — never chips (those would
  // render as separate elements; the ONE line is the contract).
  await expect(page.getByTestId('ingredient-detail-subs')).toContainText('Need a substitute?')

  // "You'll use this in…" lists the planned meal (thumbnail + name +
  // chevron), and it navigates to the recipe and closes.
  await expect(page.getByTestId('ingredient-detail-recipe-row')).toHaveCount(1)
  await page.getByTestId('ingredient-detail-recipe-row').first().click()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/recipe\/\d+/)
  await expectZeroMealimeRequests(page)
})

test('a missing detail row hides photo, credit AND substitutes — glyph fallback (ADR-0100)', async ({
  page,
}) => {
  // The whole catalog's recipe lines are curated INTO the corpus
  // (ADR-0099), so the no-row branch is reached the honest way: block
  // the LAZY corpus chunk (the dynamic import that only the sheet
  // fetches) and let the accessor's safe-empty fallback drive every
  // section hidden. Also proves the sheet degrades without a crash.
  await page.route('**/assets/ingredient_detail-*.js', (route) => route.abort('failed'))
  await page.getByTestId('grocery-name').filter({ hasText: /garlic/i }).first().click()
  await expect(page.getByTestId('ingredient-detail')).toBeVisible()
  await expect(page.getByTestId('ingredient-detail-name')).toHaveText(/garlic/i)
  // Amounts still render (derived from the plan, not the corpus).
  await expect(page.getByTestId('ingredient-detail-amount')).toHaveText(/\d+ cloves?/)
  // The photo band is replaced by the aisle glyph, and the credit hides
  // WITH the photo (attribution belongs to the photo only).
  await expect(page.getByTestId('ingredient-detail-image')).toHaveCount(0)
  await expect(page.getByTestId('ingredient-detail-credit')).toHaveCount(0)
  await expect(page.getByTestId('ingredient-detail-glyph')).toBeVisible()
  // And the substitutes section is hidden entirely when no row exists.
  await expect(page.getByTestId('ingredient-detail-subs')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('a broken local webp degrades to the glyph and hides the credit', async ({ page }) => {
  // The corpus stores LOCAL paths only (ADR-0099 golden) — the photo
  // failure being asserted is a broken/missing webp file, never a
  // remote host.
  await page.route('**/img/ingredients/garlic.webp', (route) => route.abort('failed'))
  await page.getByTestId('grocery-name').filter({ hasText: /garlic/i }).first().click()
  await expect(page.getByTestId('ingredient-detail')).toBeVisible()
  // The img fails to load: the band swaps to the glyph and the credit
  // (which belongs to the photo) hides with it. Substitutes are NOT
  // row-dependent here — the corpus row exists and stays visible.
  await expect(page.getByTestId('ingredient-detail-glyph')).toBeVisible()
  await expect(page.getByTestId('ingredient-detail-credit')).toHaveCount(0)
  await expect(page.getByTestId('ingredient-detail-subs')).toContainText('Need a substitute?')
  await expectZeroMealimeRequests(page)
})

test('the qty editor opens, edits (clamped once) and resets on the Grocery tab', async ({
  page,
}) => {
  const row = garlicRow(page)
  const badge = row.getByTestId('grocery-qty-edit')
  // The badge reads as editable AND is AT-reachable with its own name.
  await expect(badge).toHaveAttribute('aria-label', /Change quantity of garlic/i)
  await badge.click()
  const editor = page.getByTestId('grocery-qty-editor')
  await expect(editor).toBeVisible()

  // Stepper: minus/plus move the value in the line's unit grammar.
  const value = editor.getByTestId('grocery-qty-value')
  const plus = editor.getByTestId('grocery-qty-plus')
  const before = await value.inputValue()
  await plus.click()
  await expect(value).not.toHaveValue(before)

  // Typed commit clamps ONCE — the DISPLAY equals the store value: "1/2"
  // inherits the line's unit grammar (a bare amount stays cloves).
  await value.fill('1/2')
  await page.getByTestId('grocery-qty-done').click()
  await expect(editor).toHaveCount(0)
  await expect(row.getByTestId('grocery-qty')).toHaveText(/½ cloves|½ clove/)

  // The override rides a DIFFERENT composition: the badge renders the
  // fraction-glyph spelling the clamp produced.
  await expect(row.getByTestId('grocery-qty')).toHaveText(/½/)

  // Reset drops the override; the draft snaps back to the derived text.
  await badge.click()
  await expect(editor).toBeVisible()
  await page.getByTestId('grocery-qty-reset').click()
  await expect(editor.getByTestId('grocery-qty-value')).not.toHaveValue(/½/)
  await page.getByTestId('grocery-qty-done').click()
  await expect(page.getByTestId('grocery-qty-editor')).toHaveCount(0)
  await expect(row.getByTestId('grocery-qty')).not.toHaveText(/½/)
  await expectZeroMealimeRequests(page)
})

test('the override survives a contributing meal removal while the line persists (ADR-0100)', async ({
  page,
}) => {
  // Second garlic-contributing meal: Carrot Ginger-Turmeric Soup.
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill('Carrot Ginger-Turmeric')
  await openRecipeDetail(page, /Carrot Ginger-Turmeric/)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await gotoTab(page, 'Grocery')
  // Provenance spans both meals — asserted ON the garlic row (every
  // shared ingredient of these two soups carries the same pill).
  await expect(garlicRow(page).getByText('2 recipes')).toBeVisible()

  const row = garlicRow(page)
  await row.getByTestId('grocery-qty-edit').click()
  const value = page.getByTestId('grocery-qty-value')
  await value.fill('5')
  await page.getByTestId('grocery-qty-done').click()
  await expect(row.getByTestId('grocery-qty')).toHaveText(/5 cloves/)

  // Remove ONE contributing meal from the plan — the Plan tab's × is
  // the UI's own removal path.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: /Remove Carrot Ginger-Turmeric.* from plan/i }).click()
  await gotoTab(page, 'Grocery')
  // The garlic line PERSISTS (the other meal still contributes) and the
  // override is still exactly the stored "5 cloves" — the composition
  // re-summed behind it without moving the override.
  await expect(row).toBeVisible()
  await expect(row.getByTestId('grocery-qty')).toHaveText(/5 cloves/)

  // When the ingredient leaves the list entirely, the override dies
  // with its line (the map never outlives it) — remove the OTHER
  // contributor (the seeded Tuscan Kale meal) with the SAME control.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: /Remove Tuscan Kale.* from plan/i }).click()
  await gotoTab(page, 'Grocery')
  await expect(page.getByTestId('grocery-row').filter({ hasText: /garlic/i })).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})

test('ShopView opens the sheet from the name and renders the override READ-ONLY', async ({
  page,
}) => {
  const row = garlicRow(page)
  await row.getByTestId('grocery-qty-edit').click()
  await page.getByTestId('grocery-qty-value').fill('7')
  await page.getByTestId('grocery-qty-done').click()
  await expect(row.getByTestId('grocery-qty')).toHaveText(/7 cloves/)

  // Start shopping: the same list, no editing affordance.
  await page.getByTestId('start-shopping').click()
  await expect(page).toHaveURL(/\/shop/)
  const shopRow = page.getByTestId('shop-row').filter({ hasText: /garlic/i }).first()
  await expect(shopRow.getByTestId('grocery-qty')).toHaveText(/7 cloves/)
  // READ-ONLY: no edit hook, and the badge is not a button.
  await expect(shopRow.getByTestId('grocery-qty-edit')).toHaveCount(0)
  await expect(shopRow.getByTestId('grocery-qty-editor')).toHaveCount(0)
  const badge = shopRow.getByTestId('grocery-qty')
  expect(await badge.evaluate((el) => el.closest('button'))).toBeNull()

  // The sheet's door works in shopping mode too: the NAME opens it.
  await shopRow.getByTestId('shop-name').click()
  await expect(page.getByTestId('ingredient-detail')).toBeVisible()
  await page.getByTestId('ingredient-detail-done').click()
  await expect(page.getByTestId('ingredient-detail')).toHaveCount(0)
  await expectZeroMealimeRequests(page)
})


test('the qty editor floats over the page and is not clipped by row overflow (issue #101)', async ({
  page,
}) => {
  await gotoTab(page, 'Grocery')
  const row = garlicRow(page)
  await row.getByTestId('grocery-qty-edit').click()
  const editor = page.getByTestId('grocery-qty-editor')
  await expect(editor).toBeVisible()

  // Regression guard: the editor must be Teleport-ed to <body> and
  // position:fixed so a grocery row's overflow-hidden card cannot clip it on
  // the last row. Before the fix it was an `absolute z-20` child of the row
  // (and invisible when that row was the final visible row).
  await expect(
    page.locator('body > [data-test="grocery-qty-editor"]'),
  ).toHaveCount(1)
  await expectZeroMealimeRequests(page)
})
