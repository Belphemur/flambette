import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  visibleVariantIds,
  waitForCatalog,
} from './helpers'

/**
 * "Cook that week again" (ADR-0085, issue #78): one-tap re-plan of a past
 * week from cooked history. The pill rides the plan-backed group headers
 * (ADR-0034); tapping it opens the ADR-0030 confirm grammar (preview →
 * confirm → exact-state undo) — never a silent replace.
 */

const PLAN_KEY = 'mealime-planner:v1:plan'
const DAY = 86_400_000

/** The history card's recipe name (the h3 inside the row carrying the count disc). */
function historyRowName(page: Page, id: number) {
  return page
    .locator('[data-test="history-row"]')
    .filter({ has: page.getByTestId(`history-count-${id}`) })
    .first()
    .locator('h3')
}

/** The Plan tab's row for one meal name (main ul > li, per the servings specs). */
function planRow(page: Page, name: string) {
  return page.locator('main ul > li').filter({ hasText: name })
}

/**
 * Seed a plan-backed history group ("plan-seed-1": a@t-1d, b@t-2d, a@t-3d
 * — a cooked twice, so the reconstruction must dedupe), one legacy cook
 * ("Earlier cooks"), a PRIOR plan (c at its own 6) and a custom
 * ingredient. The remembered default is 4 (ADR-0037).
 *
 * Returns the ids AND the prior plan meal's name (read off the Plan tab,
 * before any of this spec's actions can touch it).
 */
async function seedWeek(page: Page): Promise<{ a: number; b: number; c: number; nameC: string }> {
  await page.goto('/recipes')
  await waitForCatalog(page)
  const ids = await visibleVariantIds(page)
  const [a, b, c] = ids as [number, number, number]
  const now = Date.now()
  const cooked = (variantId: number, ago: number, planId?: string) => ({
    variantId,
    cookedAt: now - ago,
    id: `seed-${variantId}-${ago}`,
    ...(planId ? { planId, planCreatedAt: now - 7 * DAY } : {}),
  })
  const events = [
    cooked(a, DAY, 'plan-seed-1'),
    cooked(b, 2 * DAY, 'plan-seed-1'),
    cooked(a, 3 * DAY, 'plan-seed-1'),
    cooked(b, 5 * DAY), // no planId → the "Earlier cooks" group
  ]
  await page.evaluate(
    ([seedEvents, priorPlan]) => {
      localStorage.setItem(
        'mealime-planner:v1:ui',
        JSON.stringify({ defaultServings: 4, stepTimers: {} }),
      )
      localStorage.setItem(
        'mealime-planner:v1:plan',
        JSON.stringify({
          plan: priorPlan,
          planId: '',
          planCreatedAt: 0,
          customItems: ['Smoked paprika'],
          clearedIngredients: {},
          cookedHistory: seedEvents,
        }),
      )
    },
    [events, [{ variantId: c, servings: 6 }]],
  )

  // The prior plan meal's name, straight off the plan it seeds. A FULL
  // navigation (not gotoTab): the seed was written after the app already
  // hydrated, so the store only picks it up on the reload.
  await page.goto('/plan')
  const nameC = (await page.locator('main ul > li h3').first().textContent())?.trim() ?? ''
  expect(nameC.length).toBeGreaterThan(0)
  return { a, b, c, nameC }
}

async function openPreview(page: Page) {
  await page.goto('/history')
  const pill = page.getByTestId('history-replan-plan-seed-1')
  await expect(pill).toBeVisible()
  await pill.click()
  await expect(page.getByTestId('replan-preview')).toBeVisible()
}

test('the re-plan pill rides plan-backed groups, never "Earlier cooks"', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const { a } = await seedWeek(page)

  await page.goto('/history')
  await expect(page.getByTestId('history-group-title').first()).toBeVisible()

  // Exactly ONE pill on the page, on the plan-backed group; its
  // accessible name names the plan week (the absolute date is
  // locale-formatted, so the spec pins the sentence, not the date).
  const pill = page.getByTestId('history-replan-plan-seed-1')
  await expect(pill).toContainText('Cook that week again')
  await expect(pill).toHaveAttribute('aria-label', /^Cook that week again —/)
  await expect(page.locator('[data-test^="history-replan-"]')).toHaveCount(1)

  // "Earlier cooks" has no plan to reconstruct — the per-card "Add to
  // plan" stays the only path there.
  const legacy = page.getByTestId('history-group-legacy')
  await expect(legacy).toBeVisible()
  await expect(legacy.locator('[data-test^="history-replan-"]')).toHaveCount(0)

  // Sanity: the group the pill rides really holds the twice-cooked dish.
  await expect(historyRowName(page, a)).toContainText(/\S/)

  await expectZeroMealimeRequests(page)
})

test('the preview shows the week deduped, most-recent-first, and warns before replacing', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const { a, b, nameC } = await seedWeek(page)

  await openPreview(page)
  // The names come off the history rows (now rendered behind the modal —
  // textContent needs no visibility).
  const nameA = (await historyRowName(page, a).textContent())?.trim() ?? ''

  // TWO tiles for THREE cooks: the twice-cooked dish is planned once,
  // most-recent cook first.
  const tiles = page.getByTestId('replan-preview').locator('[data-test^="replan-meal-"]')
  await expect(tiles).toHaveCount(2)
  const orderedIds = await tiles.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-test')),
  )
  expect(orderedIds).toEqual([`replan-meal-${a}`, `replan-meal-${b}`])

  // The tile carries the meal's picture and title — the same bundled
  // catalog image the cards use.
  await expect(
    page.getByTestId(`replan-meal-${a}`).getByRole('img', { name: nameA }),
  ).toBeVisible()

  // The meals count at the remembered default + the replace warning
  // (the prior plan holds one meal).
  await expect(page.getByTestId('replan-preview')).toContainText('2 meals at 4 servings each')
  await expect(page.getByTestId('replan-warning')).toContainText('Replaces your current plan (1 meal)')

  // ONE preview at a time: the pill is inert while it is open.
  await expect(page.getByTestId('history-replan-plan-seed-1')).toBeDisabled()

  // "Keep editing" escapes without touching the plan.
  await page.getByTestId('replan-cancel').click()
  await expect(page.getByTestId('replan-preview')).toHaveCount(0)
  await gotoTab(page, 'Plan')
  await expect(planRow(page, nameC).getByLabel('Servings', { exact: true })).toHaveText('6')

  await expectZeroMealimeRequests(page)
})

test('confirming replaces the plan with the week at the remembered default', async ({
  page,
}) => {
  await blockExternalRequests(page)
  const { a, b, nameC } = await seedWeek(page)

  await openPreview(page)
  const nameA = (await historyRowName(page, a).textContent())?.trim() ?? ''
  const nameB = (await historyRowName(page, b).textContent())?.trim() ?? ''
  await page.getByTestId('replan-confirm').click()
  await expect(page.getByTestId('replan-preview')).toHaveCount(0)

  // The plan IS the old week now: both group meals, each at 4.
  await gotoTab(page, 'Plan')
  await expect(planRow(page, nameA).getByLabel('Servings', { exact: true })).toHaveText('4')
  await expect(planRow(page, nameB).getByLabel('Servings', { exact: true })).toHaveText('4')
  // The displaced prior meal is gone, not merged.
  await expect(page.locator('main ul > li')).toHaveCount(2)
  await expect(planRow(page, nameC)).toHaveCount(0)

  await expectZeroMealimeRequests(page)
})

test('undo restores the exact confirm-time plan', async ({ page }) => {
  await blockExternalRequests(page)
  const { c, nameC } = await seedWeek(page)

  await openPreview(page)
  await page.getByTestId('replan-confirm').click()
  // The undo rides the toast (6 s window) — act while it is up.
  await page.getByTestId('replan-undo').click()

  // The PRIOR plan is back exactly: meal c at its OWN 6 (the historical
  // week's 4-servings counts are deliberately NOT replayed), the custom
  // ingredient restored, no trace of the re-planned week.
  await gotoTab(page, 'Plan')
  await expect(page.locator('main ul > li')).toHaveCount(1)
  await expect(planRow(page, nameC).getByLabel('Servings', { exact: true })).toHaveText('6')
  // Exact state, storage-level: entries AND custom ingredients as they
  // were at confirm time (a room peer may have planned mid-preview —
  // the undo restores the confirmed-over state, not the preview's).
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
    PLAN_KEY,
  )
  expect(stored.plan).toEqual([{ variantId: c, servings: 6 }])
  expect(stored.customItems).toEqual(['Smoked paprika'])

  await expectZeroMealimeRequests(page)
})
