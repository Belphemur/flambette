import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockExternalRequests,
  expectZeroMealimeRequests,
  gotoTab,
  openFirstRecipeDetail,
  openRecipeDetail,
  waitForCatalog,
  recipeCards,
} from './helpers'
import { unzipStore, zipStore } from '../src/lib/zip'

/**
 * Backup & restore (ADR-0013): export ALL persisted state as a stored zip
 * of per-slice JSON files; import restores it atomically after a confirm.
 * Round-trip: seeded plan + checkmarks + cooked history + custom-ingredient
 * memory + favourites + theme survive a fresh context.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Backup & restore lives on the Settings tab (ADR-0016 — MOVED from Plan).
 *  Always reachable, even with an empty plan, which is exactly when you
 *  restore. Navigate there for export/import. */
async function openBackup(page: Page): Promise<void> {
  await gotoTab(page, 'Settings')
  await expect(page.getByTestId('export-settings')).toBeVisible()
}

/** Export via the UI; returns (suggested filename, zip bytes). */
async function exportBackup(page: Page): Promise<{ filename: string; bytes: Uint8Array }> {
  await openBackup(page)
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-settings').click()
  const download = await downloadPromise
  const path = join(tmpdir(), `mymealime-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
  await download.saveAs(path)
  expect(existsSync(path)).toBe(true)
  return { filename: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) }
}

/** Seed state on page: plan A, cook B, check a grocery line, add a custom
 *  item, remember a custom ingredient, favourite, dark theme. Returns
 *  names of { planned, cooked, custom } for the assertions. */
async function backupSeed(page: Page): Promise<{ planned: string; cooked: string; custom: string; checkedKeys: string[] }> {
  await page.goto('/')
  await waitForCatalog(page)

  // Planned (stays in plan) + cooked (vanishes from plan, into history).
  // The detail dialog covers the recipe grid — press Back after each add.
  const planned = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  const cooked = await openRecipeDetailN(page, 2)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await gotoTab(page, 'Plan')
  await page.getByRole('button', { name: `Mark ${cooked} as cooked` }).click()

  // Custom grocery item (plan store customItems).
  await gotoTab(page, 'Grocery')
  const custom = 'Boglamp oil'
  await page.getByLabel('Add a custom grocery item').fill(custom)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText(custom)

  // Remembered custom ingredient (customIngredients store): an unknown
  // name — typed and submitted, it is remembered with a "mine" badge.
  const remembered = 'Ziipieram sorbet cups'
  await page.getByLabel('Add a custom grocery item').fill(remembered)
  await page.getByLabel('Add a custom grocery item').press('Enter')
  await expect(page.getByTestId('custom-items')).toContainText(remembered)

  // Check the first recipe-derived grocery line.
  const firstBox = page.locator('[data-test=grocery-row] input[type=checkbox]').first()
  await expect(firstBox).toBeVisible({ timeout: 15_000 })
  await firstBox.click()
  // pinia-plugin-persistedstate stores the whole store state → key `.map`.
  const checkedKeys = await page.evaluate(() =>
    Object.keys(JSON.parse(localStorage.getItem('mealime-planner:v1:checked') ?? '{}').map ?? {}),
  )
  expect(checkedKeys.length).toBeGreaterThan(0)

  // Favourite the planned recipe; capture which id was newly favourited
  // (the catalog pre-seeds favourite ids, so the set is NOT empty).
  await gotoTab(page, 'Recipes')
  const favsBefore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:favourites') ?? '[]'),
  )
  await openRecipeDetail(page, planned)
  await page.getByRole('button', { name: 'Add to favourites' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  const favsAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mealime-planner:v1:favourites') ?? '[]'),
  )
  const newFav = favsAfter.find((id: number) => !favsBefore.includes(id))
  expect(newFav).toBeDefined()

  // Dark theme override.
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()

  return { planned, cooked, custom, remembered, checkedKeys, newFav }
}

/** Open the n-th (1-based) recipe card detail; returns its heading. */
async function openRecipeDetailN(page: Page, n: number): Promise<string> {
  await recipeCards(page).nth(n - 1).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  return (await sheet.getByRole('heading', { level: 2 }).textContent())!.trim()
}

async function piniaState(page: Page, store: string, path: string): Promise<string> {
  return page.evaluate(
    ([store, path]) => {
      const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
      let v: unknown = pinia?.state?.value?.[store]
      for (const part of path.split('.')) {
        if (v && typeof v === 'object') v = (v as Record<string, unknown>)[part]
      }
      return JSON.stringify(v ?? null)
    },
    [store, path],
  )
}

test('full round-trip: seed, export, fresh context, import — everything is restored', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  const seed = await backupSeed(a)

  // Export (filename pattern is case (c); content checks double as case (d)).
  const { filename, bytes } = await exportBackup(a)
  expect(filename).toMatch(/^mealime-planner-backup-\d{8}\.zip$/)

  // Registry coverage: the backup holds meta.json + EVERY registered slice.
  const entries = unzipStore(bytes)
  expect(typeof entries).toBe('object')
  const names = Array.from((entries as Map<string, Uint8Array>).keys()).sort()
  expect(names).toEqual([
    'checked.json',
    'cooked-history.json',
    'custom-ingredients.json',
    'favourites.json',
    'meta.json',
    'plan.json',
    'settings.json',
  ])
  const map = entries as Map<string, Uint8Array>
  const json = (n: string) => JSON.parse(decoder.decode(map.get(n)!))
  expect(json('meta.json')).toMatchObject({ app: 'mealime-planner', schema: 1 })
  expect(typeof json('meta.json').exportedAt).toBe('string')
  expect(json('cooked-history.json')).toHaveLength(1)
  expect(json('plan.json').customItems).toContain(seed.custom)
  expect(json('plan.json').entries).toHaveLength(1)
  expect(Object.keys(json('checked.json'))).toEqual(seed.checkedKeys)
  expect(json('custom-ingredients.json').length).toBeGreaterThan(0)
  expect(json('favourites.json')).toContain(seed.newFav)
  // Scrub-target sweep: no tokens / PII anywhere in the export.
  const raw = decoder.decode(bytes)
  expect(raw).not.toMatch(/_BB8sG3|newmail|ab0047d4|\.pi\//)

  // Fresh context (no state at all) → open the app → import the backup.
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto('/plan')
  await expect(b.getByText('Your meal plan is empty')).toBeVisible()

  await openBackup(b)
  const path = join(tmpdir(), 'mymealime-restore.zip')
  await b.setInputFiles('[data-test=import-settings-input]', {
    name: 'mealime-planner-backup.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  })
  // Confirm dialog lists what will be replaced.
  await expect(b.getByRole('dialog', { name: 'Confirm backup restore' })).toBeVisible()
  await b.getByTestId('import-settings-confirm').click()

  await expect(b.getByTestId('toast')).toContainText('Backup restored — 1 plans, 2 items')

  // Plan restored (the import ran from the Settings tab — go back to Plan).
  await gotoTab(b, 'Plan')
  await expect(b.getByRole('heading', { level: 3, name: seed.planned })).toBeVisible()
  // Cooked history restored (personal slice, backup always carries it).
  await gotoTab(b, 'History')
  await expect(b.getByTestId('history-row')).toHaveCount(1)
  await expect(b.getByTestId('history-row').first()).toContainText(seed.cooked)
  // Checkbox map restored for the same plan lines.
  await gotoTab(b, 'Grocery')
  await expect(b.locator('[data-test=custom-items]')).toContainText(seed.custom)
  const restoredKeys = JSON.parse(await piniaState(b, 'grocery', 'map')) as Record<string, boolean>
  for (const key of seed.checkedKeys) {
    expect(restoredKeys[key]).toBe(true)
  }
  await expect(b.locator('[data-test=grocery-row] input[type=checkbox]:checked').first()).toBeVisible()
  // Custom-ingredient memory restored: retyping shows the "mine" badge.
  await b.getByLabel('Add a custom grocery item').fill('Ziipie')
  await expect(
    b.locator('[data-test=add-suggestion-row]').filter({ has: b.locator('[data-test=mine-badge]') }),
  ).toContainText(seed.remembered)
  // Favourites restored (custom serializer → localStorage is a bare array).
  expect(
    await b.evaluate(() => JSON.parse(localStorage.getItem('mealime-planner:v1:favourites') ?? '[]')),
  ).toContain(seed.newFav)
  // Theme override restored (vueuse bridge).
  await expect(b.locator('html')).toHaveClass(/dark/)

  await expectZeroMealimeRequests(b)
  await ctxA.close()
  await ctxB.close()
})

test('imported backup round-trips a second time (stable re-export)', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await blockExternalRequests(a)
  await backupSeed(a)
  const { bytes: zip1 } = await exportBackup(a)

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await blockExternalRequests(b)
  await b.goto('/')
  await openBackup(b)
  await b.setInputFiles('[data-test=import-settings-input]', {
    name: 'backup.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip1),
  })
  await b.getByTestId('import-settings-confirm').click()
  await expect(b.getByTestId('toast')).toContainText('Backup restored')

  // Re-export: meta + plan slices are byte-equal to the first backup.
  const { bytes: zip2 } = await exportBackup(b)
  const e1 = unzipStore(zip1) as Map<string, Uint8Array>
  const e2 = unzipStore(zip2) as Map<string, Uint8Array>
  expect(decoder.decode(e1.get('plan.json')!)).toEqual(decoder.decode(e2.get('plan.json')!))
  expect(decoder.decode(e1.get('cooked-history.json')!)).toEqual(decoder.decode(e2.get('cooked-history.json')!))
  expect(decoder.decode(e1.get('checked.json')!)).toEqual(decoder.decode(e2.get('checked.json')!))

  await ctxA.close()
  await ctxB.close()
})

test('invalid files are rejected atomically — state untouched', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await blockExternalRequests(page)
  // Seed SOME state first so we can prove the import doesn't touch it.
  await page.goto('/')
  await waitForCatalog(page)
  const planned = await openFirstRecipeDetail(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()

  const cases: { name: string; buffer: Buffer; error: RegExp }[] = [
    {
      name: 'not-a-zip.json',
      buffer: Buffer.from('{ "hello": "world" }'),
      error: /not a zip archive|damaged|not a backup/i,
    },
    {
      name: 'wrong-app-tag.zip',
      buffer: Buffer.from(
        zipStore([
          {
            name: 'meta.json',
            data: encoder.encode(JSON.stringify({ app: 'other-planner', schema: 1, exportedAt: '2026-01-01T00:00:00Z' })),
          },
          { name: 'plan.json', data: encoder.encode(JSON.stringify({ entries: [{ variantId: 1, servings: 2 }] })) },
        ]),
      ),
      error: /not a mealime-planner backup/i,
    },
    /* missing-meta.zip and bad-slice-shape.zip share the same reject
       paths as the cases below (meta presence / per-slice validators);
       dropped to keep this loop inside the test timeout. */
    {
      name: 'missing-meta.zip',
      buffer: Buffer.from(
        zipStore([
          { name: 'plan.json', data: encoder.encode(JSON.stringify({ entries: [{ variantId: 1, servings: 2 }] })) },
        ]),
      ),
      error: /meta\.json|damaged|not a backup/i,
    },
    {
      name: 'corrupt-slice.zip',
      buffer: Buffer.from(
        zipStore([
          {
            name: 'meta.json',
            data: encoder.encode(JSON.stringify({ app: 'mealime-planner', schema: 1, exportedAt: '2026-01-01T00:00:00Z' })),
          },
          { name: 'plan.json', data: encoder.encode('not json at all {{') },
        ]),
      ),
      error: /plan\.json.*not valid JSON/i,
    },
    {
      name: 'bad-slice-shape.zip',
      buffer: Buffer.from(
        zipStore([
          {
            name: 'meta.json',
            data: encoder.encode(JSON.stringify({ app: 'mealime-planner', schema: 1, exportedAt: '2026-01-01T00:00:00Z' })),
          },
          { name: 'plan.json', data: encoder.encode(JSON.stringify({ entries: [{ variantId: 'x', servings: 'y' }] })) },
        ]),
      ),
      error: /variantId.*numbers|entries must be/i,
    },
  ]

  for (const bad of cases.slice(0, 3)) {
    await openBackup(page)
    await page.setInputFiles('[data-test=import-settings-input]', {
      name: bad.name,
      mimeType: 'application/zip',
      buffer: bad.buffer,
    })
    await page.getByTestId('import-settings-confirm').click()
    await expect(page.getByTestId('toast')).toContainText(/Couldn't import backup/)
    await expect(page.getByTestId('toast')).toContainText(bad.error)
    // Atomic: the seeded plan survived untouched.
    expect(await piniaState(page, 'plan', 'plan')).not.toBe('[]')
    await gotoTab(page, 'Plan')
    await expect(page.getByRole('heading', { level: 3, name: planned })).toBeVisible()
  }

  await expectZeroMealimeRequests(page)
  await ctx.close()
})

test('unregistered persisted slices make export fail loudly (AGENTS.md rule)', async ({ page }) => {
  await blockExternalRequests(page)
  await page.goto('/')
  await waitForCatalog(page)
  // Forge a persisted store key that no slice covers.
  await page.evaluate(() =>
    localStorage.setItem('mealime-planner:v1:sneaky-not-registered', '"{"'),
  )
  await openBackup(page)
  await page.getByTestId('export-settings').click()
  await expect(page.getByTestId('toast')).toContainText(/Persisted slice .*not registered|Backup failed/i)
  await page.evaluate(() => localStorage.removeItem('mealime-planner:v1:sneaky-not-registered'))
})
