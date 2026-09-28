import { defineStore } from 'pinia'
import { ref } from 'vue'
import { nameKey } from '../lib/grocery'

/** One remembered free-form ingredient the user typed before. */
export interface CustomIngredient {
  /** Display name as first typed. */
  name: string
  /** Singularized merge key (same rule as grocery aggregation). */
  nameKey: string
  /** Store section picked at add time (defaults to "Other"). */
  category: string
}

/** Device-local memory of typed ingredient names (ADR-0012) — cap. */
const CUSTOM_INGREDIENTS_CAP = 500

/**
 * Custom-ingredient memory: ingredient NAMES the user has typed into any
 * add-item form, persisted so they reappear as suggestions with a "mine"
 * badge on future visits.
 *
 * This is DEVICE-LOCAL convenience state, deliberately OUT of the room
 * sync payload (room state = plan/customItems/checked/cleared only; see
 * ADR-0012) — one household member's typed history is not household data.
 * Persisted to localStorage under `mealime-planner:v1:customIngredients`.
 */
export const useCustomIngredientsStore = defineStore(
  'customIngredients',
  () => {
    /** Newest first. */
    const list = ref<CustomIngredient[]>([])

    /**
     * Remember a typed name (dedup by nameKey, newest kept). When the
     * caller knows the index category for this key it passes it in;
     * unknown names default to "Other".
     */
    function remember(name: string, category?: string): void {
      const trimmed = name.trim().slice(0, 80)
      if (!trimmed) return
      const key = nameKey(trimmed)
      if (!key) return
      // Drop any prior entry for the same key, then prepend (newest first).
      const remaining = list.value.filter((i) => i.nameKey !== key)
      const prior = list.value.find((i) => i.nameKey === key)
      const cat = category ?? prior?.category
      list.value = [{ name: trimmed, nameKey: key, category: cat ?? 'Other' }, ...remaining].slice(
        0,
        CUSTOM_INGREDIENTS_CAP,
      )
    }

    /** Look up a remembered entry by typed text (nameKey match). */
    function find(name: string): CustomIngredient | undefined {
      const key = nameKey(name.trim())
      return list.value.find((i) => i.nameKey === key)
    }

    function forget(nameKey: string): void {
      list.value = list.value.filter((i) => i.nameKey !== nameKey)
    }

    function clear(): void {
      list.value = []
    }

    /** Replace the list wholesale (room-sync or backup import). */
    function replaceAll(rows: CustomIngredient[]): void {
      list.value = rows
        .filter(
          (r) =>
            typeof r?.name === 'string' &&
            typeof r?.nameKey === 'string' &&
            r.nameKey.length > 0 &&
            typeof r?.category === 'string',
        )
        .map((r) => ({ name: r.name, nameKey: r.nameKey, category: r.category }))
        .slice(0, CUSTOM_INGREDIENTS_CAP)
    }

    return { list, remember, find, forget, clear, replaceAll }
  },
  {
    persist: { key: 'mealime-planner:v1:customIngredients', pick: ['list'] },
  },
)
