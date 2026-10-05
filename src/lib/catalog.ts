import { shallowRef } from 'vue'
import type { BuilderData, RecipeDoc, VariantMeta, VariantData } from './types'
import { USER_RECIPE_ID_BASE } from './userRecipes'

/**
 * Catalog: fetches + indexes the builder_data snapshot and lazy-fetches
 * full recipe documents from the local catalog (cached in memory).
 *
 * ADR-0052 adds the household's OWN recipes to the same catalog. They
 * arrive in a second static asset, `data/user_recipes.json`, and are
 * MERGED into the builder data rather than kept beside it: search, the
 * diet chips, the meal-type facet, Auto-Plan, the grocery derivation,
 * cooking, favourites, ratings and the room payload then treat a user
 * recipe as a peer of a Mealime recipe with no per-engine code
 * (locked decision L4). A parallel "my recipes" store would have to be
 * taught to each of those engines separately, and the first one anybody
 * forgot would silently not see the recipe.
 *
 * The merge is deliberately defensive. `user_recipes.json` is a static
 * asset that a partial deploy can be missing and a hand-edit can
 * malform, and it is NOT a dependency of the app: a missing or invalid
 * file logs once and leaves the catalog exactly as it was. The catalog
 * load itself only fails if `builder_data.json` fails.
 */

const BUILDER_DATA_URL = `${import.meta.env.BASE_URL}data/builder_data.json`
const USER_RECIPES_URL = `${import.meta.env.BASE_URL}data/user_recipes.json`

/**
 * One household-authored recipe, exactly as it is committed.
 *
 * `meta` is a plain `VariantMeta` with NO new required fields — the
 * frozen interface stays frozen — so every existing consumer keeps
 * working. `addedAt` (epoch ms) is the household's "we added this" date
 * and the only input to the NEW badge; it is mirrored into
 * `meta.first_published_at` at load so a card holding nothing but a
 * VariantMeta can still be dated, but the artifact keeps the honest
 * name for it.
 *
 * `source` is explicit even though `'user'` is the only value a
 * household-authored recipe can carry today: it is what makes "this
 * recipe is NOT from the Mealime import" a reviewable fact in the file
 * rather than an inference, and it is the seam a second non-Mealime
 * source would extend.
 */
export interface UserRecipeEntry {
  addedAt: number
  source: 'user'
  meta: VariantMeta
  data: VariantData
  doc: RecipeDoc
}

export interface UserRecipesFile {
  version: number
  recipes: UserRecipeEntry[]
}

export interface Catalog {
  data: BuilderData
  /** `data.variant_meta` plus the merged user metas (see buildCatalog). */
  variantMeta: VariantMeta[]
  /** variant id -> meta */
  byId: Map<number, VariantMeta>
  /** variant id -> variant_data entry */
  dataById: Map<number, VariantData>
  /** sorted, distinct category names */
  categories: string[]
  /** favourited variant ids */
  favouriteIds: Set<number>
  /**
   * The ids of the household's own recipes (ADR-0052). Membership is
   * decided HERE and nowhere else: `VariantMeta` is frozen and gains no
   * flag, so this set is the only answer available to a component that
   * holds one card.
   */
  userRecipeIds: Set<number>
  /** variant id -> the embedded recipe document (user recipes only). */
  userRecipeDocs: Map<number, RecipeDoc>
  /** variant id -> the household's addedAt epoch ms (user recipes only). */
  userRecipeAddedAt: Map<number, number>
}

let catalogPromise: Promise<Catalog> | null = null

/** The loaded catalog, once `getCatalog()` resolves. Reactive (shallowRef). */
export const catalog = shallowRef<Catalog | null>(null)

/**
 * Embedded user-recipe documents, kept at MODULE level rather than read
 * off `catalog` so `getRecipe()` can answer without the caller having
 * awaited the catalog first. Populated once, by `buildCatalog`.
 */
const userDocsById = new Map<number, RecipeDoc>()

/** The recipe document embedded in the user-recipes artifact, if any. */
export function userRecipeDoc(id: number): RecipeDoc | undefined {
  return userDocsById.get(id)
}

/** The household's addedAt for a user recipe, if it is one. */
export function userRecipeAddedAt(id: number): number | undefined {
  return catalog.value?.userRecipeAddedAt.get(id)
}

/**
 * Merge the two sources into the catalog's indexes.
 *
 * Exported (rather than module-private) as the TEST SEAM: the merge is
 * the one piece of ADR-0052 that decides whether a user recipe is
 * visible to every engine, and it is pure — no fetch, no Vue — so the
 * degradation paths below can be pinned by bun-test instead of only by a
 * browser.
 */
export function buildCatalog(data: BuilderData, users: UserRecipeEntry[]): Catalog {
  const byId = new Map<number, VariantMeta>()
  for (const meta of data.variant_meta) byId.set(meta.id, meta)
  const dataById = new Map<number, VariantData>()
  for (const [id, vd] of Object.entries(data.variant_data)) {
    dataById.set(Number(id), vd)
  }

  // ADR-0052: merge the household's recipes into the SAME indexes, so no
  // engine needs to know they exist separately.
  const userRecipeIds = new Set<number>()
  const userRecipeDocs = new Map<number, RecipeDoc>()
  const userRecipeAddedAt = new Map<number, number>()
  // The MERGED meta list the result pipelines read (see `variantMeta` on the
  // Catalog interface). Built fresh rather than pushed onto
  // `data.variant_meta` in place: the raw builder object is shared (tests,
  // HMR, a re-load) and mutating an input is how a "no user recipes" build
  // quietly becomes one that has them.
  const userMetas: VariantMeta[] = []
  for (const entry of users) {
    const id = entry.meta.id
    // Defence in depth, and the reason the property is structural rather
    // than a convention: `parseUserRecipes` already refuses an id in the
    // catalog's id space, and a merge that SHADOWED a frozen Mealime
    // recipe in `byId`/`dataById` would be a silent corruption of the
    // catalog. Both gates are cheap; the consequence is not.
    if (typeof id !== 'number' || !Number.isFinite(id) || id < USER_RECIPE_ID_BASE) {
      console.warn(
        `[catalog] refusing to merge user recipe with id ${String(id)}: ids must be ` +
          `finite and at or above ${USER_RECIPE_ID_BASE}`,
      )
      continue
    }
    byId.set(id, entry.meta)
    dataById.set(id, entry.data)
    userRecipeIds.add(id)
    userRecipeDocs.set(id, entry.doc)
    userRecipeAddedAt.set(id, entry.addedAt)
    userMetas.push(entry.meta)
  }
  userDocsById.clear()
  for (const [id, doc] of userRecipeDocs) userDocsById.set(id, doc)

  const categories = [...new Set([...dataById.values()].map((v) => v.category_name))].sort()
  return {
    data,
    /**
     * `data.variant_meta` PLUS the merged user metas — the one list every
     * result pipeline (grid, search index, diet index, Auto-Plan) reads, so
     * a user recipe is visible to all of them by construction. `data`
     * itself is never mutated: it is the fetched builder payload.
     */
    variantMeta: userMetas.length ? [...data.variant_meta, ...userMetas] : data.variant_meta,
    byId,
    dataById,
    categories,
    favouriteIds: new Set(data.favourited_feasible_variants),
    userRecipeIds,
    userRecipeDocs,
    userRecipeAddedAt,
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse the artifact, dropping anything unusable rather than throwing.
 *
 * Every rejection is LOUD (one `console.warn` each) because a silently
 * dropped recipe is invisible: the owner adds a recipe, it does not
 * appear, and nothing says why. Skipping is still better than failing —
 * a build with one bad entry should still serve the other 2,759 — but
 * the log is what turns that into a fixable bug.
 */
export function parseUserRecipes(payload: unknown): UserRecipeEntry[] {
  if (!isObject(payload)) {
    console.warn('[catalog] user_recipes.json is not an object; ignoring it')
    return []
  }
  const raw = (payload as { recipes?: unknown }).recipes
  if (!Array.isArray(raw)) {
    console.warn('[catalog] user_recipes.json has no recipes array; ignoring it')
    return []
  }
  const out: UserRecipeEntry[] = []
  raw.forEach((item, index) => {
    if (!isObject(item) || !isObject(item.meta) || !isObject(item.data) || !isObject(item.doc)) {
      console.warn(`[catalog] user_recipes.json entry ${index} is missing meta/data/doc; skipped`)
      return
    }
    const id = (item.meta as { id?: unknown }).id
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      console.warn(`[catalog] user_recipes.json entry ${index} has no numeric id; skipped`)
      return
    }
    // A user id inside the catalog's id space would SHADOW a Mealime
    // recipe in `byId`/`dataById` — a silent, catastrophic merge. The
    // reserved band exists so this cannot happen; refuse the entry
    // anyway, because an artifact is hand-editable.
    if (id < USER_RECIPE_ID_BASE) {
      console.warn(
        `[catalog] user_recipes.json entry ${index} has id ${id}, inside the catalog id ` +
          `space (below ${USER_RECIPE_ID_BASE}); skipped`,
      )
      return
    }
    const addedAt = (item as { addedAt?: unknown }).addedAt
    if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) {
      console.warn(`[catalog] user_recipes.json entry ${index} (id ${id}) has no addedAt; skipped`)
      return
    }
    out.push(item as unknown as UserRecipeEntry)
  })
  return out
}

/** Fetch + parse the user recipes, degrading to "this build has none". */
async function loadUserRecipes(): Promise<UserRecipeEntry[]> {
  try {
    const res = await fetch(USER_RECIPES_URL)
    if (!res.ok) {
      console.warn(`[catalog] user_recipes.json unavailable (HTTP ${res.status}); continuing without it`)
      return []
    }
    return parseUserRecipes(await res.json())
  } catch (err) {
    console.warn('[catalog] failed to load user_recipes.json; continuing without it', err)
    return []
  }
}

export function getCatalog(): Promise<Catalog> {
  catalogPromise ??= (async () => {
    // PARALLEL, not sequential: the user-recipes asset is small and the
    // catalog load is on the critical path of the first paint.
    const [res, users] = await Promise.all([fetch(BUILDER_DATA_URL), loadUserRecipes()])
    if (!res.ok) throw new Error(`Failed to load catalog: HTTP ${res.status}`)
    const built = buildCatalog((await res.json()) as BuilderData, users)
    catalog.value = built
    return built
  })()
  return catalogPromise
}

/* ---------- Full recipe documents ---------- */

const recipeCache = new Map<number, RecipeDoc>()
const recipePromises = new Map<number, Promise<RecipeDoc>>()

/**
 * Fetch the full recipe document for a variant.
 *
 * A USER recipe's document is EMBEDDED in `user_recipes.json`, so it is
 * served from memory: there is no per-recipe file to fetch, and a
 * network round trip for a doc already in hand would be a bug waiting to
 * 404. Every other variant is fetched from the bundled local catalog
 * (public/data/recipes/{variant_id}.json — complete, offline). Cached in
 * memory either way.
 */
export function getRecipe(meta: VariantMeta): Promise<RecipeDoc> {
  const id = meta.id
  const cached = recipeCache.get(id)
  if (cached) return Promise.resolve(cached)
  const embedded = userDocsById.get(id)
  if (embedded) {
    recipeCache.set(id, embedded)
    return Promise.resolve(embedded)
  }
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
