/**
 * SEO payload builders for the recipe routes (ADR-0048).
 *
 * TWO consumers share ONE module so a crawler and a browser can never
 * disagree about what a recipe page says:
 *
 *  1. `scripts/generate-recipe-seo.ts` — the BUILD-TIME prerenderer. It
 *     walks the frozen catalog and writes a static
 *     `dist/recipe/<id>/index.html` per recipe whose `<head>` carries the
 *     title, description, Open Graph / Twitter tags, canonical URL and the
 *     JSON-LD `Recipe` object. A crawler without a JS engine reads the
 *     full truth straight out of the HTML.
 *  2. `src/components/RecipeDetail.vue` — the client side. Unhead's
 *     `useHead` re-derives the SAME payloads reactively, so an SPA
 *     navigation between recipes updates the document head exactly as the
 *     prerendered page would have (a stale `?p=` share link must not
 *     carry the previous recipe's title into a new one).
 *
 * Anti-spam contract (the "no SEO spam" rules from ADR-0048):
 *  - EVERY string is derived from the frozen catalog — no invented
 *    marketing copy, no keyword stuffing. The description is one factual
 *    sentence assembled from the recipe's own name, meal occasion,
 *    cooking time and ingredient count.
 *  - Recipe pages are the indexable SURFACE. Every app-shell route
 *    (`/plan`, `/grocery`, …) is served the SPA fallback, so they all
 *    share ONE default head (`homeSeoHead`) whose canonical is the
 *    homepage — the canonical, not a `noindex`, is what keeps those
 *    routes from competing with the homepage in search.
 *  - The JSON-LD is `Recipe` schema.org with the catalog's actual
 *    ingredients, instructions, yield and nutrition. A field the catalog
 *    does not publish (prep time, cuisine, author person) is OMITTED —
 *    Google's structured-data guidelines call unspecified fields spam
 *    just as much as fabricated ones.
 */

import type { RecipeDoc, VariantMeta } from './types'
import { localImageUrl } from './images'

/** The canonical production origin (ADR-0038 hosted path). Build-time only. */
export const SITE_URL = 'https://flambette.app'

/** Meal-occasion label per catalog `ruleset`, matching ADR-0043's table. */
const OCCASION_LABEL: Record<string, string> = {
  breakfast: 'breakfast',
  dessert: 'dessert',
  snack: 'snack',
  simple: 'lunch',
  dinner: 'dinner',
  cpg: 'branded',
}

/**
 * Minutes as an ISO 8601 duration (`PT30M`, `PT1H30M`) for
 * `cookTime`/`totalTime`. Zero/negative minutes are omitted by the caller
 * rather than emitting a meaningless `PT0M`.
 */
export function isoDuration(minutes: number): string {
  const clamped = Math.max(0, Math.round(minutes))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  let out = 'PT'
  if (h) out += `${h}H`
  if (m || !h) out += `${m}M`
  return out
}

/** The one app-level title + description, shared by the client default
 *  head (`App.vue`) and the prerendered `dist/index.html`. Kept here
 *  because it is the SAME single-source rule as the recipe payloads: two
 *  hand-written copies would eventually disagree, and a disagreeing home
 *  title is exactly what a crawler sees first. */
export const HOME_TITLE = 'Flambette'

export const HOME_DESCRIPTION =
  'Flambette — the frozen Mealime recipe catalog: browse 2,700+ quick recipes, ' +
  'plan your week and cook with step-by-step timers.'

/** Absolute URL for a recipe route, for canonical / OG / JSON-LD `@id`. */
export function recipeUrl(variantId: number, siteUrl: string = SITE_URL): string {
  return `${siteUrl}/recipe/${variantId}`
}

/**
 * Absolute URL for a recipe image. The catalog stores Mealime CDN URLs,
 * but the SHIPPED images are the local webp copies (`src/lib/images.ts`) —
 * the CDN is shutting down and `no runtime requests to mealime.com` is an
 * e2e-enforced rule, so the JSON-LD must point at the asset we actually
 * serve. Recipes without an image return `[]`: an absent image is never a
 * fabricated placeholder URL.
 */
export function recipeImages(meta: VariantMeta, siteUrl: string = SITE_URL): string[] {
  const urls = [meta.presentation_image_url, meta.thumbnail_image_url]
    .map((u) => localImageUrl(u))
    .filter((u): u is string => Boolean(u))
    .map((path) => `${siteUrl}${path}`)
  return [...new Set(urls)]
}

/**
 * One factual sentence: the recipe's own name, its meal occasion, its
 * cooking time and its ingredient count. Nothing else — no "delicious",
 * no "amazing", no adjective the catalog did not publish.
 */
export function recipeTitle(meta: VariantMeta): string {
  return meta.name
}

export function recipeDescription(meta: VariantMeta): string {
  const occasion = OCCASION_LABEL[meta.ruleset] ?? 'meal'
  const minutes = Math.round(meta.cooking_minutes)
  const ingredients = meta.ingredient_names.length
  return (
    `${meta.name} — a ${minutes}-minute ${occasion} recipe with ${ingredients} ` +
    `ingredients, serving ${meta.serving_count}.`
  )
}

/* ---------------- JSON-LD (schema.org Recipe) ---------------- */

/**
 * The JSON-LD object for one recipe, exactly as Google's rich-results guide
 * defines it.
 *
 * `doc` is NULLABLE on purpose: the client fetches a recipe doc
 * asynchronously, and every meta-derived field (name, yield, time, image,
 * nutrition, rating) is already truth at that moment. A null doc therefore
 * yields the SAME node minus the two doc-only keys
 * (`recipeIngredient`, `recipeInstructions`) instead of an empty head — so
 * there is exactly ONE builder, not a "partial" variant that drifts.
 */
export function recipeJsonLd(
  doc: RecipeDoc | null,
  meta: VariantMeta,
  siteUrl: string = SITE_URL,
) {
  const url = recipeUrl(meta.id, siteUrl)
  const images = recipeImages(meta, siteUrl)
  const kcal = Math.round(meta.calories)
  const sodium = Math.round(meta.sodium_mg)

  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    // The route IS the entity id — sameAs-style identity for the crawler.
    '@id': url,
    name: meta.name,
    url,
    // Recipe descriptions that are only a copy of the name are a rich-result
    // anti-pattern; ours is the factual sentence from `recipeDescription`.
    description: recipeDescription(meta),
    recipeYield: `Serves ${meta.serving_count}`,
    recipeCategory: OCCASION_LABEL[meta.ruleset] ?? meta.ruleset,
  }
  if (images.length) node.image = images
  if (meta.cooking_minutes > 0) {
    node.totalTime = isoDuration(meta.cooking_minutes)
    node.cookTime = isoDuration(meta.cooking_minutes)
  }
  if (meta.ingredient_names.length) node.keywords = [...meta.ingredient_names]

  // Ingredients verbatim from the frozen doc — the authored quantity string
  // plus the name, no re-formatting (the display formatting is unit-system
  // dependent; the catalog's authored text is the stable identity).
  if (doc?.line_items?.length) {
    node.recipeIngredient = doc.line_items.map(
      (li) => (li.quantity ? `${li.quantity} ` : '') + li.ingredient_name,
    )
  }

  // One HowToStep per authored instruction, primary message only. The
  // secondary breakdown lines are ingredient amounts, not prose steps —
  // they would read as noise to a rich-result parser.
  if (doc?.instructions?.length) {
    node.recipeInstructions = doc.instructions.map((step, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      text: step.primary_message,
    }))
  }

  // Per-serving nutrition facts — the SAME numbers the app displays
  // (meta.calories / sodium_mg are already per-serving, ADR-0002/0003).
  const nutrition: Record<string, unknown> = { '@type': 'NutritionInformation' }
  if (meta.calories > 0) nutrition.calories = `${kcal} kcal`
  if (meta.sodium_mg > 0) nutrition.sodiumContent = `${sodium} mg`
  if (meta.macros) {
    if (meta.macros.protein) nutrition.proteinContent = `${meta.macros.protein.toFixed(1)} g`
    if (meta.macros.carbs) nutrition.carbohydrateContent = `${meta.macros.carbs.toFixed(1)} g`
    if (meta.macros.fats) nutrition.fatContent = `${meta.macros.fats.toFixed(1)} g`
  }
  if (Object.keys(nutrition).length > 1) node.nutrition = nutrition

  // Aggregate rating ONLY when the catalog actually counted ratings. A
  // fabricated `ratingValue` (or a 0-count entry) is schema spam and
  // Google's structured-data policy penalises it.
  if (meta.rating > 0 && meta.rating_count > 0) {
    node.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number((meta.rating * 5).toFixed(1)),
      ratingCount: meta.rating_count,
      bestRating: 5,
      worstRating: 1,
    }
  }

  return node
}

/* ---------------- Unhead payloads ---------------- */

/**
 * The exact shape of one Unhead tag, narrowed to what this module emits.
 *
 * Narrow (rather than `Record<string, string>`) on purpose: Unhead resolves
 * its input against its own tag types, so an open record would be
 * structurally incompatible with `useHead` and every call site would need a
 * cast. `rel: 'canonical'` is a literal for the same reason. They are
 * `type` aliases, not `interface`s, because Unhead's tag types carry a
 * `data-${string}` index signature and only a type alias gets the implicit
 * index signature needed to satisfy it. `SeoMetaTag` is a UNION for the
 * same structural reason: Unhead's meta tags are name-based OR
 * property-based and mutually exclusive, so a tag with both keys optional
 * would match neither arm.
 */
export type SeoMetaTag =
  | { name: string; property?: never; content: string }
  | { property: string; name?: never; content: string }

export type SeoLinkTag = {
  rel: 'canonical'
  href: string
}

/**
 * JSON-LD scripts. Unhead 3.x (`JsonLdScript`) takes the payload as
 * `textContent` and serializes objects itself (XSS-safe; never
 * `innerHTML`), so we hand over the OBJECT and both consumers — the
 * client's `useHead` and the prerenderer's `JSON.stringify` — emit the
 * identical payload.
 */
export type SeoJsonLdScript = {
  type: 'application/ld+json'
  textContent: Record<string, unknown>
}

/** The head payload both consumers consume (an Unhead input by construction). */
export interface SeoHeadInput {
  title: string
  meta: SeoMetaTag[]
  link: SeoLinkTag[]
  script: SeoJsonLdScript[]
}

/**
 * The full head payload for ONE recipe page. Mirrors exactly what the
 * prerenderer injects into `dist/recipe/<id>/index.html`, so a crawler
 * and a hydrating browser agree byte for byte (ADR-0048 parity rule).
 *
 * A null `doc` degrades the JSON-LD only (see {@link recipeJsonLd}) —
 * title, description, OG/Twitter and canonical are all meta-derived and
 * never wait for the fetch.
 */
export function recipeSeoHead(
  doc: RecipeDoc | null,
  meta: VariantMeta,
  siteUrl: string = SITE_URL,
): SeoHeadInput {
  const url = recipeUrl(meta.id, siteUrl)
  const title = recipeTitle(meta)
  const description = recipeDescription(meta)
  const images = recipeImages(meta, siteUrl)
  const ogImage = images[0]

  return {
    title,
    meta: [
      { name: 'description', content: description },
      // Recipe pages are the ONLY indexable surface (ADR-0048): App.vue's
      // default head marks the app-shell routes noindex, and this line
      // flips the verdict back for the recipe itself.
      { name: 'robots', content: 'index, follow' },
      { property: 'og:type', content: 'article' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      ...(ogImage
        ? [
            { property: 'og:image', content: ogImage },
            { name: 'twitter:card', content: 'summary_large_image' },
            { name: 'twitter:title', content: title },
            { name: 'twitter:description', content: description },
            { name: 'twitter:image', content: ogImage },
          ]
        : []),
    ],
    link: [{ rel: 'canonical', href: url }],
    script: [
      {
        type: 'application/ld+json',
        textContent: recipeJsonLd(doc, meta, siteUrl),
      },
    ],
  }
}

/* ---------------- the app-shell (default) head ---------------- */

/**
 * The head for the SPA shell — the homepage and every app-shell route
 * (`/plan`, `/grocery`, `/settings`, …) that shares its fallback HTML.
 *
 * Self-canonical to the homepage and deliberately NOT `noindex`: the
 * homepage itself belongs in search, and the canonical is what tells a
 * crawler that `/plan` served this same document is a duplicate of it.
 * Both consumers use this one builder — `App.vue` as the default head,
 * `scripts/generate-recipe-seo.ts` for `dist/index.html`.
 */
export function homeSeoHead(siteUrl: string = SITE_URL): SeoHeadInput {
  return {
    title: HOME_TITLE,
    meta: [
      { name: 'description', content: HOME_DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: HOME_TITLE },
      { property: 'og:description', content: HOME_DESCRIPTION },
      { property: 'og:url', content: `${siteUrl}/` },
    ],
    link: [{ rel: 'canonical', href: `${siteUrl}/` }],
    script: [],
  }
}
