import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  dismissJoinCongrats,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0055 — mobile tap-reveal on the recipe detail view.
 *
 * The recipe detail header is the ONE surface where a labelled icon's
 * host is tap-responsive (ADR-0044's pointer-transparent host is a
 * browse-card rule; the detail header has no stretched link under it).
 * Tapping the icon shows its bubble for TOOLTIP_TAP_REVEAL_MS (3 000),
 * auto-dismisses, and a second tap hides immediately. The reveal is
 * deliberately UNGATED by the `hovercap` media query — this spec runs on
 * the Pixel 7 project, where `(hover: hover)` never matches.
 */

/** The detail header's first named type icon (same locator the
 * design-visual tooltip case pins). */
function detailTypeIcon(page: import('@playwright/test').Page) {
  return page.locator('header [data-test="hue-icon"]', { has: page.locator('svg[role="img"]') }).first()
}

async function openDetail(page: import('@playwright/test').Page) {
  await blockExternalRequests(page)
  await page.goto('/')
  await dismissJoinCongrats(page)
  await waitForCatalog(page)
  await page.locator('[data-test="recipe-card-link"]').first().click()
  await expect(page.getByTestId('detail-title')).toBeVisible()
  await expectZeroMealimeRequests(page)
}

test('tapping the detail type icon reveals its bubble, auto-hidden after ~3 s', async ({ page, isMobile }) => {
  test.skip(isMobile !== true, 'touch project only (Pixel 7)')
  await openDetail(page)

  const host = detailTypeIcon(page)
  await expect(host).toBeVisible()
  const bubble = host.locator('[data-test="icon-tooltip"]')
  await expect(bubble).toBeHidden()

  await host.tap()
  await expect(bubble).toBeVisible()
  // ADR-0049's meaning-carrier rule, inherited: the bubble is aria-hidden.
  await expect(bubble).toHaveAttribute('aria-hidden', 'true')

  // A real wait for the one real timer in the feature (accepted cost,
  // recorded in ADR-0055 Consequences): 3 000 ms + margin.
  await page.waitForTimeout(3_300)
  await expect(bubble).toBeHidden()
})

test('a second tap while open hides the bubble immediately', async ({ page, isMobile }) => {
  test.skip(isMobile !== true, 'touch project only (Pixel 7)')
  await openDetail(page)

  const host = detailTypeIcon(page)
  const bubble = host.locator('[data-test="icon-tooltip"]')
  await expect(bubble).toBeHidden()

  await host.tap()
  await expect(bubble).toBeVisible()
  await host.tap()
  await expect(bubble).toBeHidden()
})

test('tapping a browse-card icon navigates — the card bubble never reveals', async ({ page, isMobile }) => {
  test.skip(isMobile !== true, 'touch project only (Pixel 7)')
  await blockExternalRequests(page)
  await page.goto('/')
  await dismissJoinCongrats(page)
  await waitForCatalog(page)
  await expectZeroMealimeRequests(page)

  // ADR-0044, still pinned by ADR-0055: on a browse card the icon host
  // is pointer-transparent, so the tap reaches the stretched link. The
  // tap-reveal is ABSENT there by construction — the tap must NAVIGATE.
  await page.locator('[data-test="recipe-card-link"]').first().locator('[data-test="hue-icon"]').first().tap()
  await expect(page.getByTestId('detail-title')).toBeVisible()
})