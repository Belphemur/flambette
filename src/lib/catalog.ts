import type { BuilderData, RecipeDoc, VariantMeta, VariantData } from './types'

/**
 * Catalog: fetches + indexes the builder_data snapshot and lazy-fetches
 * full recipe documents from the Mealime CDN (cached in memory).
 */

const BUILDER_DATA_URL = `${import.meta.env.BASE_URL}data/builder_data.json`
const RECIPE_CDN = 'https://cdn-recipes.mealime.com'

export interface Catalog {
  data: BuilderData
  /** variant id -> meta */
  byId: Map<number, VariantMeta>
  /** variant id -> variant_data entry */
  dataById: Map<number, VariantData>
  /** sorted, distinct category names */
  categories: string[]
  /** favourited variant ids */
  favouriteIds: Set<number>
}

let catalogPromise: Promise<Catalog> | null = null

function buildCatalog(data: BuilderData): Catalog {
  const byId = new Map<number, VariantMeta>()
  for (const meta of data.variant_meta) byId.set(meta.id, meta)
  const dataById = new Map<number, VariantData>()
  for (const [id, vd] of Object.entries(data.variant_data)) {
    dataById.set(Number(id), vd)
  }
  const categories = [...new Set([...dataById.values()].map((v) => v.category_name))].sort()
  return {
    data,
    byId,
    dataById,
    categories,
    favouriteIds: new Set(data.favourited_feasible_variants),
  }
}

export function getCatalog(): Promise<Catalog> {
  catalogPromise ??= fetch(BUILDER_DATA_URL).then(async (res) => {
    if (!res.ok) throw new Error(`Failed to load catalog: HTTP ${res.status}`)
    return buildCatalog((await res.json()) as BuilderData)
  })
  return catalogPromise
}

/* ---------- Full recipe documents ---------- */

const recipeCache = new Map<string, RecipeDoc>()
const recipePromises = new Map<string, Promise<RecipeDoc>>()

/** Lazy-fetch the full recipe document for a variant (cached in memory). */
export function getRecipe(meta: VariantMeta): Promise<RecipeDoc> {
  const uuid = meta.published_recipe_uuid
  const cached = recipeCache.get(uuid)
  if (cached) return Promise.resolve(cached)
  let p = recipePromises.get(uuid)
  if (!p) {
    p = fetch(`${RECIPE_CDN}/${uuid}.json`).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to load recipe: HTTP ${res.status}`)
      const doc = (await res.json()) as RecipeDoc
      recipeCache.set(uuid, doc)
      recipePromises.delete(uuid)
      return doc
    })
    recipePromises.set(uuid, p)
  }
  return p
}
