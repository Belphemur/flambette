import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/**
 * Phase 7: clear-grocery workflow + mark-as-cooked.
 *
 * Phase 9: "Clear" REMOVES the planned meals' ingredients from the
 * grocery list (persisted per meal until cooked or re-planned fresh).
 * The checkbox map and custom items are wiped as before; planned meals
 * stay in the plan, and the list renders empty until ingredients return.
 *
 * ADR-0092: the ONE adaptive clear button (`grocery-clear`) reads
 * "Clear checked" with something checked (direct, no modal — removes
 * ONLY the checked lines, merging them into `clearedIngredients`) and
 * "Clear list" with nothing checked (the ADR-0005 confirm-modal
 * clear-everything flow, forced past the old empty guard). The
 * pull-to-clear gesture drives the SAME clear-checked action.
 */

/** Plan the first catalog recipe (returns its display name). */
async function planFirstRecipe(page: Page): Promise<string> {
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  return name
}

/** Add a free-form grocery item from the Grocery tab form. */
async function addCustomItem(page: Page, text: string): Promise<void> {
  await page.getByLabel('Add a custom grocery item').fill(text)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

/** The ONE confirm modal (ADR-0084) with its Clear / Cancel buttons. */
function confirmModal(page: Page) {
  return page.locator('[data-test=confirm-modal]')
}

/**
 * Check every grocery checkbox (recipe lines + custom items) by repeatedly
 * clicking the first unchecked one. Checked rows stay in place on the
 * Grocery tab, so the unchecked pool shrinks monotonically.
 */
async function checkAllGroceryItems(page: Page): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    const unchecked = page.locator('main input[type=checkbox]:not(:checked)')
    if ((await unchecked.count()) === 0) return
    await unchecked.first().click()
  }
  throw new Error('could not check every grocery item')
}

test('checking the last item prompts to clear; Cancel aborts, then Clear works', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  expect(total).toBeGreaterThan(1) // recipe lines + the custom item

  await checkAllGroceryItems(page)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`${total} / ${total} items`)

  // Non-blocking confirmation with Clear / Cancel — not window.confirm.
  const modal = confirmModal(page)
  await expect(modal).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await expect(modal.locator('[data-test=confirm-cancel]')).toContainText('Cancel')

  // Cancel aborts: modal gone, state untouched.
  await modal.locator('[data-test=confirm-cancel]').click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`${total} / ${total} items`)
  // State untouched — and since the ONLY extra is now checked off, its
  // sub-section auto-collapsed like any other category (ADR-0050 §5): the
  // rows are hidden but the header + N/N pill + chevron remain.
  const extraSubsection = page.getByTestId('extra-section').locator('[data-test=extra-subsection]')
  await expect(extraSubsection.getByTestId('extra-subsection-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(extraSubsection.getByTestId('section-count-pill')).toHaveText('1/1')
  await expect(page.locator('[data-test=extra-section] li')).toHaveCount(0)

  // Re-trigger (re-open a collapsed category — the ADR-0008 escape hatch,
// needed since EVERY group is now auto-collapsed — uncheck one, check it
// again) and confirm this time.
  await page.locator('[data-test=grocery-section-toggle]').first().click()
  await page.locator('main input[type=checkbox]:checked').first().click()
  await page.locator('main input[type=checkbox]:not(:checked)').first().click()
  await expect(modal).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await modal.locator('[data-test=confirm-action]').click()

  // Ingredients REMOVED: the list is empty even though the meal stays
  // planned. Custom items emptied; feedback toast shows (toasts are
  // status-only now — the QUESTION was the modal above, ADR-0084).
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=extra-section]')).toHaveCount(0)
  await expect(
    page.getByText('Grocery list cleared — ingredients return when you plan again'),
  ).toBeVisible()
})

test('the adaptive clear button: "Clear list" with nothing checked, modal full clear (Grocery)', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // ADR-0092: visible whenever the list has items — even with NOTHING
  // checked — and reads "Clear list" then.
  const clearButton = page.locator('[data-test=grocery-clear]')
  await expect(clearButton).toBeVisible()
  await expect(clearButton).toHaveText(/Clear list/)

  await clearButton.click()
  const modal = confirmModal(page)
  await expect(modal).toContainText(
    'Clear the grocery list? Ingredients stay hidden until you cook the meals.',
  )
  await modal.locator('[data-test=confirm-action]').click()
  // Ingredients removed: the list empties (cleared state), meals stay planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=grocery-clear]')).toHaveCount(0)
})

test('the adaptive clear button flips to "Clear checked" and skips the modal (Grocery)', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // Checking one line flips the label; the label text IS the state.
  await page.locator('main input[type=checkbox]').first().click()
  const clearButton = page.locator('[data-test=grocery-clear]')
  await expect(clearButton).toHaveText(/Clear checked/)

  // Direct action, NO confirm modal.
  await clearButton.click()
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(
    page.getByText(/Cleared 1 checked item — unchecked items remain/),
  ).toBeVisible()
  // The checked line is gone; the button falls back to "Clear list".
  await expect(clearButton).toHaveText(/Clear list/)
})

test('the adaptive clear button: "Clear list" with nothing checked, modal full clear (Shop)', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)
  await expect(page.locator('[data-test=shop-row]').first()).toBeVisible({ timeout: 10_000 })

  // ADR-0092: visible with nothing checked, reading "Clear list".
  const clearButton = page.locator('[data-test=grocery-clear]')
  await expect(clearButton).toBeVisible()
  await expect(clearButton).toHaveText(/Clear list/)

  await clearButton.click()
  const modal = confirmModal(page)
  await expect(modal).toContainText('Clear the grocery list?')
  await modal.locator('[data-test=confirm-action]').click()
  // Ingredients removed: the cleared empty-state replaces the rows even
  // though the meals are still planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.getByTestId('shop-row')).toHaveCount(0)
  await expect(
    page.getByText('Grocery list cleared — ingredients return when you plan again'),
  ).toBeVisible()
})

test('the adaptive clear button clears only checked rows in shopping mode (Shop)', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await page.locator('[data-test=start-shopping]').click()
  await expect(page).toHaveURL(/\/shop$/)
  await expect(page.locator('[data-test=shop-row]').first()).toBeVisible({ timeout: 10_000 })

  const total = Number(
    (await page.getByTestId('shopping-progress').textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  expect(total).toBeGreaterThan(1)

  // Click a row from a MULTI-line section: a one-line section auto-collapses
  // the moment it is checked (ADR-0008 addendum), detaching the row
  // mid-click.
  const multiLine = page
    .locator('[data-test=shop-section]')
    .filter({ has: page.locator('[data-test=shop-section-rows] li:nth-child(2)') })
  await expect(multiLine.first()).toBeVisible()
  await multiLine.first().locator('[data-test=shop-row]').first().click()

  // One checked row → "Clear checked"; direct action, no modal; ONLY the
  // checked row goes — the unchecked rest stay, still unchecked.
  const clearButton = page.locator('[data-test=grocery-clear]')
  await expect(clearButton).toHaveText(/Clear checked/)
  await clearButton.click()
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()
  await expect(page.getByTestId('shopping-progress')).toHaveText(`0 / ${total - 1}`)
  await expect(page.getByTestId('shop-row')).toHaveCount(total - 1)
})

test('clearing removes custom items but keeps the planned meals', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  await checkAllGroceryItems(page)
  const modal = confirmModal(page)
  await expect(modal).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await modal.locator('[data-test=confirm-action]').click()

  // Grocery side: checkbox map + custom items gone, and the planned
  // meals' ingredients are REMOVED — the list is empty (cleared state).
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('[data-test=extra-section]')).toHaveCount(0)
  await expect(page.getByLabel('Add a custom grocery item')).toBeVisible()

  // The Plan tab still lists the planned meal.
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('heading', { name: meal })).toBeVisible()
})

test('the full empty state reappears after clearing a custom-only list', async ({ page }) => {
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')
  await addCustomItem(page, 'Paper towels')

  await checkAllGroceryItems(page)
  const modal = confirmModal(page)
  await expect(modal).toContainText('All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.')
  await modal.locator('[data-test=confirm-action]').click()

  // Nothing planned + nothing custom → the "Nothing to buy yet" empty state.
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()
  await expect(page.locator('[data-test=add-item-form]')).toBeVisible()
})

test('marking a planned meal cooked removes it and its grocery lines', async ({ page }) => {
  const meal = await planFirstRecipe(page)

  // Its ingredients are on the grocery list first…
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // …then the meal is cooked from the Plan tab row.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  // Derived state: the meal's ingredient lines disappear from the list.
  await gotoTab(page, 'Grocery')
  await expect(page.getByText('Nothing to buy yet')).toBeVisible()
})

test('cooked history is persisted and survives a reload', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()

  // cookedHistory is persisted (personal, not part of the room schema).
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(before.cookedHistory).toHaveLength(1)
  expect(typeof before.cookedHistory[0].variantId).toBe('number')
  expect(before.cookedHistory[0].cookedAt).toBeGreaterThan(0)
  expect(before.plan).toHaveLength(0)

  await page.reload()
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(after.cookedHistory).toEqual(before.cookedHistory)
})

test('cooking view completion records the cook and takes the meal off the plan', async ({ page }) => {
  // ADR-0034: on the last step there is ONE button — Finish — and it is
  // the mark. The separate "Mark as cooked" is reachable from every step
  // UP TO the last (pinned in cooking.spec.ts), and keeps you cooking.
  const meal = await planFirstRecipe(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()

  // Advance to the last step.
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()

  await cooking.locator('[data-test=finish]').click()
  // ADR-0083: Finish raises the post-cook prompt; Done closes to History.
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()
  await page.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)

  // The meal left the plan.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await expect(page.getByRole('heading', { name: meal })).toHaveCount(0)
})
/* ---------- Phase 9: clear REMOVES ingredients ---------- */

/** Remove a planned meal from the Plan tab (by name). */
async function removeMealFromPlan(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'Plan')
  // Plan rows carry the FULL recipe title — match as a prefix.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const remove = new RegExp(`^Remove ${escaped}[^\\r\n]* from plan$`)
  await page.getByRole('button', { name: remove }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`^${escaped}[^\r\n]*$`) })).toHaveCount(0)
}

/** Re-add a recipe by name from the Recipes tab (fresh planning). */
async function reAddRecipe(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill(name.split(' ')[0])
  await openRecipeDetail(page, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
}

test('clear removes planned ingredients: list empties, plan keeps the meals', async ({
  page,
}) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // ADR-0092: with NOTHING checked the button reads "Clear list" — the
  // confirm-modal full clear, forced past the old empty guard.
  await page.locator('[data-test=grocery-clear]').click()
  await confirmModal(page).locator('[data-test=confirm-action]').click()

  // 0 lines despite the meal still being planned.
  await expect(page.getByTestId('cleared-empty')).toBeVisible()
  await expect(page.locator('main label').filter({ hasText: /cloves|garlic/i })).toHaveCount(0)

  // The Plan tab still shows the meal.
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('heading', { name: meal })).toBeVisible()

  // (f) Reload: the cleared snapshot persists — the list stays empty.
  await page.reload()
  await gotoTab(page, 'Grocery')
  await expect(page.getByTestId('cleared-empty')).toBeVisible({ timeout: 10_000 })
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(Object.keys(persisted.clearedIngredients ?? {})).toHaveLength(1)
})

test('re-adding the same recipe returns its ingredients', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // ADR-0092: with NOTHING checked the button reads "Clear list" — the
  // confirm-modal full clear, forced past the old empty guard.
  await page.locator('[data-test=grocery-clear]').click()
  await confirmModal(page).locator('[data-test=confirm-action]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Remove + re-add the SAME recipe: fresh planning = fresh ingredients.
  await removeMealFromPlan(page, meal)
  await reAddRecipe(page, meal)

  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('cleared-empty')).toHaveCount(0)
})

test('shared ingredient cleared by one meal still appears from the other after re-add', async ({
  page,
}) => {
  // Meal A: first catalog recipe (has garlic). Meal B: also has garlic.
  await planFirstRecipe(page)
  await gotoTab(page, 'Recipes')
  await page.getByLabel('Search recipes or ingredients').fill('Carrot Ginger-Turmeric')
  await openRecipeDetail(page, /Carrot Ginger-Turmeric Soup/)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  // Clear: BOTH meals' ingredients (including the shared garlic) hidden.
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  // ADR-0092: with NOTHING checked the button reads "Clear list" — the
  // confirm-modal full clear, forced past the old empty guard.
  await page.locator('[data-test=grocery-clear]').click()
  await confirmModal(page).locator('[data-test=confirm-action]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Re-add ONLY meal B (Carrot Ginger-Turmeric Soup): its garlic returns,
  // meal A's cleared ingredients stay hidden.
  await removeMealFromPlan(page, 'Carrot Ginger-Turmeric Soup')
  await reAddRecipe(page, 'Carrot Ginger-Turmeric Soup')

  await gotoTab(page, 'Grocery')
  const garlic = page.locator('main label').filter({ hasText: /garlic/i })
  await expect(garlic).toHaveCount(1, { timeout: 10_000 })
  // Garlic comes only from the re-added meal — no "2 recipes" pill.
  await expect(garlic.first().getByText('2 recipes')).toHaveCount(0)
})

test('marking a cleared meal cooked forgets its cleared snapshot', async ({ page }) => {
  const meal = await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // ADR-0092: with NOTHING checked the button reads "Clear list" — the
  // confirm-modal full clear, forced past the old empty guard.
  await page.locator('[data-test=grocery-clear]').click()
  await confirmModal(page).locator('[data-test=confirm-action]').click()
  await expect(page.getByTestId('cleared-empty')).toBeVisible()

  // Cooking the meal removes it AND its cleared entry…
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${meal} as cooked` }).click()
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}'),
  )
  expect(persisted.clearedIngredients ?? {}).toEqual({})

  // …so planning it again yields fresh ingredients.
  await reAddRecipe(page, meal)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('cleared-empty')).toHaveCount(0)
})

/* ---------- ADR-0092: clear-checked semantics ---------- */

test('Clear checked removes ONLY checked lines: unchecked remain, unchecked state kept', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  expect(total).toBeGreaterThan(2)

  // Check exactly two lines.
  await page.locator('main input[type=checkbox]').first().click()
  await page.locator('main input[type=checkbox]:not(:checked)').first().click()
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`2 / ${total} items`)

  // Direct action — no confirm modal — with an honest toast.
  await page.locator('[data-test=grocery-clear]').click()
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(page.getByText(/Cleared 2 checked items — unchecked items remain/)).toBeVisible()

  // Two lines gone, the rest stay UNCHECKED: `0 / total-2`.
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`0 / ${total - 2} items`)
  await expect(page.locator('main input[type=checkbox]:checked')).toHaveCount(0)

  // The button falls back to "Clear list" (list still non-empty).
  await expect(page.locator('[data-test=grocery-clear]')).toHaveText(/Clear list/)

  // The cleared lines are HIDDEN (ADR-0005 lifecycle): they do not come
  // back on reload — the merge wrote the cleared snapshot.
  await page.reload()
  await gotoTab(page, 'Grocery')
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`0 / ${total - 2} items`, {
    timeout: 10_000,
  })
})

test('Clear checked removes a checked custom item but keeps the autocomplete memory', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await addCustomItem(page, 'Olive oil')

  // Check the custom item only.
  await page.locator('[data-test=extra-row] input[type=checkbox]').first().click()

  await page.locator('[data-test=grocery-clear]').click()
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()

  // The extra row is GONE; the planned meal's lines remain.
  await expect(page.locator('[data-test=extra-row]')).toHaveCount(0)
  await expect(page.locator('main input[type=checkbox]:checked')).toHaveCount(0)

  // The autocomplete memory SURVIVES (device-local customIngredients,
  // ADR-0012): the remembered entry is still persisted after the clear —
  // clear-checked removes the extra, never the typed-name memory.
  const memory = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:customIngredients') ?? '{}'),
  )
  expect(JSON.stringify(memory)).toContain('Olive oil')
})

/* ---------- ADR-0092: pull-to-clear gesture ---------- */

/**
 * Drive the gesture with synthetic touch PointerEvents on the shared
 * region (the composable listens on the region element itself; the
 * events are synchronous, so mid-drag states are assertable between
 * dispatches).
 */
async function pullDragTo(page: Page, dy: number): Promise<void> {
  await page.evaluate((distance) => {
    const region = document.querySelector('[data-test=pull-clear-region]')
    if (!region) throw new Error('pull-clear-region not mounted')
    const rect = region.getBoundingClientRect()
    const base = rect.top + 10
    const init = (y: number): PointerEventInit => ({
      pointerType: 'touch',
      pointerId: 7,
      isPrimary: true,
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: y,
    })
    region.dispatchEvent(new PointerEvent('pointerdown', init(base)))
    const steps = 5
    for (let i = 1; i <= steps; i++) {
      region.dispatchEvent(
        new PointerEvent('pointermove', init(base + (distance * i) / steps)),
      )
    }
  }, dy)
}

async function releasePull(page: Page, dy: number): Promise<void> {
  await page.evaluate((distance) => {
    const region = document.querySelector('[data-test=pull-clear-region]')
    if (!region) throw new Error('pull-clear-region not mounted')
    const rect = region.getBoundingClientRect()
    region.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerType: 'touch',
        pointerId: 7,
        isPrimary: true,
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + 10 + distance,
      }),
    )
  }, dy)
}

test('pull-to-clear past the threshold runs the same clear-checked action', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  await page.locator('main input[type=checkbox]').first().click()

  // Engage: below the threshold the indicator reads "pull".
  await pullDragTo(page, 40)
  const indicator = page.getByTestId('pull-clear-indicator')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute('data-state', 'pull')
  await expect(indicator).toHaveText('Pull to clear checked')

  // Past the ~80px threshold it arms.
  await pullDragTo(page, 120)
  await expect(indicator).toHaveAttribute('data-state', 'armed')
  await expect(indicator).toHaveText('Release to clear checked')

  // Release runs the SHARED clear-checked action (no modal, toast).
  await releasePull(page, 120)
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`0 / ${total - 1} items`)
  // The indicator is gone (back to idle).
  await expect(indicator).toHaveCount(0)
})

test('pull-to-clear below the threshold cancels and leaves everything checked', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  const total = Number(
    (await page.getByText(/(\d+) \/ (\d+) items/).textContent())!.match(/(\d+) \/ (\d+)/)![2],
  )
  await page.locator('main input[type=checkbox]').first().click()

  // Short drag: the indicator shows, but releasing does NOTHING.
  await pullDragTo(page, 40)
  const indicator = page.getByTestId('pull-clear-indicator')
  await expect(indicator).toHaveAttribute('data-state', 'pull')

  await releasePull(page, 40)
  await expect(indicator).toHaveCount(0)
  // No toast, no modal, nothing cleared.
  await expect(confirmModal(page)).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(page.getByText(/(\d+) \/ (\d+) items/)).toHaveText(`1 / ${total} items`)
  await expect(page.locator('main input[type=checkbox]:checked')).toHaveCount(1)
})

test('pull-to-clear never arms once the page has scrolled (PR #94 round-1 regression)', async ({
  page,
}) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await page.locator('main input[type=checkbox]').first().click()

  // A small viewport guarantees the document is scrollable, so the
  // scrollTo below is a real offset rather than a no-op on a short list.
  await page.setViewportSize({ width: 375, height: 400 })
  // A page scrolled past the arm tolerance is a SCROLL surface, not a
  // pull surface: the drag must stand down quietly (no indicator, no
  // clear) — the guard qodo finding 4 hangs off.
  await page.evaluate(() => window.scrollTo(0, 60))
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await pullDragTo(page, 120)
  await expect(page.getByTestId('pull-clear-indicator')).toHaveCount(0)
  await releasePull(page, 120)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(page.locator('main input[type=checkbox]:checked')).toHaveCount(1)
})

test('pull-to-clear arms within the small mobile scroll-top tolerance', async ({ page }) => {
  await planFirstRecipe(page)
  await gotoTab(page, 'Grocery')
  await expect(page.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await page.locator('main input[type=checkbox]').first().click()

  // Real mobile browsers sit a few px off scrollTop 0 at the visual top
  // (URL-bar / visual-viewport offsets) — the strict `scrollY === 0` the
  // first cut used refused to arm there and only the emulated Pixel 7
  // (no URL bar) passed. The tolerance keeps those devices working.
  await page.evaluate(() => window.scrollTo(0, 2))
  await pullDragTo(page, 120)
  const indicator = page.getByTestId('pull-clear-indicator')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute('data-state', 'armed')
  await releasePull(page, 120)
  await expect(page.getByText(/Cleared 1 checked item — unchecked items remain/)).toBeVisible()
})
