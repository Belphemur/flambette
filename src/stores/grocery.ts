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

    /**
     * Drop ONE key (e.g. an extra that was removed). Extras' checkbox
     * keys are derived from their NAME, so removing an extra must also
     * drop its key — see ADR-0050's addendum: a leftover `custom||<name>`
     * made the re-added row read as already-done and the sub-section
     * watcher collapse the group that had just been emptied.
     */
    function forget(key: string): void {
      if (key in map.value) {
        const next = { ...map.value }
        delete next[key]
        map.value = next
      }
    }

    /** Wipe the whole checkbox map (used by the clear-grocery workflow). */
    function clearAll(): void {
      clearChecked()
    }

    return { map, isChecked, toggleChecked, clearChecked, clearAll, forget }
  },
  {
    persist: { key: 'mealime-planner:v1:checked', pick: ['map'] },
  },
)