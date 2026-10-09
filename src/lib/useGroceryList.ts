import { computed, ref, watch } from 'vue'
import { catalog, getRecipe } from './catalog'
import {
  aggregateGroceries,
  nameKey,
  type GroceryItemView,
} from './grocery'
import { localizeQuantity } from './units'
import { STORE_SECTIONS } from './sections'
import { extraCheckedKey } from './extraCheckedKeys'
import type { RecipeDoc, VariantMeta } from './types'
import {
  confirmAndClearGrocery,
  registerClearSnapshotProvider,
} from '../composables/useConfirm'
import { usePlanStore } from '../stores/plan'
import { useGroceryStore } from '../stores/grocery'
import { useUiStore } from '../stores/ui'
import { eventsDisplayLines, groceryDisplayLines } from './restrictions'
import { useRestrictions } from '../composables/useRestrictions'

/**
 * Shared grocery-list engine for the Grocery tab and Shopping mode:
 * aggregates the planned meals into store-section lines and tracks the
 * checked/total progress.
 */
export function useGroceryList() {
  const plan = usePlanStore()
  const checked = useGroceryStore()
  const ui = useUiStore()
  // Dietary restrictions (the restriction ADR): the grocery list shows the
  // substituted ingredient names AND quantities from the same source doc
  // (the metric overlay), while every key stays the base doc's (the
  // key/display split).
  const restrictionPrefs = useRestrictions()
  watch(
    () => restrictionPrefs.activeIds.value,
    () => void restrictionPrefs.ensureLoaded(),
  )

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
      const cleared = plan.clearedIngredients[meta.id]
      return [
        {
          doc,
          factor: entryServings(meta.id) / doc.serving_count,
          recipeName: meta.name,
          cleared: cleared?.length ? new Set(cleared) : undefined,
          displayLines:
            eventsDisplayLines(doc, restrictionPrefs.index.value, restrictionPrefs.activeIds.value) ??
            groceryDisplayLines(doc, restrictionPrefs.index.value,
              restrictionPrefs.activeIds.value)
            ?? undefined,
        },
      ]
    }),
  )

  function entryServings(variantId: number): number {
    return plan.plan.find((e) => e.variantId === variantId)?.servings ?? 1
  }

  /** One row of the Grocery tab's Contributing Meals card (ADR-0071). */
  export interface MealLineSummary {
    id: number
    name: string
    /** Thumbnail URL, resolved through the shared `imageSrc` path. */
    image: string
    /** Planned servings for THIS household entry, not the authored ones. */
    servings: number
    /** Grocery lines this meal contributes, from the SAME aggregation pass. */
    lines: number
  }

  /**
   * Per-meal line counts for the desktop sidebar — derived from the ONE
   * aggregation pass (`aggregateInputs`), never a second walk of the
   * catalog: a sidebar that re-counted would drift from the list the
   * moment a merge rule changed (ADR-0071 Consequences).
   *
   * Empty until every planned meal's doc has loaded, exactly like `items`:
   * the card shows a skeleton rather than a partial count.
   */
  const mealSummaries = computed<MealLineSummary[]>(() => {
    if (aggregateInputs.value.length !== plannedMetas.value.length) return []
    return aggregateInputs.value.map((input) => ({
      id: input.doc.id,
      name: input.recipeName,
      image: input.doc.thumbnail_image_url ?? null,
      servings: entryServings(input.doc.id),
      lines: input.displayLines ? input.displayLines.length : input.doc.line_items.length,
    }))
  })

  /** Servings the plan covers — the editorial header's second real count. */
  const totalServings = computed(() =>
    plan.plan.reduce((n, entry) => n + (entry.servings ?? 1), 0),
  )

  /**
   * The aggregated list, PLUS one localized rendering per line (ADR-0047).
   *
   * `display` stays canonical and remains the `checked`-map key basis, so
   * flipping the unit system re-renders the text and changes NO key — a
   * hand-checked item can never uncheck itself, and two household members
   * on different systems keep the same list. Both consumers (Grocery tab
   * and Shop view) read the same `text` from this one pass.
   */
  const items = computed<GroceryItemView[]>(() => {
    if (
      aggregateInputs.value.length !== plannedMetas.value.length ||
      plannedMetas.value.length === 0
    ) {
      return []
    }
    const system = ui.unitSystem
    return aggregateGroceries(aggregateInputs.value).map((item) => ({
      ...item,
      lines: item.lines.map((line) => ({
        ...line,
        text: localizeQuantity(line.display, system),
      })),
    }))
  })

  const totalCount = computed(
    () =>
      items.value.reduce((n, item) => n + item.lines.length, 0) + plan.customItems.length,
  )
  const checkedCount = computed(
    () =>
      items.value.reduce((n, item) => n + item.lines.filter((l) => checked.map[l.key]).length, 0) +
      plan.customItems.filter((i) => checked.map[extraCheckedKey(i)]).length,
  )

  /** Sections with items, in canonical order. */
  const sections = computed(() => {
    const bySection = new Map<string, GroceryItemView[]>()
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
      // Warm the restriction artifacts for whatever is active — no-op when
      // none is; the overlay fetch is lazy and retries on failure.
      void restrictionPrefs.ensureLoaded()
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  watch(plannedMetas, ensureDocs, { immediate: true })

  /* ---------- Clear-grocery workflow ---------- */

  /**
   * Per-meal ingredient snapshot taken at clear time: variantId ->
   * nameKey-normalized keys, from the already-loaded recipe docs.
   */
  registerClearSnapshotProvider(() => {
    const byVariant: Record<number, string[]> = {}
    for (const { doc, displayLines } of aggregateInputs.value) {
      // The snapshot keys are the SAME keys the aggregation groups on —
      // the display rows' keyNames when the restriction seam is active.
      // A substituted-extra row (an overlay line with no base counterpart,
      // e.g. GF rid 1292's butter lettuce) keys to itself and would never
      // appear in a base-doc-derived snapshot, so Clear would leave it
      // visible while the rest of the meal hides.
      const keys = displayLines
        ? displayLines.map((row) => row.keyName)
        : doc.line_items.map((item) => nameKey(item.ingredient_name))
      byVariant[doc.id] = keys.filter((key) => key.length > 0)
    }
    return byVariant
  })

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
      void confirmAndClearGrocery(
        'All items checked — clear the grocery list? Ingredients stay hidden until you cook the meals.',
      )
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
    totalServings,
    mealSummaries,
    sections,
    ensureDocs,
    confirmAndClearGrocery,
  }
}
