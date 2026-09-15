import { shallowRef } from 'vue'
import type { BuilderData, RecipeDoc, VariantMeta, VariantData } from './types'

/**
 * Catalog: fetches + indexes the builder_data snapshot and lazy-fetches
 * full recipe documents from the Mealime CDN (cached in memory).
 */

const BUILDER_DATA_URL = `${import.meta.env.BASE_URL}data/builder_data.json`

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

/** The loaded catalog, once `getCatalog()` resolves. Reactive (shallowRef). */
export const catalog = shallowRef<Catalog | null>(null)

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
    const built = buildCatalog((await res.json()) as BuilderData)
    catalog.value = built
    return built
  })
  return catalogPromise
}

/* ---------- Full recipe documents ---------- */

const recipeCache = new Map<number, RecipeDoc>()
const recipePromises = new Map<number, Promise<RecipeDoc>>()

/**
 * Fetch the full recipe document for a variant from the bundled local
 * catalog (public/data/recipes/{variant_id}.json — complete, offline).
 * Cached in memory.
 */
export function getRecipe(meta: VariantMeta): Promise<RecipeDoc> {
  const id = meta.id
  const cached = recipeCache.get(id)
  if (cached) return Promise.resolve(cached)
  let p = recipePromises.get(id)
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/recipes/${id}.json`).then(
      async (res) => {
        if (!res.ok) throw new Error(`Failed to load recipe: HTTP ${res.status}`)
        const doc = (await res.json()) as RecipeDoc
        recipeCache.set(id, doc)
        recipePromises.delete(id)
        return doc
      },
    )
    recipePromises.set(id, p)
  }
  return p
}
