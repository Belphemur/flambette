import { computed, ref, watch } from 'vue'
import { catalog, getRecipe } from './catalog'
import {
  aggregateGroceries,
  aggregateRowKeys,
  clearedLineKey,
  lineKeyIdentity,
  mealSurvivingLines,
  type GroceryItemView,
} from './grocery'
import { localizeQuantity } from './units'
import { STORE_SECTIONS } from './sections'
import { extraCheckedKey } from './extraCheckedKeys'
import type { RecipeDoc, VariantMeta } from './types'
import {
  clearCheckedItems,
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
      const clearedEntries = plan.clearedIngredients[meta.id]
      // ADR-0094 Task-1 bridge: the cleared state is object-shaped in the
      // store; the render filter still consumes the legacy string keys, so
      // the objects are spelled back into `nameKey||basis` keys here until
      // the successor-key filter rewrite lands (the same seam the ADR
      // names for the rewrite).
      const cleared = clearedEntries?.length
        ? new Set(clearedEntries.map(clearedLineKey))
        : undefined
      return [
        {
          doc,
          factor: entryServings(meta.id) / doc.serving_count,
          recipeName: meta.name,
          cleared,
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

  /**
   * Per-meal line counts for the desktop sidebar — derived from the ONE
   * aggregation pass (`aggregateInputs`), never a second walk of the
   * catalog: a sidebar that re-counted would drift from the list the
   * moment a merge rule changed (ADR-0071 Consequences).
   *
   * The count is the meal's SURVIVING line count: an ingredient the
   * household has cleared is dropped by `aggregateGroceries`, so the card
   * must not keep advertising it (a card that says "6 grocery lines" over
   * a list showing two is a lie the reader can check).
   *
   * Empty until every planned meal's doc has loaded, exactly like `items`:
   * the card shows a skeleton rather than a partial count.
   */
  const mealSummaries = computed<MealLineSummary[]>(() => {
    if (aggregateInputs.value.length !== plannedMetas.value.length) return []
    // The merged render's per-group SURVIVING line identities — the same
    // pass `items` runs, so the card and the list share one derivation.
    const visibleIdentitiesByGroup = new Map(
      items.value.map(
        (item) => [item.normalized, new Set(item.lines.map((line) => lineKeyIdentity(line.key)))] as const,
      ),
    )
    return aggregateInputs.value.map((input) => {
      // The lines THIS meal contributes that survive the merged render's
      // visibility (the bare-nameKey skip plus the line-granular clears)
      // — the count cannot disagree with the list by construction.
      const lines = mealSurvivingLines(input, visibleIdentitiesByGroup)
      return {
        id: input.doc.id,
        name: input.recipeName,
        image: input.doc.thumbnail_image_url,
        servings: entryServings(input.doc.id),
        lines,
      }
    })
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
   * Clear-time snapshot (ADR-0092): per-meal row nameKeys PLUS the
   * currently-rendered line keys per ingredient group, both from the ONE
   * aggregation pass. The line keys are what makes clear-checked
   * line-granular (PR #94 round 1): a checked key not in the rendered
   * set is stale residue (a servings change re-spelled it) and is wiped
   * rather than allowed to hide a current line; a nameKey whose group
   * still has unchecked lines stays visible.
   */
  registerClearSnapshotProvider(() => {
    const byVariant: Record<number, string[]> = {}
    for (const { doc, displayLines } of aggregateInputs.value) {
      // The snapshot keys are the SAME keys the aggregation groups on —
      // the shared aggregateRowKeys derivation. A substituted-extra row
      // (an overlay line with no base counterpart, e.g. GF rid 1292's
      // butter lettuce) keys to itself and would never appear in a
      // base-doc-derived snapshot, so Clear would leave it visible while
      // the rest of the meal hides.
      const keys = aggregateRowKeys({ doc, displayLines })
      byVariant[doc.id] = keys.filter((key) => key.length > 0)
    }
    const lineKeysByGroup: Record<string, string[]> = {}
    for (const item of items.value) {
      lineKeysByGroup[item.normalized] = item.lines.map((line) => line.key)
    }
    return { nameKeysByVariant: byVariant, lineKeysByGroup }
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

  /* ---------- Adaptive clear button (ADR-0092) ---------- */

  /**
   * The ONE clear button, shared by GroceryTab and ShopView, adapts to
   * the checked state: with something checked it reads "Clear checked"
   * and removes only those lines (direct, toast-reported); with nothing
   * checked but a non-empty list it reads "Clear list" and keeps the
   * ADR-0005 confirm-modal clear-everything flow — forced past the old
   * `!anythingChecked()` no-op guard, because a button that reads
   * "Clear list" must actually clear.
   *
   * The label text IS the distinguishable state the e2e asserts on.
   * Both views consume this one implementation; never a view copy.
   */
  const clearCheckedActive = computed(() => checkedCount.value > 0)
  const clearButtonLabel = computed(() =>
    clearCheckedActive.value ? 'Clear checked' : 'Clear list',
  )

  function handleClearClick(): void {
    if (clearCheckedActive.value) clearCheckedItems()
    else void confirmAndClearGrocery(undefined, { force: true })
  }

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
    clearCheckedActive,
    clearButtonLabel,
    handleClearClick,
  }
}
