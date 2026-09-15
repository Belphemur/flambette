import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Tab = 'recipes' | 'plan' | 'grocery'

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖' },
  { id: 'plan', label: 'Plan', icon: '📅' },
  { id: 'grocery', label: 'Grocery', icon: '🛒' },
]

/** UI state (active tab + open detail sheet). Not persisted. */
export const useUiStore = defineStore(
  'ui',
  () => {
    const tab = ref<Tab>('recipes')
    /** Variant id of the recipe currently open in the detail sheet, if any. */
    const openRecipeId = ref<number | null>(null)

    function setTab(t: Tab) {
      tab.value = t
      window.scrollTo({ top: 0 })
    }

    return { tab, openRecipeId, setTab }
  },
)