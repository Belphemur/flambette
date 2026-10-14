import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { pantryKeyOf } from '../lib/pantry'

/**
 * One pantry entry: an ingredient the household says it has. Identity is
 * the grocery `nameKey` (ADR-0012 — the ONE ingredient identity rule,
 * ADR-0087 Decision 3); `name` keeps what the user typed/chose so chips
 * and the badge's "Needs 1 more: …" read human spellings.
 */
export interface PantryIngredient {
  name: string
  nameKey: string
}

/** Device-local convenience state, capped like the other device stores. */
const PANTRY_CAP = 500

/**
 * "In my kitchen" pantry (ADR-0087): ingredient nameKeys the Recipes-tab
 * chip row owns, used to filter + rank the catalog by what's on hand.
 *
 * This is DEVICE-LOCAL convenience state, deliberately OUT of the room
 * sync payload (ADR-0087 Decision 7 — same ruling as custom ingredients,
 * ADR-0012: one member's kitchen is not household data). A shared
 * household pantry would be a deliberate payload extension, not this
 * store's default. Registered in STORE_SLICES (backup.ts) in the same
 * change; persisted to localStorage under
 * `mealime-planner:v1:pantry`.
 */
export const usePantryStore = defineStore(
  'pantry',
  () => {
    /** Chip-row order = insertion order (newest last; the badge's
     *  "first missing" and the e2e both read deterministically). */
    const list = ref<PantryIngredient[]>([])

    /** The identity set the pantry lib computes against. */
    const keys = computed(() => new Set(list.value.map((i) => i.nameKey)))

    /** True while the ≥1-overlap filter + ranking are live. */
    const active = computed(() => list.value.length > 0)

    /** Display name for a key (badge's first-missing ingredient). */
    function nameFor(key: string): string {
      return list.value.find((i) => i.nameKey === key)?.name ?? key
    }

    /** Add by ingredient NAME (dedup by nameKey, keep the first name). */
    function add(name: string): boolean {
      const trimmed = name.trim().slice(0, 80)
      if (!trimmed) return false
      const key = pantryKeyOf(trimmed)
      if (!key) return false
      if (list.value.some((i) => i.nameKey === key)) return false
      if (list.value.length >= PANTRY_CAP) return false
      list.value = [...list.value, { name: trimmed, nameKey: key }]
      return true
    }

    function remove(nameKey: string): void {
      list.value = list.value.filter((i) => i.nameKey !== nameKey)
    }

    function clear(): void {
      list.value = []
    }

    /** Replace the list wholesale (backup import — validation ran first). */
    function replaceAll(rows: PantryIngredient[]): void {
      list.value = rows
        .filter(
          (r) =>
            typeof r?.name === 'string' && r.name.length > 0 &&
            typeof r?.nameKey === 'string' && r.nameKey.length > 0,
        )
        .slice(0, PANTRY_CAP)
    }

    return { list, keys, active, nameFor, add, remove, clear, replaceAll }
  },
  {
    persist: { key: 'mealime-planner:v1:pantry', pick: ['list'] },
  },
)
