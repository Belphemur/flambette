import { expect, test, type Page } from '@playwright/test'
import { blockExternalRequests, gotoTab, openFirstRecipeDetail, waitForCatalog } from './helpers'

/**
 * Live room sync: two separate browser contexts share plan, custom items
 * and grocery checkmarks through the WebSocket relay (proxied at /ws).
 */

async function planARecipe(page: Page): Promise<string> {
  await page.goto('/')
  await waitForCatalog(page)
  const name = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  return name
}

async function addCustomItem(page: Page, text: string) {
  await page.goto('/grocery')
  await page.getByPlaceholder('Add an item not in the recipes…').fill(text)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-test=custom-items]').getByText(text)).toBeVisible()
}

/** Start a live room from A's plan tab share sheet; returns the room link. */
async function startLiveRoom(page: Page): Promise<string> {
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await page.getByTestId('start-room').click()
  const chip = page.getByTestId('room-chip')
  await expect(chip).toContainText('Live', { timeout: 10_000 })
  // The chip title carries the room code; rebuild the share link.
  const title = await chip.getAttribute('title')
  const code = title!.match(/Live room (\w+)/)![1]
  return `${page.url().replace(/\/plan.*$/, '')}/plan?room=${code}`
}

test('room lifecycle: A shares, B joins and both see each other live', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)

  const recipeName = await planARecipe(a)
  await addCustomItem(a, 'Live room olive oil')
  const roomUrl = await startLiveRoom(a)

  // B joins in a FRESH context via the room link.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

  // B received A's plan + custom items without any reload.
  await expect(b.getByRole('heading', { level: 3, name: recipeName })).toBeVisible()
  await b.goto('/grocery')
  await expect(b.locator('[data-test=custom-items]').getByText('Live room olive oil')).toBeVisible()

  // B adds a custom item -> appears on A (state-level, no reload).
  await b.getByPlaceholder('Add an item not in the recipes…').fill('B brings dessert')
  await b.keyboard.press('Enter')
  await expect
    .poll(
      () =>
        a.evaluate(() => {
          const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
          return JSON.stringify(pinia?.state?.value?.plan?.customItems)
        }),
      { timeout: 10_000 },
    )
    .toContain('B brings dessert')

  // B checks a grocery line -> checked state appears on A.
  await b.goto('/grocery')
  await b.locator('[data-test=custom-items] li').filter({ hasText: 'B brings dessert' }).click()
  await expect
    .poll(
      () =>
        a.evaluate(() => {
          const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
          return JSON.stringify(pinia?.state?.value?.grocery?.map)
        }),
      { timeout: 10_000 },
    )
    .toContain('custom||b brings dessert')

  // A's plan edits propagate to B too (reverse direction).
  await a.goto('/plan')
  await a.getByRole('button', { name: 'Clear plan' }).click()
  await expect
    .poll(
      () =>
        b.evaluate(() => {
          const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
          return JSON.stringify(pinia?.state?.value?.plan?.plan)
        }),
      { timeout: 10_000 },
    )
    .toBe('[]')

  await ctxA.close()
  await ctxB.close()
})

test('reconnect: reloading B keeps it live in the room', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)

  const recipeName = await planARecipe(a)
  const roomUrl = await startLiveRoom(a)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

  // Full page reload: the session-stored room code re-joins automatically.
  await b.reload()
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })
  // Still receiving state: A edits, B sees it.
  await a.goto('/plan')
  await a.getByRole('button', { name: 'Clear plan' }).click()
  await expect
    .poll(
      () =>
        b.evaluate(() => {
          const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
          return JSON.stringify(pinia?.state?.value?.plan?.plan)
        }),
      { timeout: 10_000 },
    )
    .toBe('[]')
  // And B can still render the (now-empty) plan state without errors.
  await b.goto('/plan')
  await expect(b.getByText('Your meal plan is empty')).toBeVisible()
  void recipeName

  await ctxA.close()
  await ctxB.close()
})

test('room sync: A clears the grocery list and B sees it empty', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)

  const recipeName = await planARecipe(a)
  const roomUrl = await startLiveRoom(a)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto(roomUrl)
  await expect(b.getByTestId('room-chip')).toContainText('Live', { timeout: 10_000 })

  // B initially sees the (non-empty) shared grocery list.
  await b.goto('/grocery')
  await expect(b.locator('main label').first()).toBeVisible({ timeout: 10_000 })

  // A clears the list from the Grocery tab…
  await a.goto('/grocery')
  await expect(a.locator('main label').first()).toBeVisible({ timeout: 10_000 })
  await a.locator('main input[type=checkbox]').first().click()
  await a.locator('[data-test=clear-list]').click()
  await a.getByTestId('toast').getByTestId('toast-action-primary').click()
  await expect(a.getByTestId('cleared-empty')).toBeVisible()

  // …and B's list empties live (cleared ingredients are household state).
  await expect(b.getByTestId('cleared-empty')).toBeVisible({ timeout: 10_000 })
  await expect(b.locator('[data-test=shop-row]')).toHaveCount(0)

  // The meal itself stays shared on both plan tabs.
  await b.goto('/plan')
  await expect(b.getByRole('heading', { level: 3, name: recipeName })).toBeVisible()

  void ctxA
  await ctxA.close()
  await ctxB.close()
})

test('joining an unknown room surfaces an error state', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/plan?room=ZZZZZZ')
  await expect(page.getByTestId('room-chip')).toContainText('Offline', { timeout: 10_000 })
})
