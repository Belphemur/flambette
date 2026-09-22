import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { VariantMeta } from '../lib/types'

export interface PlanEntry {
  variantId: number
  servings: number
}

/** One "cooked this meal" event, newest first in the history. */
export interface CookedEntry {
  variantId: number
  cookedAt: number
}

/** cookedHistory keeps at most this many entries, newest first. */
const COOKED_HISTORY_CAP = 200
const COOKED_RECENT_MS = 30 * 24 * 60 * 60 * 1000

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
    /** Personal cooked-meal history — NOT part of the shared room state. */
    const cookedHistory = ref<CookedEntry[]>([])

    function planContains(variantId: number): boolean {
      return plan.value.some((e) => e.variantId === variantId)
    }

    function addToPlan(meta: VariantMeta, servings = meta.serving_count): void {
      const existing = plan.value.find((e) => e.variantId === meta.id)
      if (existing) {
        existing.servings = servings
        return
      }
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
     * Mark a meal as cooked: drop it from the plan and record it in the
     * personal (not room-synced) cooked history, newest first, capped.
     * Its grocery lines disappear automatically — the list is derived.
     */
    function markCooked(variantId: number): void {
      removeFromPlan(variantId)
      cookedHistory.value = [
        { variantId, cookedAt: Date.now() },
        ...cookedHistory.value.filter((e) => e.variantId !== variantId),
      ].slice(0, COOKED_HISTORY_CAP)
    }

    /** True when the meal was cooked in the last 30 days. */
    function isCookedRecently(variantId: number): boolean {
      const cutoff = Date.now() - COOKED_RECENT_MS
      return cookedHistory.value.some((e) => e.variantId === variantId && e.cookedAt >= cutoff)
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
      markCooked,
      isCookedRecently,
      replacePlan,
      cookedHistory,
    }
  },
  {
    persist: {
      key: 'mealime-planner:v1:plan',
      pick: ['plan', 'customItems', 'cookedHistory'],
    },
  },
)