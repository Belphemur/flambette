import { describe, expect, test } from 'bun:test'
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SITE_URL,
  homeSeoHead,
  isoDuration,
  recipeDescription,
  recipeImages,
  recipeJsonLd,
  recipeSeoHead,
  recipeTitle,
  recipeUrl,
} from './seo'
import type { RecipeDoc, VariantMeta } from './types'

/* ---------- fixtures ---------- */

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
  ingredient_names: ['lettuce', 'tomatoes', 'chickpeas'],
  variety_tag_ids: [],
  price_per_serving: null,
  thumbnail_image_url: 'https://cdn-uploads.mealime.com/uploads/recipe/thumbnail/1165/thumb_x.jpeg',
  presentation_image_url:
    'https://cdn-uploads.mealime.com/uploads/recipe/thumbnail/1165/presentation_x.jpeg',
  published_recipe_uuid: 'u',
  recipe_id: 1165,
  first_published_at: 0,
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
  thumbnail_image_url: META.thumbnail_image_url,
  presentation_image_url: META.presentation_image_url,
  cookwares: [],
  instructions: [
    { id: 1, primary_message: 'Wash and dry the fresh produce.', secondary_message: null },
    { id: 2, primary_message: 'Toast the flatbreads.', secondary_message: '2 flatbreads' },
  ],
  line_items: [
    { id: 1, quantity: '1 head', ingredient_name: 'butter lettuce' },
    { id: 2, quantity: '', ingredient_name: 'salt' },
  ],
  nutrition: { energy: 697.1 } as RecipeDoc['nutrition'],
}

/* ---------- isoDuration ---------- */

describe('isoDuration', () => {
  test('minutes only', () => {
    expect(isoDuration(30)).toBe('PT30M')
    expect(isoDuration(5)).toBe('PT5M')
  })
  test('hours and minutes', () => {
    expect(isoDuration(90)).toBe('PT1H30M')
    expect(isoDuration(120)).toBe('PT2H')
  })
  test('rounds fractions and floors negatives to PT0M', () => {
    expect(isoDuration(30.4)).toBe('PT30M')
    expect(isoDuration(-5)).toBe('PT0M')
  })
})

/* ---------- urls + images ---------- */

describe('recipeUrl / recipeImages', () => {
  test('canonical url is /recipe/<id> on the site origin', () => {
    expect(recipeUrl(10003)).toBe(`${SITE_URL}/recipe/10003`)
    expect(recipeUrl(42, 'http://localhost:8097')).toBe('http://localhost:8097/recipe/42')
  })

  test('images map to the LOCAL webp assets, absolute — never the CDN URL', () => {
    const imgs = recipeImages(META)
    expect(imgs).toHaveLength(2)
    for (const u of imgs) {
      expect(u.startsWith(SITE_URL)).toBe(true)
      expect(u).toMatch(/\/img\/recipes\/.+\.webp$/)
      expect(u).not.toContain('mealime.com')
    }
    // Deduped: presentation and thumbnail may share one file stem.
    expect(new Set(imgs).size).toBe(imgs.length)
  })
})

/* ---------- title + description ---------- */

describe('recipeTitle / recipeDescription', () => {
  test('title is the recipe name verbatim — no site suffix, no stuffing', () => {
    expect(recipeTitle(META)).toBe(META.name)
  })

  test('description is one factual sentence from catalog facts', () => {
    const d = recipeDescription(META)
    expect(d).toContain(META.name)
    expect(d).toContain('30-minute dinner')
    expect(d).toContain('3 ingredients')
    expect(d).toContain('serving 6')
    // The anti-spam adjectives never appear.
    expect(d.toLowerCase()).not.toMatch(/delicious|amazing|best|perfect/)
  })

  test('unknown ruleset degrades to "meal", not a guess', () => {
    expect(recipeDescription({ ...META, ruleset: 'cpg' })).toContain('branded')
    expect(recipeDescription({ ...META, ruleset: 'weird' })).toContain('meal')
  })
})

/* ---------- JSON-LD ---------- */

describe('recipeJsonLd', () => {
  const ld = recipeJsonLd(DOC, META) as Record<string, unknown>

  test('is a schema.org Recipe anchored on the canonical url', () => {
    expect(ld['@context']).toBe('https://schema.org')
    expect(ld['@type']).toBe('Recipe')
    expect(ld['@id']).toBe(`${SITE_URL}/recipe/10003`)
    expect(ld['url']).toBe(ld['@id'])
  })

  test('carries the catalog facts verbatim', () => {
    expect(ld.name).toBe(META.name)
    expect(ld.recipeYield).toBe('Serves 6')
    expect(ld.recipeCategory).toBe('dinner')
    expect(ld.totalTime).toBe('PT30M')
    expect(ld.recipeIngredient).toEqual(['1 head butter lettuce', 'salt'])
    const steps = ld.recipeInstructions as Array<Record<string, unknown>>
    expect(steps).toHaveLength(2)
    expect(steps[0]['@type']).toBe('HowToStep')
    expect(steps[0].text).toBe('Wash and dry the fresh produce.')
    expect(steps[0].position).toBe(1)
  })

  test('nutrition is per-serving and only the published fields', () => {
    const n = ld.nutrition as Record<string, unknown>
    expect(n['@type']).toBe('NutritionInformation')
    expect(n.calories).toBe('697 kcal')
    expect(n.sodiumContent).toBe('804 mg')
    expect(n.proteinContent).toBe('21.5 g')
  })

  test('aggregate rating only when the catalog counted ratings', () => {
    const r = ld.aggregateRating as Record<string, unknown>
    expect(r.ratingCount).toBe(18)
    expect(r.bestRating).toBe(5)
    // 0.8889 smoothed -> 4.4 of 5.
    expect(r.ratingValue).toBe(4.4)

    // A rating with ZERO counts must be omitted, not fabricated.
    const unrated = recipeJsonLd(DOC, { ...META, rating_count: 0 }) as Record<string, unknown>
    expect('aggregateRating' in unrated).toBe(false)
    const zero = recipeJsonLd(DOC, { ...META, rating: 0 }) as Record<string, unknown>
    expect('aggregateRating' in zero).toBe(false)
  })

  test('an imageless recipe omits image entirely (no placeholder url)', () => {
    const bare = recipeJsonLd(DOC, { ...META, presentation_image_url: '', thumbnail_image_url: '' })
    expect('image' in (bare as Record<string, unknown>)).toBe(false)
  })
})

/* ---------- the async-doc head ---------- */

describe('recipeSeoHead with no doc yet', () => {
  const head = recipeSeoHead(null, META)

  test('every meta-derived tag is already there before the fetch resolves', () => {
    expect(head.title).toBe(META.name)
    expect(head.meta.find((m) => m.name === 'description')?.content).toBe(
      recipeDescription(META),
    )
    expect(head.link).toEqual([{ rel: 'canonical', href: `${SITE_URL}/recipe/10003` }])
    expect(head.meta.find((m) => m.property === 'og:url')?.content).toBe(
      `${SITE_URL}/recipe/10003`,
    )
  })

  test('only the two doc-only JSON-LD keys are missing', () => {
    const full = recipeJsonLd(DOC, META) as Record<string, unknown>
    const partial = recipeJsonLd(null, META) as Record<string, unknown>
    const missing = Object.keys(full).filter((k) => !(k in partial))
    expect(missing.sort()).toEqual(['recipeIngredient', 'recipeInstructions'])
    // Everything else is identical — not a second, drifting builder.
    for (const k of Object.keys(partial)) expect(partial[k]).toEqual(full[k])
  })
})

/* ---------- the app-shell default head ---------- */

describe('homeSeoHead', () => {
  const head = homeSeoHead()

  test('self-canonical homepage, and NOT noindex', () => {
    expect(head.title).toBe(HOME_TITLE)
    expect(head.link).toEqual([{ rel: 'canonical', href: `${SITE_URL}/` }])
    expect(head.meta.some((m) => m.name === 'robots')).toBe(false)
    expect(head.meta.some((m) => m.property === 'og:url' && m.content !== `${SITE_URL}/`)).toBe(
      false,
    )
  })

  test('carries the shared description, and no JSON-LD', () => {
    expect(head.meta.find((m) => m.name === 'description')?.content).toBe(HOME_DESCRIPTION)
    expect(head.script).toEqual([])
  })

  test('honours an overridden site origin', () => {
    expect(homeSeoHead('http://localhost:8097').link[0].href).toBe('http://localhost:8097/')
  })
})

/* ---------- Unhead payload ---------- */

describe('recipeSeoHead', () => {
  const head = recipeSeoHead(DOC, META)

  test('title + description mirror the pure helpers', () => {
    expect(head.title).toBe(recipeTitle(META))
    const desc = head.meta.find((m) => m.name === 'description')?.content
    expect(desc).toBe(recipeDescription(META))
  })

  test('recipe pages flip the robots verdict to indexable', () => {
    expect(head.meta.find((m) => m.name === 'robots')?.content).toBe('index, follow')
  })

  test('canonical link points at the recipe route', () => {
    expect(head.link).toEqual([{ rel: 'canonical', href: `${SITE_URL}/recipe/10003` }])
  })

  test('one JSON-LD script matching recipeJsonLd', () => {
    expect(head.script).toHaveLength(1)
    const s = head.script[0]
    expect(s.type).toBe('application/ld+json')
    // Unhead 3.x takes the OBJECT as textContent (it serializes itself).
    expect(s.textContent).toEqual(recipeJsonLd(DOC, META))
  })

  test('og/twitter tags present when there is an image, absent when there is none', () => {
    const props = head.meta.map((m) => m.property).filter(Boolean)
    expect(props).toContain('og:image')
    expect(head.meta.find((m) => m.name === 'twitter:card')?.content).toBe('summary_large_image')

    const bare = recipeSeoHead(DOC, {
      ...META,
      presentation_image_url: '',
      thumbnail_image_url: '',
    })
    expect(bare.meta.some((m) => m.property === 'og:image')).toBe(false)
    expect(bare.meta.some((m) => m.name === 'twitter:card')).toBe(false)
  })
})
