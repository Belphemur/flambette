import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_URL, recipeDescription } from '../src/lib/seo'
import type { VariantMeta } from '../src/lib/types'
import { blockExternalRequests, expectZeroMealimeRequests, gotoTab } from './helpers'

/**
 * ADR-0048 — the client-side head.
 *
 * The build-time prerenderer writes `dist/recipe/<id>/index.html`, but a
 * live browser navigates client-side, so the head it ends up with is
 * Unhead's. These are the two halves of one contract: the strings a
 * crawler reads out of the HTML and the strings the running app writes
 * into `document.head` must be the SAME, derived from the same
 * `src/lib/seo.ts` builders.
 *
 * Expectations come from the frozen catalog on disk (never a hand-typed
 * copy of a title), so the spec cannot drift from the data.
 */
const VARIANT_ID = 10003

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const META = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/data/builder_data.json'), 'utf8')) as {
    variant_meta: VariantMeta[]
  }
).variant_meta.find((m) => m.id === VARIANT_ID)!

function metaContent(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).first().getAttribute('content')
}

/** Like {@link metaContent} but resolves to null when the tag is ABSENT —
 *  `getAttribute` waits for a match, which is the wrong tool for asserting
 *  that Unhead REMOVED an entry when the component unmounted. */
async function absentMetaContent(page: Page, selector: string): Promise<string | null> {
  if ((await page.locator(selector).count()) === 0) return null
  return metaContent(page, selector)
}

function ldJson(page: Page): Promise<Array<Record<string, unknown>>> {
  return page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((nodes) => nodes.map((n) => JSON.parse(n.textContent ?? '{}')))
}

async function openRecipe(page: Page): Promise<void> {
  await page.goto(`/recipe/${VARIANT_ID}`)
  await expect(page.getByRole('heading', { name: META.name })).toBeVisible({ timeout: 15_000 })
  // The doc fetch is async; wait for the JSON-LD to carry ingredients,
  // i.e. the head has upgraded from its meta-only form.
  await expect
    .poll(async () => (await ldJson(page))[0]?.recipeIngredient !== undefined, { timeout: 15_000 })
    .toBe(true)
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test.afterEach(async ({ page }) => {
  await expectZeroMealimeRequests(page)
})

test('a recipe page describes itself with the catalog name and facts', async ({ page }) => {
  await openRecipe(page)

  // Title: the recipe's own name, verbatim — no site suffix, no stuffing.
  await expect(page).toHaveTitle(META.name)

  // Description: the one factual sentence from src/lib/seo.ts.
  expect(await metaContent(page, 'meta[name="description"]')).toBe(recipeDescription(META))

  // Canonical + robots: the recipe is the indexable surface.
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${SITE_URL}/recipe/${VARIANT_ID}/`,
  )
  expect(await metaContent(page, 'meta[name="robots"]')).toBe('index, follow')
})

test('exactly one schema.org Recipe object, carrying the catalog truth', async ({ page }) => {
  await openRecipe(page)

  const nodes = await ldJson(page)
  expect(nodes).toHaveLength(1)
  const ld = nodes[0]
  expect(ld['@type']).toBe('Recipe')
  expect(ld.name).toBe(META.name)
  expect(ld.url).toBe(`${SITE_URL}/recipe/${VARIANT_ID}/`)
  expect(ld['@id']).toBe(ld.url)
  // Ingredients and steps are real arrays from the doc, never placeholders.
  expect(Array.isArray(ld.recipeIngredient)).toBe(true)
  expect((ld.recipeIngredient as string[]).length).toBeGreaterThan(0)
  expect(Array.isArray(ld.recipeInstructions)).toBe(true)

  // No key the catalog does not publish (ADR-0048 anti-spam contract).
  for (const unpublished of ['prepTime', 'cuisine', 'author', 'review']) {
    expect(ld).not.toHaveProperty(unpublished)
  }
})

test('leaving the recipe restores the app-shell default head', async ({ page }) => {
  await openRecipe(page)
  await gotoTab(page, 'Plan')

  // Unhead drops RecipeDetail's scoped entries on unmount, so the app-level
  // default (App.vue) resurfaces — this is the assertion the design leans on.
  await expect(page).toHaveTitle('Flambette')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${SITE_URL}/`)
  // The recipe's own tags are gone, not merely overridden.
  expect(await absentMetaContent(page, 'meta[name="robots"]')).toBeNull()
  expect(await absentMetaContent(page, 'meta[property="og:type"]')).toBe('website')
  expect(await ldJson(page)).toEqual([])
})

test('a second recipe page carries its own head, never the previous one', async ({ page }) => {
  await openRecipe(page)
  const firstLd = (await ldJson(page))[0]

  // A different recipe, deep-linked so the spec never depends on where the
  // paginated grid happens to rank it.
  const OTHER_ID = 26886
  await page.goto(`/recipe/${OTHER_ID}`)
  await expect
    .poll(async () => (await ldJson(page))[0]?.url, { timeout: 15_000 })
    .toBe(`${SITE_URL}/recipe/${OTHER_ID}/`)

  expect((await ldJson(page))[0].name).not.toBe(firstLd.name)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${SITE_URL}/recipe/${OTHER_ID}/`,
  )
})

test('hydrating the PRERENDERED page adds no second copy of anything', async ({ page }) => {
  // The trailing-slash URL is the form both production surfaces serve from
  // `dist/recipe/<id>/index.html`, so this is the page a crawler lands on
  // and then a browser hydrates. Unhead adopts the static meta/link tags but
  // an inline JSON-LD script has no identity to dedupe on unless both
  // consumers give it one (`id: recipe-jsonld`) — without it the page ends
  // up with TWO identical Recipe objects, which a rich-result validator
  // reads as a duplicate.
  await page.goto(`/recipe/${VARIANT_ID}/`)
  await expect(page.getByRole('heading', { name: META.name })).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => (await ldJson(page))[0]?.recipeIngredient !== undefined, { timeout: 15_000 })
    .toBe(true)

  expect(await ldJson(page)).toHaveLength(1)
  await expect(page.locator('meta[name="description"]')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${SITE_URL}/recipe/${VARIANT_ID}/`,
  )
  await expect(page).toHaveTitle(META.name)
})