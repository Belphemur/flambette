import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { VariantMeta } from '../lib/types'

export interface PlanEntry {
  variantId: number
  servings: number
}

/** One "cooked this meal" event, newest first in the history.
 *
 *  One row PER EVENT: cooking the same meal twice appends two rows so
 *  the UI can aggregate a cook count (ADR-0011). Newest first, capped.
 */
export interface CookedEntry {
  variantId: number
  cookedAt: number
  /**
   * Per-device unique id for this cook event. Two phones can cook the same
   * recipe in the same millisecond; (variantId, cookedAt) alone then collides
   * and a merge would drop one. `id` disambiguates them (ADR-0011/0032).
   * Backward-compatible: older rows imported via backup or received from an
   * older peer lack it, and mergeCookedHistory falls back to the pair.
   */
  id?: string
}

/** cookedHistory keeps at most this many entries, newest first. */
const COOKED_HISTORY_CAP = 200
const COOKED_RECENT_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Stable identity key for a cook event: the per-device id when the row
 * carries one, the (variantId, cookedAt) pair otherwise (legacy rows from
 * older peers / imports). Used for BOTH dedupe and the cap tie-break, so
 * the ordering is a total order and every device sorts identically.
 */
export function cookedEventKey(row: CookedEntry): string {
  return row.id ?? `${row.variantId}@${row.cookedAt}`
}

/**
 * Per-JS-context random device nonce backing CookedEntry.id: a reload
 * regenerates it, which is exactly why a bare monotonic counter would
 * collide with ids already persisted on this device or minted by another
 * phone — the nonce makes every session's id space disjoint from every
 * other (time + counter alone would re-collide after a reload while the
 * persisted history keeps its old ids).
 */
const cookDeviceNonce = Math.random().toString(36).slice(2, 10)
let cookIdSeq = 0

/** Mint a globally-unique id for a new cook event (ADR-0032). */
function nextCookedId(): string {
  return `${cookDeviceNonce}-${Date.now().toString(36)}-${cookIdSeq++}`
}

/**
 * Meal plan: list of {variantId, servings}. Persisted to localStorage under
 * the `mealime-planner:v1:plan` key by pinia-plugin-persistedstate.
 */
export const usePlanStore = defineStore(
  'plan',
  () => {
    const plan = ref<PlanEntry[]>([])
    /** Free-form extra grocery items (not tied to any recipe). */
    const customItems = ref<string[]>([])
    /** Cooked history (ADR-0032): shared with the room by default, still
     *  opt-out per device. Part of the shared room state when the user
     *  has the sharing on. */
    const cookedHistory = ref<CookedEntry[]>([])
    /** variantId -> nameKey-normalized ingredient keys cleared from the
     *  grocery list for that meal. Stays until the meal is cooked or
     *  re-planned fresh. Part of the shared room state. */
    const clearedIngredients = ref<Record<number, string[]>>({})

    function planContains(variantId: number): boolean {
      return plan.value.some((e) => e.variantId === variantId)
    }

    function addToPlan(meta: VariantMeta, servings = meta.serving_count): void {
      const existing = plan.value.find((e) => e.variantId === meta.id)
      if (existing) {
        existing.servings = servings
        return
      }
      // Fresh planning = fresh ingredients: forget any cleared snapshot.
      delete clearedIngredients.value[meta.id]
      plan.value.push({ variantId: meta.id, servings })
    }

    function removeFromPlan(variantId: number): void {
      const i = plan.value.findIndex((e) => e.variantId === variantId)
      if (i >= 0) plan.value.splice(i, 1)
    }

    function setServings(variantId: number, servings: number): void {
      const entry = plan.value.find((e) => e.variantId === variantId)
      if (entry) entry.servings = Math.max(1, servings)
    }

    function clearPlan(): void {
      plan.value = []
    }

    /** Add a free-form grocery item (deduped case-insensitively). */
    function addCustomItem(text: string): boolean {
      const t = text.trim().slice(0, 80)
      if (!t) return false
      if (customItems.value.some((i) => i.toLowerCase() === t.toLowerCase())) return false
      customItems.value.push(t)
      return true
    }

    function removeCustomItem(text: string): void {
      const i = customItems.value.indexOf(text)
      if (i >= 0) customItems.value.splice(i, 1)
    }

    /** Empty the free-form grocery items (used by the clear-grocery workflow). */
    function clearCustomItems(): void {
      customItems.value = []
    }

    /**
     * Clear-grocery workflow: snapshot each currently planned meal's
     * ingredient name keys (per-variant maps of nameKey-normalized names,
     * provided by the caller — the grocery engine holds the recipe docs).
     * The cleared ingredients stay hidden in the derived grocery list until
     * the meal is cooked or re-planned fresh.
     */
    function clearIngredientsForCurrentMeals(keysByVariant: Record<number, string[]>): void {
      for (const entry of plan.value) {
        const keys = keysByVariant[entry.variantId]
        if (keys?.length) {
          clearedIngredients.value[entry.variantId] = [...new Set(keys)]
        }
      }
    }

    /** Forget a meal's cleared snapshot (meal re-planned or cooked). */
    function restoreIngredients(variantId: number): void {
      delete clearedIngredients.value[variantId]
    }

    /** Replace the cleared map wholesale (room-sync apply path). */
    function setClearedIngredients(value: Record<number, string[]>): void {
      clearedIngredients.value = value
    }

    /**
     * Mark a meal as cooked: drop it from the plan and record a cooked
     * EVENT in the personal (not room-synced) cooked history, newest
     * first, capped. Every cook appends its own row — the UI aggregates
     * per-variant counts (ADR-0011). Its grocery lines disappear
     * automatically — the list is derived — and its cleared snapshot is
     * forgotten (nothing left to remember).
     */
    function markCooked(variantId: number): void {
      removeFromPlan(variantId)
      restoreIngredients(variantId)
      cookedHistory.value = [
        { variantId, cookedAt: Date.now(), id: nextCookedId() },
        ...cookedHistory.value,
      ].slice(0, COOKED_HISTORY_CAP)
    }

    /** True when the meal was cooked in the last 30 days. */
    function isCookedRecently(variantId: number): boolean {
      const cutoff = Date.now() - COOKED_RECENT_MS
      return cookedHistory.value.some((e) => e.variantId === variantId && e.cookedAt >= cutoff)
    }

    /** Replace the cooked history wholesale (backup import). */
    function replaceCookedHistory(rows: CookedEntry[]): void {
      cookedHistory.value = rows
        .filter((r) => Number.isFinite(r.variantId) && Number.isFinite(r.cookedAt))
        // Preserve the per-device id: a household member's backup restores
        // the SAME event other peers hold under its id, and dropping it
        // here would make the restored copy key by the pair — the next
        // merge would count the event twice. Rows without an id (legacy
        // backups) keep the pair fallback.
        .map((r) => ({
          variantId: r.variantId,
          cookedAt: r.cookedAt,
          ...(r.id !== undefined ? { id: r.id } : {}),
        }))
        .slice(0, COOKED_HISTORY_CAP)
    }

    /**
     * Union an inbound household history into ours (ADR-0032).
     *
     * History is append-only and there is no delete feature, so a
     * peer's SHORTER list is never a statement that our rows should
     * disappear — it only means that peer has cooked less. Since
     * history now syncs by default, every device in a household pushes
     * its own list at once, and the old whole-state replace would let
     * whoever pushed last erase the other phones' cooks. Deduplicated on
     * (variantId, cookedAt), newest first, same cap.
     */
    function mergeCookedHistory(rows: CookedEntry[]): boolean {
      const seen = new Set<string>()
      const merged: CookedEntry[] = []
      // Seed with the CURRENT household view so inbound rows that duplicate
      // what we already hold don't count as "added" and don't get republished.
      for (const row of [...cookedHistory.value]) {
        seen.add(cookedEventKey(row))
        merged.push({ variantId: row.variantId, cookedAt: row.cookedAt, id: row.id })
      }
      // Keys of rows that came in from THIS merge — a row that duplicates a
      // local one is not an addition, and a row the CAP discards must not
      // report an addition either (it would make both devices republish
      // their unchanged history forever: rev ping-pong).
      const inboundKeys = new Set<string>()
      for (const row of rows) {
        if (!Number.isFinite(row.variantId) || !Number.isFinite(row.cookedAt)) continue
        // Prefer the per-device unique id when present (disambiguates two
        // same-recipe cooks on different phones in the same millisecond,
        // which the pair alone collides on). Fall back to (variantId, cookedAt)
        // for rows from older peers / imports that lack it.
        const key = cookedEventKey(row)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push({ variantId: row.variantId, cookedAt: row.cookedAt, id: row.id })
        inboundKeys.add(key)
      }
      // Newest first, with a DETERMINISTIC tie-break: two devices that hold
      // different events with the same boundary timestamp must sort them the
      // same way, or each device keeps its own event at the cap edge and
      // endlessly republishes the other's discard. The event key is unique
      // within the merged list, so this is a total order.
      merged.sort(
        (a, b) =>
          b.cookedAt - a.cookedAt ||
          cookedEventKey(a).localeCompare(cookedEventKey(b)),
      )
      cookedHistory.value = merged.slice(0, COOKED_HISTORY_CAP)
      let added = 0
      for (const row of cookedHistory.value) {
        if (inboundKeys.has(cookedEventKey(row))) added++
      }
      return added > 0
    }

    /** Replace the whole plan (used when importing a shared plan). */
    function replacePlan(entries: PlanEntry[], custom: string[] = []): void {
      plan.value = entries.map((e) => ({
        variantId: e.variantId,
        servings: Math.max(1, Math.round(e.servings)),
      }))
      customItems.value = custom
    }

    return {
      plan,
      customItems,
      planContains,
      addToPlan,
      removeFromPlan,
      setServings,
      clearPlan,
      addCustomItem,
      removeCustomItem,
      clearCustomItems,
      clearIngredientsForCurrentMeals,
      restoreIngredients,
      setClearedIngredients,
      replaceCookedHistory,
      mergeCookedHistory,
      markCooked,
      isCookedRecently,
      replacePlan,
      cookedHistory,
      clearedIngredients,
    }
  },
  {
    persist: {
      key: 'mealime-planner:v1:plan',
      pick: ['plan', 'customItems', 'cookedHistory', 'clearedIngredients'],
    },
  },
)