import { usePlanStore } from '../stores/plan'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { useUiStore } from '../stores/ui'

/**
 * The ONE add action behind every grocery add surface (ADR-0014):
 * persist the free-form item, remember the typed name + category
 * device-locally (ADR-0012), and confirm with the "Added to <Category>"
 * toast. Returns false (no toast) when the item is a duplicate — the
 * list already carries it, so there is nothing new to confirm.
 */
export function useAddGroceryItem() {
  const plan = usePlanStore()
  const customIngredients = useCustomIngredientsStore()
  const ui = useUiStore()

  return function addGroceryItem(name: string, category: string): boolean {
    const added = plan.addCustomItem(name)
    // Remember (or upgrade) the typed name + category even when the item
    // is already on the list — re-adding with a different category is the
    // user correcting the memory (ADR-0012/0014).
    customIngredients.remember(name, category)
    if (added) ui.showToast(`Added to ${category}`, { kind: 'added' })
    return added
  }
}
