import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  visibleVariantIds,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
})

/**
 * Enter cooking mode from the first recipe's detail sheet, WITHOUT planning
 * it first: any catalog recipe is cookable (ADR-0034). Returns the cooking
 * dialog and the recipe name.
 */
async function startCooking(page: import('@playwright/test').Page) {
  const name = await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return { cooking, name }
}

/** As above, but the recipe is in the plan — the meal the Finish button
 *  takes out of it. */
async function startCookingPlanned(page: import('@playwright/test').Page) {
  const name = await openFirstRecipeDetail(page)
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: /Add to plan|Update in plan/ }).click()
  await sheet.getByRole('button', { name: 'Start cooking' }).click()
  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  return { cooking, name }
}

/** Walk to the last step view. */
async function gotoLastStep(cooking: import('@playwright/test').Locator) {
  const progress = await cooking.getByText(/Step 1 \/ (\d+)/).textContent()
  const total = Number(progress!.match(/Step 1 \/ (\d+)/)![1])
  const next = cooking.getByRole('button', { name: /Next/ })
  for (let i = 1; i < total; i++) await next.click()
  await expect(cooking.getByText(new RegExp(`Step ${total} \\/ ${total}`))).toBeVisible()
  return total
}

/** The session's recorded cook events, read off the plan store (ADR-0032). */
async function cookedHistoryCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return ((pinia?.state?.value?.plan?.cookedHistory ?? []) as unknown[]).length
  })
}

/** The persisted household ratings (same contract as household-ratings.spec). */
async function ratingsOf(page: import('@playwright/test').Page): Promise<Record<string, { rating: number; count: number; updatedAt: number }>> {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return (pinia?.state?.value?.ratings?.map ?? {}) as Record<string, { rating: number; count: number; updatedAt: number }>
  })
}

test('cooking mode shows one step at a time with progress', async ({ page }) => {
  const { cooking } = await startCooking(page)

  // Step 1 content visible with progress "1 / N"
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText('Wash and dry the fresh produce.')).toBeVisible()
  // Step details render as a checklist sub-list
  await expect(cooking.getByText('6 medium carrots')).toBeVisible()
  // Previous is disabled on the first step
  await expect(cooking.getByRole('button', { name: /Previous/ })).toBeDisabled()
  await expectZeroMealimeRequests(page)
})

test('Next advances, progress updates, arrow keys work', async ({ page }) => {
  const { cooking } = await startCooking(page)

  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText(/Trim off the ends and peel the carrots/)).toBeVisible()
  await expect(cooking.getByRole('button', { name: /Previous/ })).toBeEnabled()

  // Keyboard navigation
  await page.keyboard.press('ArrowRight')
  await expect(cooking.getByText(/Step 3 \/ \d+/)).toBeVisible()
  await expect(cooking.getByText(/Preheat a medium saucepan/)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('any recipe is cookable — Start cooking needs no plan (ADR-0034)', async ({ page }) => {
  // The plan is empty: cooking is no longer a plan-driven mode.
  await gotoTab(page, 'Plan')
  await expect(page.getByText('Your meal plan is empty')).toBeVisible()
  await gotoTab(page, 'Recipes')

  const { cooking, name } = await startCooking(page)
  await expect(cooking.getByTestId('step-counter')).toBeVisible()

  // An unplanned cook serves the recipe's OWN serving count.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 6')
  expect(name).not.toBe('')
  await expectZeroMealimeRequests(page)
})

test('a deep link to an unplanned recipe opens cooking mode (ADR-0034)', async ({ page }) => {
  const name = await openFirstRecipeDetail(page)
  const id = new URL(page.url()).pathname.split('/').pop()
  await page.goto(`/cooking/${id}`)

  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking).toBeVisible()
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  // Servings fall back to the recipe's own, not to a plan entry.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 6')
  expect(name).not.toBe('')
  await expectZeroMealimeRequests(page)
})

test('Finish raises the post-cook prompt; Done lands on History (ADR-0083)', async ({ page }) => {
  const { cooking, name } = await startCooking(page)
  await gotoLastStep(cooking)

  const finish = cooking.getByTestId('finish')
  await expect(finish).toBeVisible()
  // Finish is the ONLY mark on the last step: one action, one button.
  await expect(cooking.getByTestId('mark-cooked')).toHaveCount(0)
  await expect(finish).toContainText('Finish')
  await finish.click()

  // The modal IS the acknowledgment (ADR-0083): prompt up over the
  // still-mounted session, "Enjoy! Marked as cooked" toast NOT fired.
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.getByRole('heading', { name: 'Enjoyed it?' })).toBeVisible()
  await expect(prompt.getByTestId('rating-stars')).toBeVisible()
  await expect(prompt.getByRole('button', { name: 'Add to favourites' })).toBeVisible()
  await expect(prompt.getByTestId('post-cook-done')).toBeVisible()
  await expect(prompt.getByTestId('post-cook-undo')).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(cooking).toBeVisible()

  // A rating made in the prompt writes the SAME ratings store: the half
  // grid is live here exactly as on the detail card, and it persists.
  await prompt.getByRole('button', { name: 'Rate 4.5 of 5 stars' }).click()
  await expect(prompt.getByTestId('rating-stars')).toHaveAttribute('data-rating', '4.5')
  expect(Object.values(await ratingsOf(page))).toContainEqual(
    expect.objectContaining({ rating: 4.5, count: 1 }),
  )

  // Done: one close, one destination — History, where the entry landed.
  await prompt.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)
  await expect(cooking).not.toBeVisible()
  await expect(page.getByTestId('history-row').first()).toContainText(name)
  await expectZeroMealimeRequests(page)
})

test('the post-cook prompt closes to History on Escape too (ADR-0083)', async ({ page }) => {
  const { cooking } = await startCooking(page)
  await gotoLastStep(cooking)
  await cooking.getByTestId('finish').click()
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()

  // Escape is a non-Undo close: the same destination as Done (ADR-0083).
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/history$/)
  await expect(page.getByTestId('post-cook-prompt')).toHaveCount(0)
})

test('the post-cook prompt Undo stays in the session with the record removed (ADR-0083)', async ({
  page,
}) => {
  const { cooking } = await startCooking(page)
  await gotoLastStep(cooking)
  await cooking.getByTestId('finish').click()
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  expect(await cookedHistoryCount(page)).toBe(1)

  // Undo calls the SAME plan.undoMarkCooked the toast Undo called: the
  // record is gone and the cook STAYS open — no /history navigation.
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(cooking).toBeVisible()
  await expect(page).toHaveURL(/\/cooking\//)
  expect(await cookedHistoryCount(page)).toBe(0)

  // Leaving afterwards is a plain session close: History stays empty.
  await page.keyboard.press('Escape')
  await expect(cooking).not.toBeVisible()
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('Finish takes a planned meal out of the plan, and Undo puts it back', async ({ page }) => {
  const { cooking, name } = await startCookingPlanned(page)
  // Cooking mode is a full-screen view; the tab bar is behind it.
  await page.keyboard.press('Escape')
  await expect(cooking).not.toBeVisible()
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('button', { name: `Mark ${name} as cooked` })).toBeVisible()

  // Straight back into the cook — this leg is a deep link, which is how
  // a shared URL reaches an unfinished cook.
  const id = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('mealime-planner:v1:plan') ?? '{}')
    return stored.plan[0].variantId
  })
  await page.goto(`/cooking/${id}`)
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible()
  await gotoLastStep(reopened)
  await reopened.getByTestId('finish').click()

  // One action, acknowledged by the prompt (ADR-0083): the cook event is
  // recorded AND the meal left the plan (read off the store — the plan
  // tab is behind the full-screen cook session).
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => {
      const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
      return ((pinia?.state?.value?.plan?.plan ?? []) as unknown[]).length
    }))
    .toBe(0)

  // Undo restores the exact prior state — the SAME plan.undoMarkCooked
  // the old toast Undo called — and STAYS in the cooking session.
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(reopened).toBeVisible()
  await expect(page).toHaveURL(/\/cooking\//)
  await page.keyboard.press('Escape')
  await expect(reopened).not.toBeVisible()

  // …the meal is back in the plan…
  await gotoTab(page, 'Plan')
  await expect(page.getByRole('button', { name: `Mark ${name} as cooked` })).toBeVisible()
  // …and the cook event is gone.
  await gotoTab(page, 'History')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expectZeroMealimeRequests(page)
})

test('mark as cooked is available at EVERY step and converges on the prompt (ADR-0034, ADR-0083 addendum)', async ({ page }) => {
  const { cooking, name } = await startCooking(page)

  // Reachable on the first step, not only at the end.
  const mark = cooking.getByTestId('mark-cooked')
  await expect(mark).toBeVisible()
  await mark.click()

  // ADR-0083 addendum: the mid-cook mark raises the SAME post-cook
  // prompt as Finish — the modal IS the acknowledgment, no toast.
  const prompt = page.getByTestId('post-cook-prompt')
  await expect(prompt).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(cooking).toBeVisible()
  expect(await cookedHistoryCount(page)).toBe(1)

  // Undo removes the record and the session RESUMES exactly where it
  // was — the ADR-0034 keep-cooking contract, carried by the prompt's
  // Undo now that the toast is retired.
  await prompt.getByTestId('post-cook-undo').click()
  await expect(prompt).toHaveCount(0)
  await expect(cooking).toBeVisible()
  await expect(cooking.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expect(cooking.getByTestId('mark-cooked')).toBeEnabled()
  expect(await cookedHistoryCount(page)).toBe(0)

  // A session records ONE cook: finishing after the mid-cook mark
  // raises the prompt WITHOUT writing a second event (ADR-0034/0083).
  await gotoLastStep(cooking)
  await cooking.getByTestId('finish').click()
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()
  expect(await cookedHistoryCount(page)).toBe(1)

  // The acknowledged entry lands on History and reads back on the recipe.
  await page.getByTestId('post-cook-done').click()
  await expect(page).toHaveURL(/\/history$/)
  await gotoTab(page, 'Recipes')
  await openRecipeDetail(page, name)
  await expect(page.getByTestId('cook-history')).toContainText('Cooked 1 time')
  await expectZeroMealimeRequests(page)
})
test('marking mid-cook does not rescale the cook (ADR-0034)', async ({ page }) => {
  // The servings of a cook are decided when the session opens. Marking
  // "as cooked" drops the meal from the plan, and a live servings lookup
  // would fall back to the recipe's base serving_count and silently
  // rescale every remaining step under the user mid-recipe.
  await blockExternalRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  const [id] = await visibleVariantIds(page)
  await page.evaluate((variantId) => {
    localStorage.setItem(
      'mealime-planner:v1:plan',
      JSON.stringify({ plan: [{ variantId, servings: 2 }], customItems: [], clearedIngredients: {} }),
    )
  }, id)
  await page.goto(`/cooking/${id}`)

  const cooking = page.getByRole('dialog', { name: /Cooking / })
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 2')
  await expect(cooking.getByTestId('mark-cooked')).toBeVisible()
  await cooking.getByTestId('mark-cooked').click()
  // ADR-0083 addendum: the mid-cook mark raises the prompt (no toast);
  // the session stays mounted behind it.
  await expect(page.getByTestId('post-cook-prompt')).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)

  // Same servings, same step, after the meal is off the plan.
  await expect(cooking.getByTestId('cook-serves')).toContainText('serves 2')
  await expect(cooking.getByTestId('step-counter')).toContainText('Step 1 /')
  await expectZeroMealimeRequests(page)
})

test('cooking position is not persisted across a reload', async ({ page }) => {
  const { cooking } = await startCooking(page)
  await cooking.getByRole('button', { name: /Next/ }).click()
  await expect(cooking.getByText(/Step 2 \/ \d+/)).toBeVisible()

  // The route survives the reload; the step position resets to step 1.
  await page.reload()
  const reopened = page.getByRole('dialog', { name: /Cooking / })
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect(reopened.getByText(/Step 1 \/ \d+/)).toBeVisible()
  await expectZeroMealimeRequests(page)
})
