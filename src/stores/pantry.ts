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
 * The ONE row-normalization funnel for data that did not go through
 * `add()` (backup import, localStorage hydration): keep rows with a
 * non-empty string name, re-derive the identity key from the name via
 * `pantryKeyOf` (a persisted/imported `nameKey` is never trusted — a
 * stale or hand-edited key would make a chip display one ingredient
 * while matching another), drop rows whose canonical key is empty,
 * dedupe first-wins by key (the same rule `add()` applies), and apply
 * the cap. Pure; exported for the unit pins.
 */
export function normalizePantryRows(rows: unknown): PantryIngredient[] {
  if (!Array.isArray(rows)) return []
  const out: PantryIngredient[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const name =
      typeof row === 'object' && row !== null && typeof (row as PantryIngredient).name === 'string'
        ? (row as PantryIngredient).name.trim().slice(0, 80)
        : ''
    if (!name) continue
    const nameKey = pantryKeyOf(name)
    if (!nameKey || seen.has(nameKey)) continue
    seen.add(nameKey)
    out.push({ name, nameKey })
    if (out.length >= PANTRY_CAP) break
  }
  return out
}

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

    /** The identity set the pantry lib computes against. Defensive
     *  against a damaged persisted blob (qodo round 2): a non-array or
     *  null entry must never throw while a consumer reads the store —
     *  afterHydrate repairs the list, this keeps the read itself safe. */
    const keys = computed(() => {
      const set = new Set<string>()
      const rows = list.value
      if (Array.isArray(rows)) {
        for (const row of rows) if (row) set.add(row.nameKey)
      }
      return set
    })

    /** True while the ≥1-overlap filter + ranking are live. */
    const active = computed(() => Array.isArray(list.value) && list.value.length > 0)

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

    /** afterHydrate seam: re-run the normalization funnel over whatever
     *  the persisted blob hydrated, so computed consumers (`keys`,
     *  `active`) never see a non-array or a null entry. */
    function repairHydratedRows(): void {
      list.value = normalizePantryRows(list.value)
    }

    /** Replace the list wholesale (backup import): rows are normalized
     *  through the same funnel as hydration — canonical keys derived
     *  from the names, duplicates dropped first-wins, cap applied —
     *  so the store's invariants hold even for hand-edited backups. */
    function replaceAll(rows: PantryIngredient[]): void {
      list.value = normalizePantryRows(rows)
    }

    return { list, keys, active, nameFor, add, remove, clear, replaceAll, repairHydratedRows }
  },
  {
    persist: {
      key: 'mealime-planner:v1:pantry',
      pick: ['list'],
      // A damaged localStorage blob (non-array list, null entries, stale
      // keys) must never throw while the Recipes tab reads the store —
      // hydration normalizes through the same funnel as backup import
      // (qodo round 2). Same seam as grocery.ts/ui.ts afterHydrate.
      afterHydrate: (context) => {
        ;(context.store as unknown as { repairHydratedRows: () => void }).repairHydratedRows()
      },
    },
  },
)
