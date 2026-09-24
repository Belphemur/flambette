import { computed, ref, watch } from 'vue'
import { catalog, getRecipe } from './catalog'
import { aggregateGroceries, type GroceryItem } from './grocery'
import { STORE_SECTIONS } from './sections'
import type { RecipeDoc, VariantMeta } from './types'
import { confirmAndClearGrocery } from '../composables/useConfirm'
import { usePlanStore } from '../stores/plan'
import { useGroceryStore } from '../stores/grocery'

/**
 * Shared grocery-list engine for the Grocery tab and Shopping mode:
 * aggregates the planned meals into store-section lines and tracks the
 * checked/total progress.
 */
export function useGroceryList() {
  const plan = usePlanStore()
  const checked = useGroceryStore()

  const docs = ref(new Map<number, RecipeDoc>())
  const loading = ref(false)
  const loadError = ref<string | null>(null)

  const plannedMetas = computed<VariantMeta[]>(() => {
    const c = catalog.value
    if (!c) return []
    return plan.plan.flatMap((entry) => {
      const meta = c.byId.get(entry.variantId)
      return meta ? [meta] : []
    })
  })

  /** Factor per planned meal: planned servings / base recipe servings. */
  const aggregateInputs = computed(() =>
    plannedMetas.value.flatMap((meta) => {
      const doc = docs.value.get(meta.id)
      if (!doc) return []
      return [{ doc, factor: entryServings(meta.id) / doc.serving_count, recipeName: meta.name }]
    }),
  )

  function entryServings(variantId: number): number {
    return plan.plan.find((e) => e.variantId === variantId)?.servings ?? 1
  }

  const items = computed<GroceryItem[]>(() =>
    aggregateInputs.value.length === plannedMetas.value.length && plannedMetas.value.length > 0
      ? aggregateGroceries(aggregateInputs.value)
      : [],
  )

  const totalCount = computed(
    () =>
      items.value.reduce((n, item) => n + item.lines.length, 0) + plan.customItems.length,
  )
  const checkedCount = computed(
    () =>
      items.value.reduce((n, item) => n + item.lines.filter((l) => checked.map[l.key]).length, 0) +
      plan.customItems.filter((i) => checked.map[`custom||${i.toLowerCase()}`]).length,
  )

  /** Sections with items, in canonical order. */
  const sections = computed(() => {
    const bySection = new Map<string, GroceryItem[]>()
    for (const item of items.value) {
      const list = bySection.get(item.section) ?? []
      list.push(item)
      bySection.set(item.section, list)
    }
    return STORE_SECTIONS.filter((s) => bySection.has(s)).map((s) => ({
      name: s,
      items: bySection.get(s)!,
    }))
  })

  async function ensureDocs() {
    const missing = plannedMetas.value.filter((meta) => !docs.value.has(meta.id))
    if (missing.length === 0) {
      loading.value = false
      return
    }
    loading.value = true
    loadError.value = null
    try {
      const loaded = await Promise.all(missing.map((meta) => getRecipe(meta)))
      for (const doc of loaded) {
        docs.value.set(doc.id, doc)
      }
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  watch(plannedMetas, ensureDocs, { immediate: true })

  /* ---------- Clear-grocery workflow ---------- */

  /**
   * Auto-trigger (decision 1): prompt when the user CHECKS the last item.
   *
   * We watch the checkbox map itself, not the computed counts: only a
   * checkbox toggle can fire the prompt. Plan edits that move the counts
   * without a toggle (removing a planned meal, re-adding an item whose
   * persisted key is still checked) must not prompt (qodo finding 2),
   * and having no armed-state means a one-item list checked for the
   * first time prompts correctly (qodo finding 3). A page loaded with
   * everything already checked never self-prompts — its map is untouched
   * until the user toggles something. confirmAndClearGrocery() dedupes
   * concurrent prompts via its module-level guard.
   */
  watch(
    () => checked.map,
    () => {
      const total = totalCount.value
      if (total === 0 || checkedCount.value < total) return
      void confirmAndClearGrocery('All items checked — clear the list?')
    },
    { deep: true },
  )

  return {
    plan,
    checked,
    loading,
    loadError,
    plannedMetas,
    items,
    totalCount,
    checkedCount,
    sections,
    ensureDocs,
    confirmAndClearGrocery,
  }
}
