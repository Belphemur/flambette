/**
 * PR screenshot capture — visual QA on a real build.
 *
 * WHY: CI proves a PR does not BREAK; it does not show a human what the
 * change looks like. This walks the main routes at the two viewports the
 * app is actually designed for (Desktop Chrome + Pixel 7 — the five-tab bar
 * fit was measured at Pixel 7, ADR-0016) and writes PNGs plus a tiny
 * Markdown index, so a reviewer can eyeball a UI PR from the Actions tab
 * without running anything.
 *
 * It is deliberately NOT a test: no assertion, no exit code. A visual
 * regression that matters is pinned by a real e2e case; this is the
 * human-eye layer on top.
 *
 *   bun run screenshots            # dist/ must exist (bun run build)
 *   BASE_URL=http://localhost:5173 bun run screenshots
 */
import { chromium, devices } from 'playwright'
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.SHOT_DIR ?? 'screenshots'

/** Routes worth showing. Recipe/cooking need ids, so they are covered by
 *  the e2e suite (which drives real state) rather than by a static walk. */
const ROUTES = [
  { path: '/', name: 'recipes', waitFor: 'catalog' },
  { path: '/plan', name: 'plan' },
  { path: '/grocery', name: 'grocery' },
  { path: '/history', name: 'history' },
  { path: '/settings', name: 'settings' },
]

/** Both are the project's real e2e projects — keep in step with
 *  playwright.config.ts so a screenshot never lies about the layout. */
const VIEWPORTS = [
  { name: 'desktop', use: devices['Desktop Chrome'] },
  { name: 'pixel7', use: devices['Pixel 7'] },
]

async function main() {
  if (!existsSync('dist/index.html')) {
    console.error('dist/ not found — run `bun run build` first')
    process.exit(1)
  }
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const browser = await chromium.launch()
  const rows = []
  let failures = 0

  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      // A fresh context per shot: no leaked state, and a mobile context
      // gets a real touch-enabled, device-scaled viewport.
      const ctx = await browser.newContext(vp.use)
      const page = await ctx.newPage()
      const label = `${vp.name}-${route.name}`
      try {
        await page.goto(`${BASE_URL}${route.path}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        })
        if (route.waitFor === 'catalog') {
          // The catalog is baked into the repo; wait for the grid, not the
          // network, so a slow image decode does not produce a blank shot.
          await page.waitForSelector('[data-test="recipe-card"]', { timeout: 20_000 })
        }
        await page.waitForTimeout(400) // let fonts/images settle
        await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true })
        rows.push({ label, path: `${label}.png`, route: route.path, viewport: vp.name })
        console.log(`captured ${label}`)
      } catch (err) {
        // A failed capture is reported but never fails the workflow: this
        // job is QA sugar, and a flaky route must not block a PR.
        failures++
        console.warn(`WARN could not capture ${label}: ${err?.message ?? err}`)
        try {
          await page.screenshot({ path: path.join(OUT, `${label}-FAILED.png`) })
        } catch {
          /* page is gone; nothing more to do */
        }
      } finally {
        await ctx.close()
      }
    }
  }
  await browser.close()

  const shots = rows
    .map((r) => `| ${r.viewport} | \`${r.route}\` | ![${r.label}](${r.path}) |`)
    .join('\n')
  const body = [
    '# PR screenshots',
    '',
    `Base: \`${BASE_URL}\` — ${rows.length} captured, ${failures} failed.`,
    '',
    '| Viewport | Route | |',
    '| --- | --- | --- |',
    shots || '| — | — | _no screenshots captured_ |',
    '',
  ].join('\n')
  await writeFile(path.join(OUT, 'index.md'), body, 'utf8')

  const files = await readdir(OUT)
  console.log(`\n${rows.length} screenshots in ${OUT}/ (${files.length} files incl. index.md)`)
  if (rows.length === 0) {
    console.error('no screenshots captured at all')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
