import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { VariantMeta } from '../lib/types'

export interface PlanEntry {
  variantId: number
  servings: number
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
      replacePlan,
    }
  },
  {
    persist: { key: 'mealime-planner:v1:plan', pick: ['plan', 'customItems'] },
  },
)