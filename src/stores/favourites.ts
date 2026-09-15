import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getCatalog } from '../lib/catalog'

/**
 * Favourited variant ids. Seeded from the user's favourites in the data
 * snapshot on first run, persisted to localStorage under the
 * `mealime-planner:v1:favourites` key by pinia-plugin-persistedstate.
 */
export const useFavouritesStore = defineStore(
  'favourites',
  () => {
    const ids = ref(new Set<number>())
    /** True once the store has been seeded/initialized from the catalog. */
    const seeded = ref(false)

    function isFavourite(variantId: number): boolean {
      return ids.value.has(variantId)
    }

    function toggleFavourite(variantId: number): void {
      if (!ids.value.delete(variantId)) ids.value.add(variantId)
    }

    return { ids, seeded, isFavourite, toggleFavourite }
  },
  {
    persist: {
      key: 'mealime-planner:v1:favourites',
      pick: ['ids'],
      // Sets don't round-trip through JSON — persist as an array.
      serializer: {
        serialize: (state) => JSON.stringify([...(state.ids as Set<number>)]),
        deserialize: (raw) => ({ ids: new Set(JSON.parse(raw) as number[]) }),
      },
    },
  },
)

const FAVOURITES_KEY = 'mealime-planner:v1:favourites'

/**
 * Initialize favourites after the catalog loads: if nothing was persisted
 * yet, seed from the snapshot's favourited variants.
 */
export function initFavourites(): Promise<void> {
  return getCatalog().then((catalog) => {
    const store = useFavouritesStore()
    if (localStorage.getItem(FAVOURITES_KEY) === null) {
      store.ids = new Set(catalog.favouriteIds)
    }
    store.seeded = true
  })
}