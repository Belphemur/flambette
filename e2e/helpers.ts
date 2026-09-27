import { expect, type Page } from '@playwright/test'

/** Hosts the app must never contact — it is fully offline. */
const FORBIDDEN_HOSTS = /(^|\.)mealime\.com$/

/**
 * Install route interception that fails any request to mealime.com hosts and
 * records the attempts. Assert with `expectZeroMealimeRequests(page)`.
 */
export async function blockExternalRequests(page: Page): Promise<void> {
  const attempts = (page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts ?? []
  ;(page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts = attempts
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    if (FORBIDDEN_HOSTS.test(host)) {
      attempts.push(route.request().url())
      return route.abort('blocked_by_client')
    }
    return route.continue()
  })
}

/** Assert that zero requests were made to mealime.com hosts. */
export async function expectZeroMealimeRequests(page: Page): Promise<void> {
  const attempts = (page as Page & { __mealimeAttempts?: string[] }).__mealimeAttempts ?? []
  expect(attempts, `requests to mealime.com hosts: ${attempts.join(', ')}`).toEqual([])
}

/**
 * Wait for the catalog to finish loading (recipe cards render).
 * Returns the list of recipe card articles.
 */
export function recipeCards(page: Page) {
  return page.locator('main article')
}

export async function waitForCatalog(page: Page): Promise<void> {
  await expect(recipeCards(page).first()).toBeVisible({ timeout: 15_000 })
}

/** Open the first recipe card and wait for the detail sheet. Returns the recipe name. */
export async function openFirstRecipeDetail(page: Page): Promise<string> {
  await recipeCards(page).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  return (await sheet.getByRole('heading', { level: 2 }).textContent())!.trim()
}

/** Open the first recipe card matching `name` and wait for the detail sheet. */
export async function openRecipeDetail(page: Page, name: string | RegExp): Promise<void> {
  await recipeCards(page).filter({ has: page.getByRole('heading', { name }) }).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  return
}

export async function gotoTab(
  page: Page,
  label: 'Recipes' | 'Plan' | 'Grocery' | 'History',
): Promise<void> {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label }).click()
}
