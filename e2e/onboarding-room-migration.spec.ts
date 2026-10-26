import { test, expect } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  waitForCatalog,
} from './helpers'

/**
 * ADR-0097 amendment (2026-10-06, household-room migration).
 *
 * A device that is (or becomes) a member of a household room must never
 * see the onboarding tour — the migration marks the tour done at the moment
 * room membership is established. The onboarding store does NOT read room
 * state (DRY); the room-owning layer calls `migrateRoomDone()`.
 *
 * These specs pin the two migration surfaces: a boot that resumes a SAVED
 * household room (never shows the tour, even on /recipes), and a LIVE join
 * from Settings while the tour is pending (dismisses it). A third covers the
 * About-section "Restart tour" CTA added alongside the migration.
 */

// NOTE: the seed room code is inlined as a literal inside each
// addInitScript callback — an addInitScript body is serialized into the
// PAGE context, where module-scope constants (e.g. a SEED_ROOM const)
// do not exist and a reference to one throws before the seed lands.

test.describe('Onboarding room-membership migration (ADR-0097 amendment)', () => {
  test('a device booted with a saved household room never sees the tour', async ({
    page,
  }) => {
    await blockExternalRequests(page)
    // Pre-seed the persisted ui slice with a household room code — the shape
    // the backup/restore specs write (picked persist key). autoJoinHousehold
    // fires at boot and the migration marks the tour done from householdRoom
    // being truthy, BEFORE start() can mount the overlay.
    await page.addInitScript(() => {
      localStorage.setItem(
        'mealime-planner:v1:ui',
        JSON.stringify({ householdRoom: 'amber-falcon-lantern' }),
      )
    })
    await page.goto('/recipes')
    await waitForCatalog(page, false)
    // The overlay must NOT mount — the tour was migrated to done.
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    // Settings' onboarding card reads the migrated (dismissed) state.
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByTestId('onboarding-card')).toContainText('Tour dismissed')
    // The About-section Restart-tour CTA is present (additional requirement).
    await expect(page.getByTestId('settings-about-restart-tour')).toBeVisible()
    await expectZeroMealimeRequests(page)
  })

  test('the About Restart-tour CTA re-opens the tour for a room member', async ({
    page,
  }) => {
    await blockExternalRequests(page)
    await page.addInitScript(() => {
      // Inline literal — SEED_ROOM-style module constants are out of scope
      // inside an addInitScript callback (it runs in the page context).
      localStorage.setItem(
        'mealime-planner:v1:ui',
        JSON.stringify({ householdRoom: 'amber-falcon-lantern' }),
      )
    })
    await page.goto('/recipes')
    await waitForCatalog(page, false)
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click()
    await page.getByTestId('settings-about-restart-tour').scrollIntoViewIfNeeded()
    await page.getByTestId('settings-about-restart-tour').click()
    // restart() clears dismissedForever and lands on /recipes, where the
    // overlay re-mounts for the member who explicitly asked for it.
    await page.waitForURL(/\/recipes$/)
    await expect(page.getByTestId('onboarding-overlay')).toBeVisible()
    await expectZeroMealimeRequests(page)
  })

  test('joining a room from Settings while the tour is pending dismisses it', async ({
    page,
  }) => {
    await blockExternalRequests(page)
    // Boot on the hero (NOT /recipes): bootRoute != 'recipes', so start()
    // never fires — the tour is PENDING (not started, not dismissed, not
    // complete) but not yet active. ADR-0078: the hero hides the bottom nav,
    // so reach Settings by URL.
    await page.goto('/')
    // The hero route has NO recipe cards, so waitForCatalog (which waits
    // for them) would time out here — home-hero renders only after the
    // same loading gate the overlay mount reads (App.vue showOnboarding).
    await page.getByTestId('home-hero').waitFor()
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    await page.goto('/settings')
    // Joining a household room from the Settings card establishes membership.
    await page.getByTestId('household-room-new').click()
    // The migration fires when the room code is saved → dismissedForever set.
    await expect(page.getByTestId('onboarding-card')).toContainText('Tour dismissed')
    // A full reload on /recipes must NOT open the tour: dismissedForever
    // persisted and start() is a no-op for a room member.
    await page.goto('/recipes')
    await page.reload()
    await waitForCatalog(page, false)
    await expect(page.getByTestId('onboarding-overlay')).toHaveCount(0)
    await expectZeroMealimeRequests(page)
  })
})
