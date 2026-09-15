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

    return { plan, planContains, addToPlan, removeFromPlan, setServings, clearPlan }
  },
  {
    persist: { key: 'mealime-planner:v1:plan', pick: ['plan'] },
  },
)