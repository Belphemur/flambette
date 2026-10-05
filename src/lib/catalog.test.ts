import { describe, expect, test } from 'bun:test'
import rawBuilder from '../../public/data/builder_data.json'
import { buildCatalog, parseUserRecipes, type UserRecipeEntry } from './catalog'
import type { BuilderData, RecipeDoc, VariantData, VariantMeta } from './types'
import { USER_RECIPE_ID_BASE } from './userRecipes'

/**
 * The ADR-0054 catalog merge. This is the one piece of decision that
 * decides whether a household recipe is visible to EVERY engine at once
 * (search, diets, meal type, Auto-Plan, grocery, cooking, favourites,
 * ratings, the room payload) — so it is pinned here against the real
 * committed builder data, and the degradation paths are pinned here
 * rather than only by a browser.
 *
 * The artifact is a STATIC ASSET, not a dependency: a missing or
 * malformed `user_recipes.json` must leave the catalog exactly as it was.
 */

const builder = rawBuilder as unknown as BuilderData
const CATALOG_SIZE = builder.variant_meta.length

function meta(id: number): VariantMeta {
  return {
    id,
    name: 'Fluffy Pancake',
    is_pro: false,
    is_secret: false,
    macros: { fats: 0.2, carbs: 0.5, protein: 0.1 },
    rating: 0.5,
    rating_count: 0,
    popularity: {},
    calories: 400,
    sodium_mg: 500,
    cooking_minutes: 20,
    serving_count: 8,
    ingredient_names: ['flour'],
    variety_tag_ids: [],
    price_per_serving: null,
    thumbnail_image_url: 'https://example.test/uploads/recipe/thumbnail/1/pancake_abc.webp',
    published_recipe_uuid: 'user-pancake',
    recipe_id: 0,
    first_published_at: 1_800_000_000_000,
    ruleset: 'breakfast',
  }
}

const data: VariantData = {
  category_name: 'vegetarian',
  boost: 0,
  variety_tags: [],
  perishable_amounts: {},
  month_seasonalities: [],
  recipe_id: 0,
}

const doc = {
  id: USER_RECIPE_ID_BASE,
  recipe_id: 0,
  serving_count: 8,
  cooking_minutes: 20,
  name: 'Fluffy Pancake',
  slug: 'fluffy-pancake',
  units: 'Metric',
  thumbnail_image_url: 'https://example.test/uploads/recipe/thumbnail/1/pancake_abc.webp',
  presentation_image_url: '',
  cookwares: [],
  instructions: [],
  line_items: [],
  nutrition: { energy: 400 },
} as unknown as RecipeDoc

const entry: UserRecipeEntry = {
  addedAt: 1_800_000_000_000,
  source: 'user',
  meta: meta(USER_RECIPE_ID_BASE),
  data,
  doc,
}

describe('buildCatalog with no user recipes', () => {
  test('is the untouched Mealime catalog', () => {
    const c = buildCatalog(builder, [])
    expect(c.byId.size).toBe(CATALOG_SIZE)
    expect(c.dataById.size).toBe(Object.keys(builder.variant_data).length)
    expect(c.userRecipeIds.size).toBe(0)
    expect(c.userRecipeDocs.size).toBe(0)
    expect(c.userRecipeAddedAt.size).toBe(0)
  })
})

describe('buildCatalog merges a user recipe into the SAME indexes', () => {
  const c = buildCatalog(builder, [entry])
  const id = USER_RECIPE_ID_BASE

  test('the variant is in byId and dataById, so every engine sees it', () => {
    expect(c.byId.size).toBe(CATALOG_SIZE + 1)
    expect(c.dataById.size).toBe(Object.keys(builder.variant_data).length + 1)
    expect(c.byId.get(id)?.name).toBe('Fluffy Pancake')
    expect(c.dataById.get(id)?.category_name).toBe('vegetarian')
  })

  test('membership is the id set, and the doc is served from memory', () => {
    // `VariantMeta` is frozen and gains no flag, so the SET is the only
    // answer a card can get — and the doc must never be fetched per id.
    expect(c.userRecipeIds.has(id)).toBe(true)
    expect(c.userRecipeIds.has(17452)).toBe(false)
    expect(c.userRecipeDocs.get(id)?.serving_count).toBe(8)
    expect(c.userRecipeAddedAt.get(id)).toBe(1_800_000_000_000)
  })

  test('a user recipe is a first-class breakfast, so Auto-Plan can pick it', () => {
    // useAutoPlan builds its eligible set from dataById and the planner's
    // candidate universe from the pack index. Merging into dataById is
    // what makes L2 ("the pancake IS Auto-Plan eligible") true.
    expect(c.byId.get(id)?.ruleset).toBe('breakfast')
    expect(c.dataById.has(id)).toBe(true)
  })

  test('the merge never touches the catalog ids', () => {
    expect(c.byId.get(17452)).toBe(builder.variant_meta.find((m) => m.id === 17452))
    expect(c.favouriteIds.size).toBe(builder.favourited_feasible_variants.length)
  })
})

describe('parseUserRecipes degrades instead of throwing', () => {
  test('a non-object payload yields no recipes', () => {
    for (const bad of [null, undefined, 7, 'nope', []]) {
      expect(parseUserRecipes(bad), JSON.stringify(bad ?? null)).toEqual([])
    }
  })

  test('a payload with no recipes array yields no recipes', () => {
    expect(parseUserRecipes({})).toEqual([])
    expect(parseUserRecipes({ version: 1, recipes: 'lots' })).toEqual([])
  })

  test('an empty artifact is a valid, no-op artifact', () => {
    expect(parseUserRecipes({ version: 1, recipes: [] })).toEqual([])
  })

  test('a well-formed entry survives intact', () => {
    const parsed = parseUserRecipes({ version: 1, recipes: [entry] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].meta.id).toBe(USER_RECIPE_ID_BASE)
    expect(parsed[0].source).toBe('user')
    expect(parsed[0].addedAt).toBe(1_800_000_000_000)
  })

  test('a broken entry is skipped, its healthy neighbours are kept', () => {
    // The whole point of degrading rather than throwing: the owner adds a
    // recipe, one field is wrong, and the other 2,759 still serve.
    const parsed = parseUserRecipes({
      version: 1,
      recipes: [
        { ...entry, meta: { ...meta(USER_RECIPE_ID_BASE + 1) } },
        { addedAt: 1, source: 'user' }, // no meta/data/doc
        { ...entry, meta: { ...meta('nope' as unknown as number) } },
        { ...entry, addedAt: 'yesterday' },
      ],
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].meta.id).toBe(USER_RECIPE_ID_BASE + 1)
  })

  test('an id inside the catalog id space is REFUSED, never merged', () => {
    // Merging it would SHADOW a real Mealime recipe in byId/dataById — a
    // silent corruption of the frozen catalog, which is exactly the kind
    // of bug that reads as "the app is broken" three features away.
    const parsed = parseUserRecipes({ version: 1, recipes: [{ ...entry, meta: meta(17452) }] })
    expect(parsed).toEqual([])
    const c = buildCatalog(builder, [{ ...entry, meta: meta(17452) }])
    expect(c.byId.get(17452)?.name).not.toBe('Fluffy Pancake')
  })
})
