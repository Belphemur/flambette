import { expect, test } from '@playwright/test'
import { blockExternalRequests, openFirstRecipeDetail, waitForCatalog } from './helpers'

/**
 * ADR-0051: one-shot `?p=` plan sharing is retired — rooms are the only way
 * to share. `src/lib/share.ts` and its spec are deleted with the feature.
 *
 * The part worth pinning is the RETIREMENT, not the removal: the decoder is
 * gone, so an old link cannot load a plan any more, but it must not fail
 * silently either. Someone with a `?p=` link in a chat, a bookmark or a
 * screenshot would otherwise open the app and get a perfectly normal-looking
 * screen with no explanation for why their plan did not arrive.
 */
test.describe('retired one-time plan links (ADR-0051)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page)
  })

  test('an old ?p= link explains that one-time links are gone, and strips the param', async ({
    page,
  }) => {
    // A payload that the retired decoder would have accepted.
    const payload =
      'H4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAOBthIskjmgRCJEWCE7PU8bDhLZhdGKgQghOOJEmKAT7FN4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOJaLxIrbw6i9ABJi3FEwAAAA=='
    await page.goto(`/plan?p=${payload}`)

    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('One-time plan links were removed')
    await expect(toast).toContainText('room link instead')

    // The param is stripped, so a reload does not repeat the toast and the
    // URL does not keep advertising a dead feature.
    await expect(page).not.toHaveURL(/\?p=/)
    await page.reload()
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('the room half of the share sheet is untouched', async ({ page }) => {
    // The Plan tab renders an EMPTY state (no Share button at all) until a
    // meal is planned, so seed one first.
    await page.goto('/')
    await waitForCatalog(page)
    await openFirstRecipeDetail(page)
    await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
    await page.goto('/plan')
    await page.getByRole('button', { name: 'Share' }).click()

    // The room link surface still works…
    await expect(page.getByRole('dialog', { name: 'Share your meal plan' })).toBeVisible()
    await expect(page.getByTestId('start-room')).toBeVisible()

    // …and the one-time-link half is gone, with no "too large" fallback text
    // (a room link has no size ceiling, so the ceiling never applied).
    await expect(page.getByTestId('copy-share-link')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Share link' })).toHaveCount(0)
    await expect(page.getByText('Plan too large for a one-time link')).toHaveCount(0)
  })
})
