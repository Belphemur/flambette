import { reactive, watch } from 'vue'
import type { VariantMeta } from '../lib/types'
import { load, save } from '../lib/storage'

export interface PlanEntry {
  variantId: number
  servings: number
}

/**
 * Meal plan: list of {variantId, servings}. Persisted to localStorage.
 */
const state = reactive<{ plan: PlanEntry[] }>(load('plan', { plan: [] }))

watch(state, (s) => save('plan', { plan: s.plan }), { deep: true })

export const plan = state

export function planContains(variantId: number): boolean {
  return state.plan.some((e) => e.variantId === variantId)
}

export function addToPlan(meta: VariantMeta, servings = meta.serving_count): void {
  const existing = state.plan.find((e) => e.variantId === meta.id)
  if (existing) {
    existing.servings = servings
    return
  }
  state.plan.push({ variantId: meta.id, servings })
}

export function removeFromPlan(variantId: number): void {
  const i = state.plan.findIndex((e) => e.variantId === variantId)
  if (i >= 0) state.plan.splice(i, 1)
}

export function setServings(variantId: number, servings: number): void {
  const entry = state.plan.find((e) => e.variantId === variantId)
  if (entry) entry.servings = Math.max(1, servings)
}

export function clearPlan(): void {
  state.plan.splice(0)
}
