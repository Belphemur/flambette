import { describe, expect, test } from 'bun:test'
import {
  injectHead,
  jsonLdText,
  linkTag,
  metaTag,
  renderHeadBlock,
  renderNoscript,
  resetPrerenderHead,
  robotsTxt,
  sitemapXml,
  w3cDate,
  xmlEscape,
} from './seoRender'
import { SITE_URL, homeSeoHead, recipeJsonLd, recipeSeoHead, recipesSeoHead, recipesUrl } from './seo'
import type { RecipeDoc, VariantMeta } from './types'

/* ---------- fixtures ---------- */

const BASE_HTML =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n' +
  '    <title>Flambette</title>\n  </head>\n  <body>\n    <div id="app"></div>\n  </body>\n</html>\n'

const META: VariantMeta = {
  id: 10003,
  name: 'Curried Chickpea Salad Flatbread Wrap',
  is_pro: false,
  is_secret: false,
  macros: { fats: 29.58, carbs: 89.04, protein: 21.46 },
  rating: 0.8889,
  rating_count: 18,
  popularity: {},
  calories: 697.1,
  sodium_mg: 803.56,
  cooking_minutes: 30,
  serving_count: 6,
  ingredient_names: ['lettuce', 'tomatoes'],
  variety_tag_ids: [],
  price_per_serving: null,
  thumbnail_image_url: '',
  presentation_image_url: 'https://cdn-uploads.mealime.com/uploads/recipe/thumbnail/1165/presentation_x.jpeg',
  published_recipe_uuid: 'u',
  recipe_id: 1165,
  first_published_at: 1_600_000_000_000,
  ruleset: 'dinner',
}

const DOC: RecipeDoc = {
  id: 10003,
  recipe_id: 1165,
  serving_count: 6,
  cooking_minutes: 30,
  name: META.name,
  slug: 'curried-chickpea-salad-flatbread-wrap',
  units: 'Metric',
  thumbnail_image_url: '',
  presentation_image_url: META.presentation_image_url,
  cookwares: [],
  instructions: [{ id: 1, primary_message: 'Wash the produce.', secondary_message: null }],
  line_items: [{ id: 1, quantity: '1 head', ingredient_name: 'butter lettuce' }],
  nutrition: {} as RecipeDoc['nutrition'],
}

/* ---------- escaping ---------- */

describe('xmlEscape', () => {
  test('escapes the markup-significant characters, ampersand first', () => {
    expect(xmlEscape('Fish & "chips" <b>')).toBe('Fish &amp; &quot;chips&quot; &lt;b&gt;')
    // No double-escaping of the ampersands it just produced.
    expect(xmlEscape('a & <b>')).not.toContain('&amp;amp;')
  })
})

describe('metaTag / linkTag', () => {
  test('serializes attributes in insertion order, escaped', () => {
    expect(metaTag({ name: 'description', content: 'Tom & Jerry' })).toBe(
      '<meta name="description" content="Tom &amp; Jerry">',
    )
    expect(linkTag({ rel: 'canonical', href: 'https://x.test/a?b=1&c=2' })).toBe(
      '<link rel="canonical" href="https://x.test/a?b=1&amp;c=2">',
    )
  })
})

/* ---------- JSON-LD serialization ---------- */

describe('jsonLdText', () => {
  test('parses back to exactly the payload Unhead serializes', () => {
    const payload = recipeJsonLd(DOC, META)
    // The prerenderer's bytes must equal the object the client hands
    // Unhead as textContent — modulo the < > & escaping below.
    const withEscapes = (s: string) =>
      s.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
    expect(JSON.parse(jsonLdText(payload))).toEqual(
      JSON.parse(JSON.stringify(payload)),
    )
    expect(withEscapes(jsonLdText(payload))).toBe(JSON.stringify(payload))
  })

  test('escapes the characters that could close the <script> element', () => {
    const out = jsonLdText({ name: '</script><img src=x onerror=alert(1)>' })
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('<')
    // Still valid JSON carrying the ORIGINAL text.
    expect(JSON.parse(out).name).toBe('</script><img src=x onerror=alert(1)>')
  })
})

/* ---------- head injection ---------- */

describe('renderHeadBlock / injectHead', () => {
  test('replaces the base title — never two <title> elements', () => {
    const head = recipeSeoHead(DOC, META)
    const html = injectHead(BASE_HTML, renderHeadBlock(head))
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).toContain(`<title>${META.name}</title>`)
    expect(html).not.toContain('<title>Flambette</title>')
    // Injected before </head>, after the vite-emitted charset.
    expect(html.indexOf('<meta charset')).toBeLessThan(html.indexOf('<title>'))
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'))
  })

  test('carries exactly one ld+json script, parsed back to recipeJsonLd', () => {
    const html = injectHead(BASE_HTML, renderHeadBlock(recipeSeoHead(DOC, META)))
    // The `id` is part of the contract: it is what lets the hydrating app's
    // Unhead ADOPT this script instead of appending a second ld+json.
    const bodies = [
      ...html.matchAll(/<script id="recipe-jsonld" type="application\/ld\+json">(.*?)<\/script>/g),
    ]
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0][1])).toEqual(
      JSON.parse(JSON.stringify(recipeJsonLd(DOC, META))),
    )
  })

  test('the app-shell head is self-canonical and carries no JSON-LD', () => {
    const html = injectHead(BASE_HTML, renderHeadBlock(homeSeoHead()))
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/">`)
    // ADR-0078: the homepage IS the hero, so the app-shell head describes
    // the hero promise — the "2,500+" literal, never an exact count.
    expect(html).toContain('<title>Flambette — meal planning for your household</title>')
    expect(html).toContain('2,500+ hand-curated recipes')
    expect(html).not.toContain('ld+json')
    expect(html).not.toContain('name="robots"')
  })

  test('the recipes-list head is self-canonical on the trailing-slash form, no JSON-LD', () => {
    const html = injectHead(BASE_HTML, renderHeadBlock(recipesSeoHead()))
    // The canonical must name the URL the surface is SERVED at (nginx
    // try_files $uri/, Cloudflare auto-trailing-slash) — the same rule
    // recipeUrl() established for the per-recipe pages.
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/recipes/">`)
    expect(html).toContain(`<meta property="og:url" content="${SITE_URL}/recipes/">`)
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).not.toContain('ld+json')
    expect(html).not.toContain('name="robots"')
    // A sitemap entry must never contradict the canonical it points at.
    expect(recipesUrl()).toBe(`${SITE_URL}/recipes/`)
  })

  test('a base without </head> is a loud error, not silent output', () => {
    expect(() => injectHead('<html><body></body></html>', 'x')).toThrow(/<\/head>/)
  })

  test('is idempotent: injecting the head twice still yields one title', () => {
    const once = injectHead(BASE_HTML, renderHeadBlock(recipesSeoHead()))
    const twice = injectHead(once, renderHeadBlock(recipesSeoHead()))
    expect(twice.match(/<title>/g)).toHaveLength(1)
  })

  test('re-running is BYTE-IDENTICAL — resetPrerenderHead undoes a run', () => {
    // The prerenderer rewrites dist/index.html in place, so run 2 must not
    // read run 1's output as its base (that stacked a second head on the
    // first). resetPrerenderHead is what makes the step idempotent.
    const run1 = injectHead(BASE_HTML, renderHeadBlock(homeSeoHead()))
    const base = resetPrerenderHead(run1)
    const run2 = injectHead(base, renderHeadBlock(homeSeoHead()))
    expect(run2).toBe(run1)
    // And a pristine base is passed through untouched.
    expect(resetPrerenderHead(BASE_HTML)).toBe(BASE_HTML)
  })

  test('a recipe head on a reset base carries exactly one head block', () => {
    const home = injectHead(BASE_HTML, renderHeadBlock(homeSeoHead()))
    const recipe = injectHead(
      resetPrerenderHead(home),
      renderHeadBlock(recipeSeoHead(DOC, META)),
    )
    expect(recipe.match(/do not edit/g)).toHaveLength(1)
    expect(recipe.match(/<link rel="canonical"/g)).toHaveLength(1)
    expect(recipe).toContain(`${SITE_URL}/recipe/10003/`)
  })
})

/* ---------- noscript ---------- */

describe('renderNoscript', () => {
  const html = renderNoscript(META, DOC, SITE_URL)

  test('carries the factual content, plain', () => {
    expect(html).toContain(`<h1>${META.name}</h1>`)
    expect(html).toContain('<li>1 head butter lettuce</li>')
    expect(html).toContain('<li>Wash the produce.</li>')
    expect(html).toContain(`href="${SITE_URL}/recipe/10003/"`)
    expect(html.startsWith('<noscript>')).toBe(true)
    expect(html.trimEnd().endsWith('</noscript>')).toBe(true)
  })

  test('never copies the app markup (no id=, class= or Vue bindings)', () => {
    expect(html).not.toMatch(/class=|v-if|{{|data-test/)
  })

  test('omits the img for a recipe with no image rather than faking one', () => {
    const bare = renderNoscript({ ...META, presentation_image_url: '', thumbnail_image_url: '' }, DOC, SITE_URL)
    expect(bare).not.toContain('<img')
  })

  test('escapes a hostile name in both the h1 and the link', () => {
    const evil = renderNoscript({ ...META, name: '<script>x</script> & "more"' }, null, SITE_URL)
    expect(evil).not.toContain('<script>')
    expect(evil).toContain('&lt;script&gt;')
    expect(evil).toContain('&amp;')
  })
})

/* ---------- sitemap + robots ---------- */

describe('sitemapXml', () => {
  test('emits absolute locs, W3C lastmod, and no priority/changefreq', () => {
    const xml = sitemapXml([
      { loc: `${SITE_URL}/` },
      { loc: `${SITE_URL}/recipe/1`, lastmod: '2020-09-13' },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    expect(xml).toContain('<loc>https://flambette.app/</loc>')
    expect(xml).toContain('<lastmod>2020-09-13</lastmod>')
    expect(xml).not.toMatch(/priority|changefreq/)
    // The homepage carries no lastmod: the app has no publication date.
    expect(xml.match(/<lastmod>/g)).toHaveLength(1)
  })

  test('escapes a loc containing an ampersand', () => {
    const xml = sitemapXml([{ loc: 'https://x.test/r?a=1&b=2' }])
    expect(xml).toContain('<loc>https://x.test/r?a=1&amp;b=2</loc>')
  })
})

describe('w3cDate', () => {
  test('epoch ms -> YYYY-MM-DD in UTC', () => {
    expect(w3cDate(1_600_000_000_000)).toBe('2020-09-13')
    expect(w3cDate(0)).toBe('1970-01-01')
  })
})

describe('robotsTxt', () => {
  test('allow-all, disallow the fullscreen cook view, point at the sitemap', () => {
    const txt = robotsTxt(SITE_URL)
    expect(txt).toContain('User-agent: *')
    expect(txt).toContain('Allow: /')
    expect(txt).toContain('Disallow: /cooking/')
    expect(txt).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
    expect(txt.endsWith('\n')).toBe(true)
  })
})