/**
 * HTML/SERIALIZATION layer of the SEO prerenderer (ADR-0048).
 *
 * `src/lib/seo.ts` decides WHAT a page says; this module decides how those
 * payloads become bytes in `dist/recipe/<id>/index.html`, `dist/sitemap.xml`
 * and `dist/robots.txt`. Both halves are PURE and live under `src/lib` so
 * `bun run test:unit` covers them (scripts/ is outside the type-check and
 * test globs); `scripts/generate-recipe-seo.ts` is the thin I/O main that
 * walks the catalog and calls these.
 *
 * Nothing here is imported by the app at runtime — the client renders its
 * head through Unhead, which serializes the very same `SeoHeadInput`.
 */

import {
  recipeDescription,
  recipeImages,
  recipeUrl,
  type SeoHeadInput,
  type SeoLinkTag,
  type SeoMetaTag,
} from './seo'
import type { RecipeDoc, VariantMeta } from './types'

/** Generated-file marker: these files are build output, never hand-edited. */
export const PRERENDER_MARKER =
  '<!-- Prerendered by scripts/generate-recipe-seo.ts — do not edit. See ADR-0048. -->'

/**
 * Escape a text node / attribute value. `&` first — the other three
 * replacements would otherwise double-escape their own ampersands.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `<meta name|property=… content=…>`, attributes in insertion order. */
export function metaTag(m: SeoMetaTag): string {
  const attrs = Object.entries(m)
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(' ')
  return `<meta ${attrs}>`
}

/** `<link rel=… href=…>`. */
export function linkTag(l: SeoLinkTag): string {
  const attrs = Object.entries(l)
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(' ')
  return `<link ${attrs}>`
}

/**
 * Serialize a JSON-LD script body.
 *
 * `JSON.stringify` first, then the two characters that could END the
 * script element (`<`, and `&` so an entity-ish sequence cannot be
 * reinterpreted) as `\uXXXX` escapes. Those are ordinary JSON string
 * escapes: `JSON.parse` returns the identical text, so the structured data
 * parses identically to Unhead's `textContent` (which goes through the DOM
 * and needs no escaping at all).
 */
export function jsonLdText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

/** The head block injected into the built `index.html`, one tag per line. */
export function renderHeadBlock(head: SeoHeadInput): string {
  return [
    PRERENDER_MARKER,
    `<title>${xmlEscape(head.title)}</title>`,
    ...head.meta.map(metaTag),
    ...head.link.map(linkTag),
    ...head.script.map(
      // The `id` is emitted too: it is the dedupe identity Unhead needs to
      // ADOPT this script instead of appending a second ld+json when the
      // page hydrates (see SeoJsonLdScript).
      (s) => `<script id="${xmlEscape(s.id)}" type="${s.type}">${jsonLdText(s.textContent)}</script>`,
    ),
  ].join('\n    ')
}

/**
 * Inject a head block into the built `index.html`.
 *
 * The base file's static `<title>` is REPLACED, not appended after — two
 * title elements in one head is exactly the ambiguity this feature exists
 * to remove. The surrounding whitespace is normalized (the block always
 * lands in the same indented slot) so the result is byte-stable.
 */
export function injectHead(base: string, extra: string): string {
  const withoutTitle = base.replace(/<title>[\s\S]*?<\/title>/, '')
  const close = withoutTitle.indexOf('</head>')
  if (close === -1) throw new Error('dist/index.html has no </head>')
  return (
    withoutTitle.slice(0, close).replace(/\s+$/, '') +
    `\n    ${extra}\n  ` +
    withoutTitle.slice(close)
  )
}

/**
 * Strip a PREVIOUS run's injected block from the built `index.html`.
 *
 * The prerenderer rewrites `dist/index.html` in place, so without this the
 * SECOND run would read its own output as the "base" and stack a second
 * head on top of the first — re-running a build is not an exotic case
 * (`bun run build` twice in a row is the normal dev loop), and a build step
 * whose output feeds itself is how duplicate-title bugs ship. Idempotency
 * is enforced by the caller resetting the base once, immediately after
 * reading it, and is pinned by `injectHead`/`resetPrerenderHead` tests.
 */
export function resetPrerenderHead(base: string): string {
  const start = base.indexOf(PRERENDER_MARKER)
  if (start === -1) return base
  const close = base.indexOf('</head>', start)
  if (close === -1) return base
  return base.slice(0, start).replace(/\s+$/, '') + '\n  ' + base.slice(close)
}

/**
 * The `<noscript>` body block: the recipe's own factual content for a
 * crawler that never executes JS. Deliberately PLAIN (an h1, the
 * description, the hero image, the authored ingredient list and steps, one
 * link) — never a second copy of RecipeDetail's markup, which would be a
 * rendering path guaranteed to drift (ADR-0048).
 */
export function renderNoscript(
  meta: VariantMeta,
  doc: RecipeDoc | null,
  siteUrl: string,
): string {
  const description = recipeDescription(meta)
  const imageUrl = recipeImages(meta, siteUrl)[0] ?? null
  const canonical = recipeUrl(meta.id, siteUrl)
  const lines = [
    '<noscript>',
    `  <h1>${xmlEscape(meta.name)}</h1>`,
    `  <p>${xmlEscape(description)}</p>`,
    ...(imageUrl ? [`  <img src="${xmlEscape(imageUrl)}" alt="${xmlEscape(meta.name)}">`] : []),
    '  <h2>Ingredients</h2>',
    '  <ul>',
    ...(doc?.line_items ?? []).map(
      (li) =>
        `    <li>${xmlEscape(li.quantity ? `${li.quantity} ` : '')}${xmlEscape(li.ingredient_name)}</li>`,
    ),
    '  </ul>',
    '  <h2>Instructions</h2>',
    '  <ol>',
    ...(doc?.instructions ?? []).map((s) => `    <li>${xmlEscape(s.primary_message)}</li>`),
    '  </ol>',
    `  <p><a href="${xmlEscape(canonical)}">Open this recipe in Flambette</a></p>`,
    '</noscript>',
  ]
  return lines.join('\n')
}

/** One sitemap entry. `lastmod` is optional (the homepage has none). */
export interface SitemapUrl {
  loc: string
  lastmod?: string
}

/**
 * A sitemap URL set. Absolute `<loc>` (a protocol requirement), and NO
 * `priority`/`changefreq`: Google ignores both, and publishing invented
 * freshness signals is the SEO-spam this ADR exists to avoid.
 */
export function sitemapXml(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n` +
        (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
        '  </url>',
    )
    .join('\n')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  )
}

/**
 * robots.txt. `/cooking/` is a fullscreen session view that should never
 * be indexed; everything else is allowed and the app-shell routes are
 * deduplicated by canonical rather than blocked.
 */
export function robotsTxt(siteUrl: string): string {
  return (
    `# Robots for ${siteUrl} (generated by scripts/generate-recipe-seo.ts).\n` +
    `# The recipes are the indexable surface; the app-shell routes canonicalize\n` +
    `# to the homepage (see ADR-0048).\n` +
    `User-agent: *\n` +
    `Allow: /\n` +
    `Disallow: /cooking/\n` +
    `Sitemap: ${siteUrl}/sitemap.xml\n`
  )
}

/** `first_published_at` (epoch ms) as a W3C date, the only date we publish. */
export function w3cDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}