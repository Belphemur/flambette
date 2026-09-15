import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Grocery checkbox state, keyed by grocery line key. Persisted to localStorage
 * under the `mealime-planner:v1:checked` key by pinia-plugin-persistedstate.
 */
export const useGroceryStore = defineStore(
  'grocery',
  () => {
    const map = ref<Record<string, boolean>>({})

    function isChecked(key: string): boolean {
      return map.value[key] === true
    }

    function toggleChecked(key: string): void {
      if (map.value[key]) delete map.value[key]
      else map.value[key] = true
    }

    function clearChecked(): void {
      map.value = {}
    }

    return { map, isChecked, toggleChecked, clearChecked }
  },
  {
    persist: { key: 'mealime-planner:v1:checked', pick: ['map'] },
  },
)