/**
 * Dietary restrictions (the restriction ADR — ADR-0056).
 *
 * Settings selector → catalog filter → upstream-faithful substitution, all
 * OFFLINE (the artifacts ship in the bundle; `expectZeroMealimeRequests`
 * proves no mealime.com host is ever touched). Fixtures measured live:
 * GF removes rid 50 (variant 4788, "…Couscous") and reworks rid 2195
 * (variant 18895) whose `rotini pasta` line becomes `gluten-free rotini
 * pasta` upstream's own rendering.
 *
 * The load-bearing rule under test: the DISPLAYED name is the reworked one,
 * while every persisted key stays the BASE doc's — checking a grocery row,
 * flipping the unit system and reloading must leave the check intact.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  recipeCards,
  waitForCatalog,
} from './helpers'

// 'rotini' matches only 50 variants and includes 18895; the display order is
// catalog order (not search rank) and only ~60 cards render per batch, so the
// long recipe NAME would OR-match >1500 variants and never render the target.
const STILL_SHOWN = 'rotini'
const SWAPPED = 'gluten-free rotini pasta'
const BASE_NAME = 'rotini pasta'

async function searchRecipes(page: Page, query: string) {
  await page.getByRole('searchbox', { name: 'Search recipes or ingredients' }).fill(query)
}

async function activateGlutenFree(page: Page) {
  await page.goto('/settings')
  await page.getByTestId('restriction-chip-gluten-free').click()
  await expect(page.getByTestId('restriction-chip-gluten-free')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('the selector offers the twelve upstream restrictions and persists the choice', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(page.getByTestId('dietary-restrictions')).toBeVisible()
  const chips = page.locator('[data-test^="restriction-chip-"]')
  await expect(chips).toHaveCount(12)

  const gf = page.getByTestId('restriction-chip-gluten-free')
  await expect(gf).toHaveAttribute('aria-pressed', 'false')
  await gf.click()
  await expect(gf).toHaveAttribute('aria-pressed', 'true')

  // The choice persists across a reload (ui.dietaryRestrictionIds).
  await page.reload()
  await expect(page.getByTestId('restriction-chip-gluten-free')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

const cardFor = (page: Page, name: string | RegExp) =>
  recipeCards(page).filter({ has: page.getByRole('heading', { name }) })

test('an active restriction removes its recipes from discovery (search included)', async ({
  page,
}) => {
  await page.goto('/recipes')
  await waitForCatalog(page)
  // 'couscous' matches 43 recipes — one batch renders them all, so the
  // SPECIFIC removed card is asserted, not the whole result count.
  await searchRecipes(page, 'couscous')
  await expect(cardFor(page, /Cauliflower & Chickpea Coconut Curry with Couscous/)).toHaveCount(1)

  await activateGlutenFree(page)

  await gotoTab(page, 'Recipes')
  await waitForCatalog(page)
  await searchRecipes(page, 'couscous')
  await expect(cardFor(page, /Cauliflower & Chickpea Coconut Curry with Couscous/)).toHaveCount(0)
  // A recipe the rework KEPT still shows (substituted doc survives).
  await searchRecipes(page, STILL_SHOWN)
  await expect(cardFor(page, /White Bean Pasta Salad/)).toHaveCount(1)
})

test('a recipe that survives shows the substituted ingredient name', async ({ page }) => {
  await activateGlutenFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, STILL_SHOWN)
  await cardFor(page, /White Bean Pasta Salad/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // Upstream's own restricted rendering — the dictionary swap, verbatim. The
  // text legitimately appears twice (the ingredient li AND its measured
  // amount chip), so assert the first.
  await expect(sheet.getByText(SWAPPED).first()).toBeVisible()
})

test('the grocery row shows the substituted name and the checkbox key survives units + reload', async ({
  page,
}) => {
  await activateGlutenFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, STILL_SHOWN)
  await cardFor(page, /White Bean Pasta Salad/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await sheet.getByTestId('add-to-plan').click()
  await page.keyboard.press('Escape')

  await gotoTab(page, 'Grocery')
  const row = page.getByTestId('grocery-row').filter({ hasText: SWAPPED }).first()
  await expect(row).toBeVisible()
  // The row is grouped under the BASE name's key: checking it, toggling
  // units and reloading must not orphan the check (the key/display split).
  // click(), not check(): the checked-sink re-sort MOVES the row on the
  // false→true transition, and the section auto-collapses under it
  // (ADR-0008), so a post-click re-verification of the same locator races.
  await row.locator('input[type="checkbox"]').click()
  // The check landed: the section's pill reads 1/1 and the section has
  // auto-collapsed (the row is gone from the DOM).
  const section = page
    .getByTestId('grocery-section')
    .filter({ hasText: /Pasta & Sauces/ })
  await expect(section.locator('[data-test="section-count-pill"]')).toHaveText('1/1')

  await gotoTab(page, 'Settings')
  await page.getByTestId('unit-system-imperial').click()
  await expect(page.getByTestId('unit-system-imperial')).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await gotoTab(page, 'Grocery')
  // The collapse persisted; re-expand the section to see the row again.
  // WAIT for collapsed first: the collapse state applies asynchronously
  // after the first render, so an immediate click can land while the
  // section is still expanded and COLLAPSE it instead.
  const reloadedSection = page
    .getByTestId('grocery-section')
    .filter({ hasText: /Pasta & Sauces/ })
  const reloadedToggle = reloadedSection.getByTestId('grocery-section-toggle')
  await expect(reloadedToggle).toHaveAttribute('aria-expanded', 'false')
  await reloadedToggle.click()
  const reloaded = page.getByTestId('grocery-row').filter({ hasText: SWAPPED }).first()
  await expect(reloaded).toBeVisible()
  await expect(reloaded.locator('input[type="checkbox"]')).toBeChecked()
  // The substituted name survives the reload too.
  await expect(reloaded.getByText(SWAPPED).first()).toBeVisible()
})

/* ---------- The metric-substitution + no-cross-pair brief (GF rid 224) ----------
 *
 * The first archive pulled US/6 payloads and the dictionary swapped whole
 * `line_items` in, so a metric/dual device showed a restricted recipe stuck
 * in imperial (`24 fl oz chicken or vegetable broth`, `18 oz gluten-free
 * fettuccine pasta`). And because upstream's rework REORDERS lines (pasta <->
 * garlic), the grocery once displayed `6 cloves gluten-free fettuccine
 * pasta` — a (name, quantity) pair that appears in NEITHER doc.
 */
const FETTUCCINE = /Fettuccine Alfredo with Asparagus/
const GF_FETTUCCINE = 'gluten-free fettuccine pasta'

async function openRestrictedDetail(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, 'alfredo')
  await cardFor(page, FETTUCCINE).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  return sheet
}

test('a metric device shows the restricted detail in metric — the dictionary swap stays metric', async ({
  page,
}) => {
  await activateGlutenFree(page)
  await page.goto('/settings')
  await page.getByTestId('unit-system-metric').click()
  await expect(page.getByTestId('unit-system-metric')).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  const sheet = await openRestrictedDetail(page)
  // Dictionary substitution — the swap `fettuccine pasta` → `gluten free fettuccine pasta`.
  // Quantities stay from the base doc (verbatim), which are metric (ADR-0047).
  await expect(sheet.getByText('354 ml').first()).toBeVisible()
  await expect(sheet.getByText('510 g').first()).toBeVisible()
  await expect(sheet.getByText(GF_FETTUCCINE).first()).toBeVisible()
  await expect(sheet.getByText(/fl oz| oz | lb /)).toHaveCount(0)
})

test('dual mode shows the authored metric notation too (the swap keeps base quantities)', async ({
  page,
}) => {
  await activateGlutenFree(page)
  await page.goto('/settings')
  await page.getByTestId('unit-system-dual').click()
  await expect(page.getByTestId('unit-system-dual')).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Dual is the IDENTITY (ADR-0047): the catalog text exactly as authored —
  // and the dictionary swaps keep base quantities, so the authored strings
  // are metric.
  const sheet = await openRestrictedDetail(page)
  await expect(sheet.getByText('354 ml').first()).toBeVisible()
  await expect(sheet.getByText('510 g').first()).toBeVisible()
  await expect(sheet.getByText(/fl oz| oz | lb /)).toHaveCount(0)
})

test('the grocery row pairs the substituted name with ITS OWN quantity (no cross-pair)', async ({
  page,
}) => {
  await activateGlutenFree(page)
  const sheet = await openRestrictedDetail(page)
  await sheet.getByTestId('add-to-plan').click()
  await page.keyboard.press('Escape')

  await gotoTab(page, 'Grocery')
  // The (name, quantity) pair must co-occur in ONE authoritative doc: the
  // dictionary swap is per-ingredient, so a display row's quantity is always
  // that ingredient's own. The mis-pairing bug — `6 cloves gluten-free
  // fettuccine pasta`, the base garlic quantity under the swap pasta name —
  // appears in NEITHER doc and must never render.
  const row = page.getByTestId('grocery-row').filter({ hasText: GF_FETTUCCINE }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('510 g')
  await expect(page.getByTestId('grocery-row').filter({ hasText: /6 cloves.*fettuccine/ })).toHaveCount(0)
  // The garlic row is garlic, with garlic's own quantity. (The quantity and
  // name are separate flex spans: the row's innerText has NO space between
  // them — '6 clovesgarlic' — so filter on both substrings.)
  const garlic = page
    .getByTestId('grocery-row')
    .filter({ hasText: '6 cloves' })
    .filter({ hasText: 'garlic' })
    .first()
  await expect(garlic).toBeVisible()
})

/* ---------- Bug A regression: butter swaps under DF (catalog spelling matches) ----------
 *
 * Under DF, `butter, unsalted` (catalog spelling, comma preserved) swaps to
 * `virgin coconut oil`. The dictionary's `from` uses the catalog spelling so
 * the runtime's `nameKey` match works (Bug A fix). This is the regression pair
 * for Bug A: the folded spelling `butter unsalted` must NOT appear as a `from`.
 */
const BUTTER_RECIPE = 'Lemon-Butter Chicken'
const BUTTER_SWAP = 'virgin coconut oil'

/* ---------- Bug B: DF drops (feta) ----------
 *
 * Under DF, `crumbled feta cheese` is DROPPED (no swap counterpart) in kept
 * recipes. The drop is display-only: the line is hidden from the grocery, the
 * key/checked state is untouched. See Bug B.
 */
const FETA_RECIPE = 'Arugula, Apricot'
const FETA_INGREDIENT = 'crumbled feta cheese'

async function activateDairyFree(page: Page) {
  await page.goto('/settings')
  await page.getByTestId('restriction-chip-dairy-free').click()
  await expect(page.getByTestId('restriction-chip-dairy-free')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
}

test('a DF butter recipe shows the substitute name (Bug A regression: catalog spelling matches)', async ({
  page,
}) => {
  await activateDairyFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, 'parsnip')
  await cardFor(page, /Lemon-Butter Chicken/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // The dictionary swap: `butter, unsalted` -> `virgin coconut oil`.
  await expect(sheet.getByText(BUTTER_SWAP).first()).toBeVisible()
  // The folded spelling must NOT appear as a display name (Bug A).
  await expect(sheet.getByText('butter unsalted')).toHaveCount(0)
})

test('under DF a feta recipe does not render the dropped line in the grocery (Bug B)', async ({
  page,
}) => {
  await activateDairyFree(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  await searchRecipes(page, 'arugula')
  await cardFor(page, /Arugula, Apricot/).first().click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await sheet.getByTestId('add-to-plan').click()
  await page.keyboard.press('Escape')

  await gotoTab(page, 'Grocery')
  // The feta line is a DF drop (no swap counterpart) — it is HIDDEN from
  // display only; the key stays base. No grocery row should name feta.
  await expect(
    page.getByTestId('grocery-row').filter({ hasText: FETA_INGREDIENT }).first(),
  ).toHaveCount(0)
})


/* ---------- Network shape: on-demand loading (ADR-0059) ----------
 *
 * The split tree loads ON DEMAND keyed by query-time need:
 *   * index.json         ~2 KB   always (or from lib RESTRICTIONS constant for cold start)
 *   * swaps.json         ~8 KB   when ANY chip is active
 *   * removed/<slug>.json ~4 KB  when THAT chip is active
 *   * pairs/<a>-<b>.json  ~1 KB  when THAT PAIR is active
 *
 * Use request interception to assert the exact files fired. index.json ships in
 * the bundle (cold start fires nothing beyond it); swaps/removed/pairs fire only
 * when their chip/pair activates. A failed per-slug/pair fetch degrades to
 * union-only + toast (ADR-0019's room-failure rule — never block the UI).
 */

async function interceptedRequests(page: Page) {
  const requests: string[] = []
  await page.route('**/data/restrictions/**', (route) => {
    const url = route.request().url()
    requests.push(url.replace(/^.*\/data\/restrictions\//, ''))
    return route.continue()
  })
  return requests
}

test('cold start fires no restriction requests (index ships in the bundle)', async ({ page }) => {
  const requests = await interceptedRequests(page)
  await page.goto('/recipes')
  await waitForCatalog(page)
  // No restriction files requested at all before any chip is activated.
  const restrictionRequests = requests.filter(
    (r) => r.startsWith('index.json') || r.startsWith('swaps.json') || r.startsWith('removed/') || r.startsWith('pairs/'),
  )
  expect(restrictionRequests).toEqual([])
})

test('activating ONE chip fires index + swaps + one removed file', async ({ page }) => {
  const requests = await interceptedRequests(page)
  await page.goto('/settings')
  await page.getByTestId('restriction-chip-gluten-free').click()
  await expect(page.getByTestId('restriction-chip-gluten-free')).toHaveAttribute('aria-pressed', 'true')
  const fired = requests.filter(
    (r) => r.startsWith('index.json') || r.startsWith('swaps.json') || r.startsWith('removed/') || r.startsWith('pairs/'),
  )
  // Exactly: swaps.json + removed/gluten-free.json
  // index.json is in the bundle (cold start) — not fetched at activation time.
  expect(fired).toContain('swaps.json')
  expect(fired).toContain('removed/gluten-free.json')
  expect(fired).not.toContain('pairs/')
})

test('activating a SECOND chip fires the pair file (and the first removed stays)', async ({ page }) => {
  const requests = await interceptedRequests(page)
  await page.goto('/settings')
  await page.getByTestId('restriction-chip-gluten-free').click()
  await page.getByTestId('restriction-chip-dairy-free').click()
  await expect(page.getByTestId('restriction-chip-dairy-free')).toHaveAttribute('aria-pressed', 'true')
  const fired = requests.filter(
    (r) => r.startsWith('index.json') || r.startsWith('swaps.json') || r.startsWith('removed/') || r.startsWith('pairs/'),
  )
  // Now pairs/gluten-free-dairy-free.json also fires (on-demand pair extras).
  expect(fired).toContain('swaps.json')
  expect(fired).toContain('removed/gluten-free.json')
  expect(fired).toContain('removed/dairy-free.json')
  expect(fired).toContain('pairs/dairy-free-gluten-free.json')
})

