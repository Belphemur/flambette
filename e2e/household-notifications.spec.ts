import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  liveRoomCode,
  waitForCatalog,
} from './helpers'

/**
 * Household push notifications (ADR-0102): the Settings surface and the
 * CLIENT-side triggers.
 *
 * What is observable IN-PAGE here is deliberately the client half: the
 * `notify` frame the page sends over its room socket (a real WebSocket,
 * read through Playwright's frame capture), and the Settings card. The
 * actual Web Push SEND happens server-side (relay-core specs pin the
 * fan-out, dedupe, prune and no-VAPID inertness); the e2e relay runs with
 * no VAPID keys, so the feature is inert there — which is also why these
 * specs see no permission prompt (the composable stops before it) and no
 * subscription, and why every `notify` frame goes out WITHOUT `self`.
 */

interface NotifyFrame {
  type: 'notify'
  key: string
  self?: string
}

/** Capture every `notify` frame the page sends over any of its sockets. */
function attachNotifyCollector(page: Page): NotifyFrame[] {
  const frames: NotifyFrame[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (data) => {
      if (typeof data.payload !== 'string') return
      try {
        const parsed = JSON.parse(data.payload) as { type?: string; key?: string }
        if (parsed.type === 'notify' && typeof parsed.key === 'string') {
          frames.push(parsed as unknown as NotifyFrame)
        }
      } catch {
        /* not JSON: not a relay frame */
      }
    })
  })
  return frames
}

/**
 * Join a fresh room through the Settings card the way a person does —
 * `New code` rolls AND joins (ADR-0049) — and wait for the live chip.
 * The plan stays EMPTY: a plan-started trigger test needs the 0 → ≥1
 * transition to still be ahead of the room.
 */
async function joinFreshRoom(page: Page): Promise<string> {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await gotoTab(page, 'Settings')
  await page.getByTestId('household-room-new').click()
  return liveRoomCode(page)
}

/** Plan the n-th catalog recipe from its detail sheet (1-based). */
async function planRecipeNth(page: Page, n: number): Promise<void> {
  await gotoTab(page, 'Recipes')
  await page.locator('main article').nth(n - 1).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByTestId('add-to-plan').click()
  await page.getByRole('button', { name: 'Back' }).click()
}

/** The grocery progress line ("N / N items") — the all-checked derivation's face. */
function groceryProgress(page: Page) {
  return page.locator('main').getByText(/\d+ \/ \d+ items/)
}

/* ---------------------------------------------------------- settings card */

test('the Household notifications card sits right after the Household Room card, ON by default', async ({
  page,
}) => {
  await blockExternalRequests(page)
  await page.goto('/settings')

  const card = page.getByTestId('notif-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Household notifications')
  await expect(card).toContainText('Notify the household')

  // The adopted render's placement (Stitch Variant 1): the dedicated card
  // directly after the Household Room card in the ADR-0077 grid.
  const order = await page.evaluate(() => {
    const grid = document.querySelector('[data-test=unit-system-card]')?.parentElement
    if (!grid) return []
    return [...grid.children].map((el) => (el as HTMLElement).dataset.test ?? '')
  })
  expect(order.indexOf('notif-card')).toBe(order.indexOf('household-card') + 1)

  // ON by default — the owner's ruling, same family as the timer alerts.
  await expect(page.getByTestId('notif-toggle')).toBeChecked()
  // localhost IS a secure context with push APIs: no unavailable note.
  await expect(page.getByTestId('notif-unsupported')).toHaveCount(0)

  await expectZeroMealimeRequests(page)
})

test('the toggle persists across a reload, OFF as well as ON', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/settings')
  await page.getByTestId('notif-toggle').click()
  await expect(page.getByTestId('notif-toggle')).not.toBeChecked()
  await page.reload()
  await expect(page.getByTestId('notif-toggle')).not.toBeChecked()
  await page.getByTestId('notif-toggle').click()
  await expect(page.getByTestId('notif-toggle')).toBeChecked()
  await page.reload()
  await expect(page.getByTestId('notif-toggle')).toBeChecked()
  await expectZeroMealimeRequests(page)
})

/* ------------------------------------------------- plan-started trigger */

test('plan-started: the first recipe on an empty plan notifies once, later adds stay silent', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const notifies = attachNotifyCollector(page)
  const started = () => notifies.filter((f) => f.key === 'plan-started')

  await joinFreshRoom(page)

  // The plan is empty and the socket is live: the FIRST add is the news.
  await planRecipeNth(page, 1)
  await expect.poll(() => started().length, { timeout: 10_000 }).toBe(1)
  // No subscription exists (the e2e relay carries no VAPID keys), so the
  // frame carries no `self` — the sender exclusion simply has nothing to
  // exclude, and an un-subscribed actor is not pinged anyway.
  expect(started()[0].self).toBeUndefined()

  // Later adds land on a non-empty plan: never news again. A DIFFERENT
  // recipe — reopening the planned one would read "Update in plan".
  await planRecipeNth(page, 2)
  await expect.poll(() => started().length, { timeout: 5_000 }).toBe(1)

  // Emptied and re-started is a NEW plan: the trigger fires again.
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: 'Clear plan' }).click()
  await expect.poll(async () => (await page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return (pinia?.state?.value?.plan?.plan ?? []).length
  }))).toBe(0)
  await planRecipeNth(page, 1)
  await expect.poll(() => started().length, { timeout: 10_000 }).toBe(2)

  await expectZeroMealimeRequests(page)
})

/* ------------------------------------------ Auto-Plan undo is exempt */

test('plan-started: an Auto-Plan apply notifies; its Undo does not fire a second time', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const notifies = attachNotifyCollector(page)
  const started = () => notifies.filter((f) => f.key === 'plan-started')

  await joinFreshRoom(page)

  // The apply: ADD mode over an empty plan is a real plan start.
  await gotoTab(page, 'Plan')
  await page.getByTestId('auto-plan-button').first().click()
  await expect(page.getByTestId('auto-plan-dialog')).toBeVisible()
  await page.getByTestId('auto-plan-generate').click()
  await expect(page.getByTestId('auto-plan-confirm')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('auto-plan-confirm').click()
  await expect.poll(() => started().length, { timeout: 10_000 }).toBe(1)

  // The undo restores the confirm-time state — that is not a plan start.
  const toast = page.locator('[data-test="autoplan-toast-toast"]')
  await expect(toast).toBeVisible()
  await toast.getByTestId('auto-plan-undo').click()
  await expect.poll(async () => (await page.evaluate(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
    return (pinia?.state?.value?.plan?.plan ?? []).length
  }))).toBe(0)
  // Give any (forbidden) second frame every chance to arrive, then pin.
  await page.waitForTimeout(1_000)
  expect(started()).toHaveLength(1)

  await expectZeroMealimeRequests(page)
})

/* --------------------------------------------- grocery-finished trigger */

test('grocery-finished: the last check notifies once; a new completion notifies again', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const notifies = attachNotifyCollector(page)
  const finished = () => notifies.filter((f) => f.key === 'grocery-finished')

  await joinFreshRoom(page)
  await planRecipeNth(page, 1)

  // Check every line, driven by the progress counter — the derivation's
  // face. DOM counting is wrong here: one checkbox can cover several
  // rendered rows that share a checked key (merged seasonings), so one
  // click legitimately advances the counter by more than one.
  await gotoTab(page, 'Grocery')
  await expect(groceryProgress(page)).toBeVisible({ timeout: 10_000 })
  const total = (await groceryProgress(page).textContent())!.match(/(\d+) items/)![1]
  const uncheckedVisible = page
    .locator('main input[type="checkbox"]:not(:checked)')
    .locator('visible=true')
  for (let i = 0; i < 60; i++) {
    if ((await groceryProgress(page).textContent())!.includes(`${total} / ${total} items`)) break
    // click(), never check(): a checked row SINKS to the end of its
    // section (ADR-0095), so check()'s "did this element become
    // checked" verification races the re-render and re-resolves to the
    // next row — click once and let the counter be the verdict.
    await uncheckedVisible.first().click()
  }
  await expect(groceryProgress(page)).toHaveText(`${total} / ${total} items`)
  await expect
    .poll(() => finished().length, { timeout: 10_000 })
    .toBe(1)
  expect(finished()[0].self).toBeUndefined()

  // ADR-0092's auto-trigger is part of the same moment: the confirm modal
  // ("clear the grocery list?") is up. Cancel it — the notification and
  // the prompt are independent surfaces.
  const clearPrompt = page.locator('[data-test=confirm-modal]')
  await expect(clearPrompt).toContainText('All items checked', { timeout: 10_000 })
  await clearPrompt.locator('[data-test=confirm-cancel]').click()
  await expect(clearPrompt).toHaveCount(0)

  // An uncheck re-arms the per-transaction latch without notifying: the
  // cheapest uncheck is a NEW extra (the list stops being all-checked),
  // then completing it again is a genuinely new completion.
  await page.getByPlaceholder('Add an item not in the recipes…').fill('Qoruvva extra')
  await page.keyboard.press('Enter')
  await expect(page.locator('main').getByText('Qoruvva extra')).toBeVisible()
  await expect.poll(() => finished().length, { timeout: 5_000 }).toBe(1)
  await page
    .locator('main input[type="checkbox"]:not(:checked)')
    .last()
    .click()
  await expect.poll(() => finished().length, { timeout: 10_000 }).toBe(2)

  await expectZeroMealimeRequests(page)
})
