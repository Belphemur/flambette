import { expect, test } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  recipeCards,
  waitForCatalog,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
})

test('toggle favourite on a card, reload, star persists', async ({ page }) => {
  // Pick the first card that is NOT already a favourite (some are seeded
  // from the catalog on first run) and remember its name.
  const target = recipeCards(page)
    .filter({ has: page.getByRole('button', { name: 'Add to favourites' }) })
    .first()
  const name = (await target.getByRole('heading').textContent())!.trim()

  await target.getByRole('button', { name: 'Add to favourites' }).click()
  const card = recipeCards(page).filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(
    card.getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()

  await page.reload()
  await waitForCatalog(page)
  await expect(
    recipeCards(page)
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .getByRole('button', { name: 'Remove from favourites' }),
  ).toBeVisible()
})

test('favourites-only filter shows the starred recipe', async ({ page }) => {
  const target = recipeCards(page)
    .filter({ has: page.getByRole('button', { name: 'Add to favourites' }) })
    .first()
  const name = (await target.getByRole('heading').textContent())!.trim()

  await target.getByRole('button', { name: 'Add to favourites' }).click()
  await page.reload()
  await waitForCatalog(page)

  await page.getByRole('button', { name: '★ Favourites' }).click()
  const visible = recipeCards(page).filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(visible.first()).toBeVisible()
  expect(await recipeCards(page).count()).toBeGreaterThanOrEqual(1)
  // 56 favourites are seeded from the catalog on a fresh profile, so the
  // favourites-only view is around 57 — still tiny vs. the full 2,730-card list
  expect(await recipeCards(page).count()).toBeLessThan(200)
  await expectZeroMealimeRequests(page)
})
