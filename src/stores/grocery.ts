import { defineStore } from 'pinia'
import { ref } from 'vue'
import { reconcileCheckedExtras } from '../lib/extraCheckedKeys'

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

    /**
     * Drop checked keys for extras that no longer exist, keeping every
     * other key untouched (recipe-derived line keys included).
     *
     * The guard is the point: `custom||<name>` keys are DERIVED from the
     * extras, so a key with no matching extra is residue from a room
     * snapshot, a backup import or a share link — any of which can carry
     * `customItems` and `checked` out of step. Left alone it reads as
     * "already done", so re-adding that name lands in a sub-section the
     * done-map calls COMPLETE, and ADR-0050's auto-collapse hides the new
     * row. See `src/lib/extraCheckedKeys.ts`.
     *
     * Returns whether anything was dropped, so callers can skip a no-op
     * write (and, in `applyRemote`, avoid an unnecessary republish).
     */
    function reconcileExtras(extras: readonly string[]): boolean {
      const { map: next, changed } = reconcileCheckedExtras(map.value, extras)
      if (changed) map.value = next
      return changed
    }

    /** Wipe the whole checkbox map (used by the clear-grocery workflow). */
    function clearAll(): void {
      clearChecked()
    }

    return {
      map,
      isChecked,
      toggleChecked,
      clearChecked,
      clearAll,
      forget,
      reconcileExtras,
    }
  },
  {
    persist: { key: 'mealime-planner:v1:checked', pick: ['map'] },
  },
)