import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

/**
 * The serving count a recipe session SEEDS at (ADR-0037): the PLAN
 * entry's count when the recipe is planned, else the remembered default —
 * that exact precedence, ONE helper, so the detail sheet and the cooking
 * view can never seed from two different chains.
 */
export function planServingsFor(variantId: number): number {
  const plan = usePlanStore()
  const ui = useUiStore()
  return plan.plan.find((e) => e.variantId === variantId)?.servings ?? ui.defaultServings
}
