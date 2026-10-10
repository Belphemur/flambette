/**
 * Build-time SEO prerenderer (ADR-0048). Run AFTER `vite build` — it is the
 * third step of `bun run build`, so dev, e2e, CI and Docker all ship the
 * same head.
 *
 * Walks the FROZEN catalog (public/data/builder_data.json) and, for every
 * feasible recipe with a doc file, writes a static
 * `dist/recipe/<id>/index.html` whose <head> is the recipe's full SEO
 * surface — title, description, Open Graph / Twitter tags, the canonical
 * URL and the JSON-LD `Recipe` object, all derived by the SAME pure
 * helpers the client uses (`src/lib/seo.ts`, `src/lib/seoRender.ts`). A
 * crawler without a JS engine therefore reads the complete, truthful head
 * without waiting for hydration; a browser hydrates the same page and
 * Unhead reproduces the identical head client-side.
 *
 * Also writes:
 *   - `dist/index.html`    — the app-shell head (self-canonical), because
 *                            every app-shell route is served this file.
 *                            ADR-0078: that head describes the HERO (the
 *                            homepage IS the hero page now).
 *   - `dist/recipes/index.html` — the recipes-list head (ADR-0078 Decision
 *                            9): `/recipes` is its own indexable surface,
 *                            canonical `<siteUrl>/recipes/`, and the
 *                            sitemap entry ships in the same commit — a
 *                            sitemap entry must never contradict the
 *                            canonical it points at.
 *   - `dist/sitemap.xml`   — the homepage, /recipes/ and every recipe URL
 *                            (absolute, using SITE_URL; lastmod is the
 *                            catalog's own first_published_at).
 *   - `dist/robots.txt`    — allow-all + the sitemap pointer.
 *
 * The body is NOT prerendered: `<div id="app">` stays the single render
 * root (hydration must never fight a stale DOM), and a `<noscript>` block
 * carries the recipe's name/description/ingredients for crawlers that never
 * execute JS. Duplicating RecipeDetail's rendering in a string builder
 * would be a second rendering path guaranteed to drift.
 *
 * Deterministic: the same catalog + index.html produce byte-identical
 * output, so the step is safely repeatable in CI and dev alike.
 *
 * ALL serialization lives in `src/lib/seoRender.ts` (pure, unit-tested
 * under `bun run test:unit`); this file is the I/O shell.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SITE_URL,
  homeSeoHead,
  recipeSeoHead,
  recipeUrl,
  recipesSeoHead,
  recipesUrl,
} from '../src/lib/seo'
import {
  injectHead,
  renderHeadBlock,
  renderNoscript,
  resetPrerenderHead,
  robotsTxt,
  sitemapXml,
  w3cDate,
  type SitemapUrl,
} from '../src/lib/seoRender'
import type { RecipeDoc, VariantMeta } from '../src/lib/types'

const ROOT = process.cwd()
const DIST = resolve(ROOT, 'dist')
const DATA = resolve(ROOT, 'public', 'data')

// SITE_URL is overridable at build time (a self-hosted instance can point
// its canonicals wherever it hosts); the default is the hosted origin.
const siteUrl = (process.env.SITE_URL || SITE_URL).replace(/\/+$/, '')

interface BuilderData {
  feasible_variants: number[]
  variant_meta: VariantMeta[]
}

function main(): number {
  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `vite build` first')
    return 1
  }
  const builder = JSON.parse(
    readFileSync(join(DATA, 'builder_data.json'), 'utf8'),
  ) as BuilderData
  // ADR-0054: the household's own recipes are served by /recipe/:id like any
  // other variant (they are merged into byId at load), so they are
  // prerendered too — from the doc embedded in user_recipes.json, not from
  // the frozen recipes/ directory.
  const userRecipesPath = join(DATA, 'user_recipes.json')
  const userRecipes: { meta: VariantMeta; doc: RecipeDoc }[] = existsSync(userRecipesPath)
    ? ((JSON.parse(readFileSync(userRecipesPath, 'utf8')).recipes ?? []) as never)
    : []
  const userDocById = new Map<number, RecipeDoc>(
    userRecipes.map((r) => [r.meta.id, r.doc]),
  )
  // Read once, then RESET: this script rewrites dist/index.html in place,
  // so on a second run the file on disk already carries a prerendered
  // head. Feeding that back in would stack a second head on the first.
  const baseHtml = resetPrerenderHead(readFileSync(join(DIST, 'index.html'), 'utf8'))

  const metaById = new Map<number, VariantMeta>([
    ...builder.variant_meta.map((m) => [m.id, m] as const),
    ...userRecipes.map((r) => [r.meta.id, r.meta] as const),
  ])
  // The prerendered pages must exist ONLY for recipes the catalog serves,
  // and `/recipe/:id` is open to any catalog id (router comment) — which is
  // exactly `feasible_variants`, the same gate the planner and the filter
  // tables use. A variant without a doc file is skipped loudly.
  const ids = [...builder.feasible_variants, ...userDocById.keys()]
    .filter((id) => metaById.has(id))
    .sort((a, b) => a - b)

  const recipeDir = join(DIST, 'recipe')
  // Deterministic re-runs: the previous prerender's stale ids must not
  // survive a catalog sync that dropped recipes (the idempotent-delete
  // habit shared with extract_timer_hints.py).
  rmSync(recipeDir, { recursive: true, force: true })
  mkdirSync(recipeDir, { recursive: true })

  const docMissing: number[] = []
  // ADR-0078 Decision 9: /recipes is a REAL sitemap URL, second only to
  // the homepage — and its canonical (recipesSeoHead) names the SAME
  // slash form, so the entry never contradicts the page it points at.
  const sitemap: SitemapUrl[] = [{ loc: `${siteUrl}/` }, { loc: recipesUrl(siteUrl) }]
  for (const id of ids) {
    const meta = metaById.get(id)!
    let doc: RecipeDoc | undefined = userDocById.get(id)
    if (!doc) {
      const docPath = join(DATA, 'recipes', `${id}.json`)
      if (!existsSync(docPath)) {
        docMissing.push(id)
        continue
      }
      doc = JSON.parse(readFileSync(docPath, 'utf8')) as RecipeDoc
    }
    const head = recipeSeoHead(doc, meta, siteUrl)

    const html = injectHead(baseHtml, renderHeadBlock(head)).replace(
      '<div id="app"></div>',
      `<div id="app"></div>\n${renderNoscript(meta, doc, siteUrl)}`,
    )

    const outDir = join(recipeDir, String(id))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'index.html'), html)

    // lastmod is the catalog's own publication date — no invented
    // freshness, and no priority/changefreq (Google ignores both).
    sitemap.push({ loc: recipeUrl(id, siteUrl), lastmod: w3cDate(meta.first_published_at) })
  }

  // App-shell head (the SAME builder App.vue installs as its default):
  // self-canonical, because the SPA fallback serves this file for /plan,
  // /grocery, … too and the canonical is what dedupes them.
  writeFileSync(join(DIST, 'index.html'), injectHead(baseHtml, renderHeadBlock(homeSeoHead(siteUrl))))
  // The recipes-list surface gets its OWN prerendered page (ADR-0078
  // Decision 9): nginx's try_files $uri/ serves dist/recipes/index.html
  // before the SPA fallback, and Cloudflare static assets do the same
  // for the trailing-slash form.
  const recipesDir = join(DIST, 'recipes')
  mkdirSync(recipesDir, { recursive: true })
  writeFileSync(
    join(recipesDir, 'index.html'),
    injectHead(baseHtml, renderHeadBlock(recipesSeoHead(siteUrl))),
  )
  writeFileSync(join(DIST, 'sitemap.xml'), sitemapXml(sitemap))
  writeFileSync(join(DIST, 'robots.txt'), robotsTxt(siteUrl))

  const indexed = ids.length - docMissing.length
  console.log(`prerendered ${indexed} recipe pages into dist/recipe/<id>/index.html`)
  if (docMissing.length) {
    console.warn(`WARNING: ${docMissing.length} feasible variants have no doc file (skipped):`)
    console.warn(`  ${docMissing.slice(0, 10).join(', ')}${docMissing.length > 10 ? ' …' : ''}`)
  }
  console.log(`wrote dist/recipes/index.html, dist/sitemap.xml (${sitemap.length} urls) and dist/robots.txt`)
  return 0
}

process.exit(main())