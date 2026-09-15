import { reactive, watch } from 'vue'
import { getCatalog } from '../lib/catalog'
import { load, save } from '../lib/storage'

/**
 * Favourited variant ids. Seeded from the user's favourites in the data
 * snapshot on first run, persisted to localStorage afterwards.
 */
export const favourites = reactive({
  ids: new Set<number>(),
  seeded: false,
})

export function initFavourites(): Promise<void> {
  return getCatalog().then((catalog) => {
    const stored = load<number[] | null>('favourites', null)
    favourites.ids = new Set(stored ?? catalog.favouriteIds)
    favourites.seeded = true
    watch(
      () => [...favourites.ids],
      (ids) => save('favourites', ids),
    )
  })
}

export function isFavourite(variantId: number): boolean {
  return favourites.ids.has(variantId)
}

export function toggleFavourite(variantId: number): void {
  if (!favourites.ids.delete(variantId)) favourites.ids.add(variantId)
}
