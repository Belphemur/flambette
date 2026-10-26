import { expect, test } from '@playwright/test'
import { blockExternalRequests, expectZeroMealimeRequests } from './helpers'

/**
 * ADR-0098: the recipe detail page holds a best-effort Screen Wake Lock
 * (`'screen'`) while open, using the same pattern CookingView ships
 * (ADR-0020). The lock acquires on mount and releases on unmount; a
 * `visibilitychange` listener re-acquires when the tab returns to visible.
 *
 * These tests install a fake `navigator.wakeLock` before page load (via
 * `addInitScript`) that records 'request' and 'release' into
 * `window.__wakeLog`, so the contract is asserted without a real device.
 */

test.describe('recipe detail screen wake lock (ADR-0098)', () => {
  const readWakeLog = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as { __wakeLog?: string[] }).__wakeLog ?? [])

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
    await page.addInitScript(() => {
      const win = window as { __wakeLog?: string[] }
      win.__wakeLog = []
      const sentinel = {
        release: () => {
          win.__wakeLog!.push('release')
        },
      }
      Object.defineProperty(navigator, 'wakeLock', {
        value: {
          request: (_type: string) => {
            win.__wakeLog!.push('request')
            return Promise.resolve(sentinel)
          },
        },
        configurable: true,
      })
    })
  })

  test('acquires a wake lock on mount, releases on navigation away', async ({ page }) => {
    await page.goto('/recipe/6123')
    await expect(page.getByTestId('detail-title')).toBeVisible()
    // The load-bearing pair: request on mount.
    await expect.poll(() => readWakeLog(page)).toContain('request')

    // Navigate away IN-APP (a page.goto would be a full reload whose
    // initScript wipes __wakeLog before the release could be observed):
    // the SPA route change unmounts the detail page without reloading.
    await page.getByTestId('home-link').click()
    await expect(page.getByTestId('detail-title')).toHaveCount(0)
    await expect.poll(() => readWakeLog(page)).toContain('release')
    await expectZeroMealimeRequests(page)
  })

  test('re-acquires the wake lock when the tab returns to visible', async ({ page }) => {
    await page.goto('/recipe/6123')
    await expect(page.getByTestId('detail-title')).toBeVisible()
    await expect.poll(() => readWakeLog(page)).toContain('request')

    // Stub visibilityState to hidden, fire visibilitychange — the listener
    // does NOT re-acquire while hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(200)

    // Return to visible — the listener re-acquires.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const log = await readWakeLog(page)
    const requestCount = log.filter((e) => e === 'request').length
    expect(requestCount).toBeGreaterThanOrEqual(2)

    // Cleanup on in-app navigate away still works (full page.goto would
    // wipe __wakeLog via the re-run initScript).
    await page.getByTestId('home-link').click()
    await expect(page.getByTestId('detail-title')).toHaveCount(0)
    await expect.poll(() => readWakeLog(page)).toContain('release')
    await expectZeroMealimeRequests(page)
  })

  test('the wake lock never blocks rendering when the API is absent', async ({ page }) => {
    // Install a wakeLock whose request REJECTS (denied/absent) — the
    // detail page must still render and show the step list.
    await page.addInitScript(() => {
      const win = window as { __wakeLog?: string[] }
      win.__wakeLog = []
      Object.defineProperty(navigator, 'wakeLock', {
        value: {
          request: (_type: string) => Promise.reject(new Error('denied')),
        },
        configurable: true,
      })
    })
    await page.goto('/recipe/6123')
    await expect(page.getByTestId('detail-title')).toBeVisible()
    await expect(page.getByTestId('detail-step').first()).toBeVisible()
    // No request was logged (the rejection was swallowed silently).
    expect(await readWakeLog(page)).toEqual([])
    await expectZeroMealimeRequests(page)
  })
})
