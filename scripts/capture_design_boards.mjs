#!/usr/bin/env node
/**
 * Design-board capture (EXPERIENCE.md §7 / slice 7): BOTH themes across
 * ALL surfaces at desktop 1280 and Pixel 7 390.
 *
 * NOT a CI suite — invoked manually after `bun run build`:
 *
 *   bun run build
 *   node scripts/capture_design_boards.mjs [--out docs/design/boards]
 *
 * The script starts its own `vite preview` (the built bundle, same as the
 * e2e webServer), captures PNGs named
 * `<surface>-<desktop|mobile>-<light|dark>.png`, writes them to
 * docs/design/boards/ and prints a manifest table to stdout. It ABORTS
 * every request that is not localhost — the app is offline-first and the
 * boards must prove the offline render, not fetch a CDN (ADR-0029).
 *
 * Surfaces are captured in the app's REAL state: the Recipes grid comes
 * from the frozen catalog; Plan/Grocery/Shop/Cooking are reached by
 * actually planning a recipe (a card's Add to plan) — so the boards show
 * what a real household sees, never a mocked page. History and Settings
 * are captured as-is (the honest empty state included).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:4197'
const VIEWPORTS = [
  { tag: 'desktop', width: 1280, height: 800 },
  { tag: 'mobile', width: 390, height: 844 },
]

/** Abort anything that is not the local app (offline-first, ADR-0029). */
function blockExternal(page) {
  return page.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith('http://localhost')) return route.continue()
    return route.abort()
  })
}

async function openFirstRecipe(page) {
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
  await page.locator('[data-test="recipe-card-link"]').first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[data-test="start-cooking"]').waitFor({ timeout: 15_000 })
  return dialog
}

async function captureAll(page, tag, shots) {
  // Recipes grid (catalog loaded, cards visible).
  await page.goto(`${BASE}/`)
  await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT_DIR}/recipes-${tag}-light.png`, fullPage: false })

  // Plan a recipe so Plan / Grocery / Shop / Cooking show real state.
  await openFirstRecipe(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Add to plan' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Plan' }).click()
  await page.locator('[data-test="mark-cooked"]').first().waitFor({ timeout: 15_000 })
  await page.screenshot({ path: `${OUT_DIR}/plan-${tag}-light.png` })

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Grocery' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT_DIR}/grocery-${tag}-light.png` })

  await page.goto(`${BASE}/shop`)
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT_DIR}/shop-${tag}-light.png` })

  // Cooking: back to the detail, Start cooking, one step at 20px.
  await page.goBack()
  await openFirstRecipe(page)
  await page.getByRole('dialog').locator('[data-test="start-cooking"]').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT_DIR}/cooking-${tag}-light.png` })
  await page.getByRole('button', { name: 'Close cooking mode' }).click().catch(() => {})

  // History + Settings as they really are.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'History' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT_DIR}/history-${tag}-light.png` })

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT_DIR}/settings-${tag}-light.png`, fullPage: false })

  // ---- dark pass: one toggle click per viewport session ----
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.waitForTimeout(400)
  for (const name of shots) {
    if (name === 'recipes') {
      await page.goto(`${BASE}/`)
      await page.locator('[data-test="recipe-card-link"]').first().waitFor({ timeout: 30_000 })
    } else if (name === 'plan') {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Plan' }).click()
      await page.locator('[data-test="mark-cooked"]').first().waitFor({ timeout: 15_000 })
    } else if (name === 'grocery') {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Grocery' }).click()
      await page.waitForTimeout(800)
    } else if (name === 'shop') {
      await page.goto(`${BASE}/shop`)
      await page.waitForTimeout(800)
    } else if (name === 'cooking') {
      await openFirstRecipe(page)
      await page.getByRole('dialog').locator('[data-test="start-cooking"]').click()
      await page.waitForTimeout(800)
    } else if (name === 'history') {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'History' }).click()
      await page.waitForTimeout(600)
    } else if (name === 'settings') {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click()
      await page.waitForTimeout(600)
    }
    await page.screenshot({ path: `${OUT_DIR}/${name}-${tag}-dark.png`, fullPage: false })
    if (name === 'cooking') await page.getByRole('button', { name: 'Close cooking mode' }).click().catch(() => {})
  }
}

const SURFACES = ['recipes', 'plan', 'grocery', 'shop', 'cooking', 'history', 'settings']

// ---- start the preview server (the built bundle) ----
/** `--out <dir>` is documented in the header: honour it instead of silently
 *  overwriting the checked-in boards. */
/** `--out <dir>` AND `--out=<dir>` are both documented — accept both. */
const outArgIdx = process.argv.indexOf('--out')
const OUT_DIR =
  (outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined) ??
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ??
  'docs/design/boards'
mkdirSync(OUT_DIR, { recursive: true })
const preview = spawn('bun', ['run', 'preview', '--port', '4197', '--strictPort'], {
  stdio: 'inherit',
})
let previewKilled = false
function killPreview() {
  if (previewKilled) return
  previewKilled = true
  preview.kill('SIGTERM')
}
await new Promise((resolve, reject) => {
  const t = setTimeout(() => {
    clearInterval(probe)
    // The server is spawned, so a failed probe MUST still reap it — a leaked
    // `vite preview` holds `--strictPort` hostage for the next run.
    killPreview()
    reject(new Error('preview server did not start'))
  }, 30_000)
  const probe = setInterval(async () => {
    try {
      await fetch(BASE)
      clearTimeout(t)
      clearInterval(probe)
      resolve()
    } catch {
      /* keep probing */
    }
  }, 300)
})

try {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const manifest = []
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    await blockExternal(page)
    await captureAll(page, vp.tag, SURFACES)
    await ctx.close()
    for (const s of SURFACES) manifest.push(`${OUT_DIR}/${s}-${vp.tag}-light.png`, `${OUT_DIR}/${s}-${vp.tag}-dark.png`)
  }
  await browser.close()
  writeFileSync(`${OUT_DIR}/MANIFEST.generated.txt`, manifest.join('\n') + '\n')
  console.log(manifest.join('\n'))
} finally {
  killPreview()
}
