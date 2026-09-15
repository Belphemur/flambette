import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Bottom-nav entries, in display order. `to` is the route path. */
export const TABS: { id: string; label: string; icon: string; to: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖', to: '/' },
  { id: 'plan', label: 'Plan', icon: '📅', to: '/plan' },
  { id: 'grocery', label: 'Grocery', icon: '🛒', to: '/grocery' },
]

/**
 * UI state not owned by the router: cooking step positions (survive tab
 * switches within a session) and transient toasts. Not persisted.
 *
 * The active tab, open recipe and cooking mode are router-driven now —
 * see src/router.ts.
 */
export const useUiStore = defineStore(
  'ui',
  () => {
    /** Cooking step index, keyed by variant id (survives tab switches). */
    const cookingStepIndex = ref<Record<number, number>>({})
    /** Transient toast message (e.g. "Enjoy! 🍽"). */
    const toast = ref<string | null>(null)
    let toastTimer: ReturnType<typeof setTimeout> | undefined

    function setCookingStep(variantId: number, step: number) {
      cookingStepIndex.value[variantId] = step
    }

    function cookingStep(variantId: number): number {
      return cookingStepIndex.value[variantId] ?? 0
    }

    function showToast(message: string, ms = 2500) {
      toast.value = message
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toast.value = null), ms)
    }

    return {
      cookingStepIndex,
      toast,
      setCookingStep,
      cookingStep,
      showToast,
    }
  },
)
