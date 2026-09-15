import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Tab = 'recipes' | 'plan' | 'grocery'

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖' },
  { id: 'plan', label: 'Plan', icon: '📅' },
  { id: 'grocery', label: 'Grocery', icon: '🛒' },
]

/** UI state (active tab, open detail sheet, cooking mode). Not persisted. */
export const useUiStore = defineStore(
  'ui',
  () => {
    const tab = ref<Tab>('recipes')
    /** Variant id of the recipe currently open in the detail sheet, if any. */
    const openRecipeId = ref<number | null>(null)
    /** Variant id of the recipe currently in cooking mode, if any. */
    const cookingRecipeId = ref<number | null>(null)
    /** Current cooking step index, keyed by variant id (survives tab switches). */
    const cookingStepIndex = ref<Record<number, number>>({})
    /** Transient toast message (e.g. "Enjoy! 🍽"). */
    const toast = ref<string | null>(null)
    let toastTimer: ReturnType<typeof setTimeout> | undefined

    function setTab(t: Tab) {
      tab.value = t
      window.scrollTo({ top: 0 })
    }

    /** Enter cooking mode for a recipe; the step position resets on open. */
    function openCooking(variantId: number) {
      cookingRecipeId.value = variantId
      cookingStepIndex.value[variantId] = 0
    }

    function closeCooking() {
      cookingRecipeId.value = null
    }

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
      tab,
      openRecipeId,
      cookingRecipeId,
      cookingStepIndex,
      toast,
      setTab,
      openCooking,
      closeCooking,
      setCookingStep,
      cookingStep,
      showToast,
    }
  },
)