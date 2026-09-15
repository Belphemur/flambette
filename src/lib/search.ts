import MiniSearch from 'minisearch'
import { catalog } from './catalog'

/** Document shape indexed by MiniSearch. */
interface SearchDoc {
  /** Variant id — also used as the MiniSearch document id. */
  id: number
  name: string
  /** Space-joined ingredient names (tokenized by MiniSearch). */
  ingredients: string
}

let index: MiniSearch<SearchDoc> | null = null

/**
 * In-memory MiniSearch index over all variant_meta entries, built once on
 * first access after the catalog has loaded. Name is boosted over
 * ingredient names; prefix + fuzzy (0.2) matching for forgiving queries.
 */
export function getSearchIndex(): MiniSearch<SearchDoc> | null {
  const c = catalog.value
  if (!c) return null
  if (!index) {
    index = new MiniSearch<SearchDoc>({
      fields: ['name', 'ingredients'],
      idField: 'id',
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { name: 2 },
      },
    })
    index.addAll(
      c.data.variant_meta.map((meta) => ({
        id: meta.id,
        name: meta.name,
        ingredients: meta.ingredient_names.join(' '),
      })),
    )
  }
  return index
}

/** Variant ids matching the query (raw ids, no facet filtering). */
export function searchVariantIds(query: string): number[] {
  const idx = getSearchIndex()
  if (!idx) return []
  return idx.search(query).map((r) => r.id as number)
}