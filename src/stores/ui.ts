import { reactive } from 'vue'

export type Tab = 'recipes' | 'plan' | 'grocery'

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: '📖' },
  { id: 'plan', label: 'Plan', icon: '📅' },
  { id: 'grocery', label: 'Grocery', icon: '🛒' },
]

export const ui = reactive({
  tab: 'recipes' as Tab,
  /** Variant id of the recipe currently open in the detail sheet, if any. */
  openRecipeId: null as number | null,
})

export function setTab(tab: Tab) {
  ui.tab = tab
  window.scrollTo({ top: 0 })
}
