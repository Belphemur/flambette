<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, X } from '@lucide/vue'
import AppModal from './AppModal.vue'
import { aisleIcon } from '../lib/aisleRole'
import { bucketFor } from '../lib/sections'
import { aggregateGroceries, lineKeyIdentity, nameKey as groceryNameKey } from '../lib/grocery'
import { imageSrc } from '../lib/images'
import { localizeQuantity } from '../lib/units'
import { catalog, getRecipe } from '../lib/catalog'
import { loadIngredientDetail, type IngredientDetail } from '../lib/ingredientDetail'
import { eventsDisplayLines, groceryDisplayLines } from '../lib/restrictions'
import { useRestrictions } from '../composables/useRestrictions'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'
import { useQtyOverridesStore } from '../stores/groceryQtyOverrides'

/**
 * The ingredient detail sheet (ADR-0100) — a READING surface, hosted ONCE
 * (App.vue) off the ui store's ephemeral prompt slot: mobile a bottom
 * sheet on the AppModal machinery, at `lg:` a centered ~480px card on the
 * SAME static Level-3 espresso scrim. No route, no SEO surface.
 *
 * Structure per the adopted Stitch render (project 2725470430841257407,
 * screen 3911e1af46314353b8b8818d8ab767c7 — the BASE layout is the
 * contract): grab handle → title row (display name + merged amounts in
 * the mono data voice + close X) → height-capped photo band → the
 * "Photo: TheMealDB" credit directly under it → "Need a substitute?" as
 * ONE prose line on a surface-sunken card → "You'll use this in…" recipe
 * rows (circular thumbnail + name + chevron; tap navigates to
 * `/recipe/:id` and closes) → tonal full-width Done.
 *
 * The deck is deliberately INFORMATIONAL: no checkboxes, no second fill,
 * no invented metadata — the rejected render fictions (seasonality pill,
 * per-row prep meta, custom shadow, animated scrim, mock copy) do not
 * appear here. Substitutes are PROSE and never re-key grocery lines
 * (ADR-0094's checked-key invariants stay untouched); they hide when the
 * corpus has no row, as does the photo band (which becomes the ADR-0076
 * aisle glyph + hue — the credit hides WITH the photo).
 *
 * The "You'll use this in…" lookup is DERIVED at open time from the plan
 * store + catalog docs (nameKey match over the plan's recipes) — cheap,
 * offline, no new store. The merged amounts in the header are the SAME
 * aggregation render the badge shows (the one display vocabulary).
 */

const props = defineProps<{
  /** The ephemeral prompt: which ingredient row was tapped. */
  prompt: { nameKey: string; displayName: string }
}>()

const emit = defineEmits<{ close: [] }>()

const plan = usePlanStore()
const ui = useUiStore()
const qtyOverrides = useQtyOverridesStore()
const router = useRouter()
// The restriction seam, so the aggregated amounts in the header render
// EXACTLY what the grocery line renders when a restriction display is
// active — the same input, the same derivation.
const restrictions = useRestrictions()

/* ---------- The ADR-0099 corpus (lazy, single-flight) ---------- */

const detail = ref<IngredientDetail | null>(null)
/** A broken local webp degrades to the aisle glyph, never a broken img. */
const imageFailed = ref(false)
watch(
  () => props.prompt.nameKey,
  async (nameKey) => {
    imageFailed.value = false
    detail.value = null
    try {
      detail.value = await loadIngredientDetail(nameKey)
    } catch {
      detail.value = {} // the artifact failed to load: all sections hide
    }
  },
  { immediate: true },
)

const hasImage = computed(() => !!detail.value?.imageSrc && !imageFailed.value)

/* ---------- Plan lookup (derived at open time) ---------- */

const plannedMetas = computed(() => {
  const c = catalog.value
  if (!c) return []
  return plan.plan.flatMap((entry) => {
    const meta = c.byId.get(entry.variantId)
    return meta ? [meta] : []
  })
})

/** Recipe docs for the planned meals, loaded only while the sheet is up. */
const docs = ref(new Map<number, Awaited<ReturnType<typeof getRecipe>>>())
const stopDocLoad = watch(
  () => [props.prompt.nameKey, plannedMetas.value.map((m) => m.id).join(',')] as const,
  async () => {
    const missing = plannedMetas.value.filter((meta) => !docs.value.has(meta.id))
    if (missing.length === 0) return
    try {
      const loaded = await Promise.all(missing.map((meta) => getRecipe(meta)))
      const next = new Map(docs.value)
      for (const doc of loaded) next.set(doc.id, doc)
      docs.value = next
    } catch {
      /* offline/degraded: the rows stay empty, nothing throws */
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => stopDocLoad())

const loadingRows = computed(
  () => plannedMetas.value.length > 0 && docs.value.size < plannedMetas.value.length,
)

/**
 * The sheet's aggregation — the grocery list's OWN input (restriction
 * display included) so the header's amounts are the badge's amounts by
 * construction, filtered to the sheets's nameKey.
 */
const group = computed(() => {
  const c = catalog.value
  if (!c) return null
  const inputs = plannedMetas.value.flatMap((meta) => {
    const doc = docs.value.get(meta.id)
    if (!doc) return []
    const servings = plan.plan.find((e) => e.variantId === meta.id)?.servings ?? 1
    const cleared = plan.clearedIngredients[meta.id]
    return [
      {
        doc,
        factor: servings / doc.serving_count,
        recipeName: meta.name,
        cleared: cleared?.length ? cleared : undefined,
        displayLines:
          eventsDisplayLines(doc, restrictions.index.value, restrictions.activeIds.value) ??
          groceryDisplayLines(doc, restrictions.index.value, restrictions.activeIds.value) ??
          undefined,
      },
    ]
  })
  if (inputs.length === 0 || inputs.length !== plannedMetas.value.length) return null
  return aggregateGroceries(inputs).find((item) => item.normalized === props.prompt.nameKey) ?? null
})

/** Merged amounts — the SAME strings the row's badge renders (ADR-0100:
 *  the badge's `text`, quantity override applied per line identity). */
const amounts = computed(() => {
  const g = group.value
  if (!g) return ''
  const system = ui.unitSystem
  const overrides = qtyOverrides.map
  return g.lines
    .map((line) => {
      const override = overrides[lineKeyIdentity(line.key)]
      return override !== undefined
        ? localizeQuantity(override, system)
        : localizeQuantity(line.display, system)
    })
    .filter(Boolean)
    .join(' · ')
})

/**
 * Recipe ROWS (circular thumbnail + name + chevron): derived from the
 * planned metas whose doc carries the nameKey — meta data for the name /
 * thumbnail (the same fields the recipe cards render).
 */
const recipeRows = computed(() => {
  const key = props.prompt.nameKey
  return plannedMetas.value
    .filter((meta) => {
      const doc = docs.value.get(meta.id)
      return doc && doc.line_items.some((li) => groceryNameKey(li.ingredient_name) === key)
    })
    .map((meta) => ({ id: meta.id, name: meta.name, thumb: imageSrc(meta.thumbnail_image_url) }))
})

/** Aisle glyph + hue fallback (ADR-0076) when the corpus has no image. */
const aisle = computed(() => {
  const section = group.value?.section ?? bucketFor(props.prompt.displayName)
  return aisleIcon(section)
})

function openRecipe(id: number): void {
  emit('close')
  void router.push(`/recipe/${id}`)
}

function dismiss(): void {
  emit('close')
}
</script>

<template>
  <AppModal
    dialog-label="Ingredient details"
    overlay-class="z-50 flex items-end justify-center modal-scrim p-0 lg:items-center lg:p-4"
    panel-class="mx-auto max-h-[85dvh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-surface lg:max-w-[480px] lg:rounded-2xl"
    panel-test="ingredient-detail"
    overlay-test="ingredient-detail-overlay"
    @close="dismiss"
  >
    <!-- Grab handle: the bottom sheet's affordance; the desktop card has
         no drag semantics. -->
    <div class="pt-2 lg:hidden" aria-hidden="true">
      <span class="mx-auto block h-1 w-10 rounded-full bg-border-strong" />
    </div>

    <!-- Title row: display name + the merged amounts (mono data voice,
    the SAME merged amounts the row's badge renders) + close X. -->
    <div class="flex items-start justify-between gap-3 px-4 pt-3 lg:px-5 lg:pt-4">
      <div class="min-w-0">
        <h2 class="truncate text-lg font-bold tracking-tight text-text" data-test="ingredient-detail-name">
          {{ prompt.displayName }}
        </h2>
        <p
          v-if="amounts"
          class="mt-0.5 font-mono-data text-label-sm tabular-nums text-text-muted"
          data-test="ingredient-detail-amount"
        >
          {{ amounts }}
        </p>
      </div>
      <button
        type="button"
        class="flex size-9 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken"
        aria-label="Close ingredient details"
        data-test="ingredient-detail-close"
        @click="dismiss"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </div>

    <!-- Photo band: full-width, height-capped, lazy webp from the offline
    corpus (AD-0099: never an external host). -->
    <div v-if="hasImage" class="px-4 pt-3 lg:px-5">
      <img
        :src="detail!.imageSrc"
        alt=""
        loading="lazy"
        class="max-h-56 w-full rounded-xl bg-surface-sunken object-contain"
        data-test="ingredient-detail-image"
        @error="imageFailed = true"
      />
      <!-- Credit: PART of the sheet (ADR-0099 owner directive) — directly
      under the photo, hides WITH it. -->
      <p
        class="mt-1 font-mono-data text-label-sm text-text-muted"
        data-test="ingredient-detail-credit"
      >
        {{ detail!.credit }}
      </p>
    </div>
    <!-- No image: the aisle glyph + hue stands in (ADR-0076); no credit
    band without a photo (attribution belongs to the photo only). -->
    <div v-else class="px-4 pt-3 lg:px-5">
      <div
        class="flex h-24 w-full items-center justify-center rounded-xl bg-surface-sunken"
        data-test="ingredient-detail-glyph"
      >
        <component
          :is="aisle?.glyph"
          v-if="aisle"
          :size="36"
          :class="aisle.className"
          aria-hidden="true"
        />
      </div>
    </div>

    <!-- "Need a substitute?" — ONE prose line on a surface-sunken card.
    Informational only (ADR-0100): never chips, never re-keying lines.
    Hidden when the corpus has no row for this nameKey. -->
    <div v-if="detail?.substitutes?.length" class="px-4 pt-3 lg:px-5">
      <div class="rounded-xl bg-surface-sunken px-3 py-2.5" data-test="ingredient-detail-subs">
        <p class="text-label-sm font-semibold text-text">Need a substitute?</p>
        <p class="mt-0.5 text-body-sm text-text">{{ detail.substitutes.join(' · ') }}</p>
      </div>
    </div>

    <!-- "You'll use this in…" — compact tappable rows into the plan's
    recipes. Derived at open time from the plan + catalog docs; loading
    states stay real (a skeleton while docs land, nothing invented). -->
    <div class="px-4 pt-4 lg:px-5">
      <h3 class="text-label-md font-semibold text-text">You'll use this in…</h3>
      <div v-if="recipeRows.length > 0" class="mt-2 space-y-1.5">
        <button
          v-for="row in recipeRows"
          :key="row.id"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg bg-surface-sunken p-2 text-left transition-colors hover:bg-surface-raised"
          data-test="ingredient-detail-recipe-row"
          @click="openRecipe(row.id)"
        >
          <img
            :src="row.thumb"
            :alt="''"
            loading="lazy"
            class="size-10 shrink-0 rounded-full bg-surface-raised object-cover"
          />
          <span class="min-w-0 flex-1 truncate text-label-md font-semibold text-text">
            {{ row.name }}
          </span>
          <ChevronRight :size="16" aria-hidden="true" class="shrink-0 text-text-muted" />
        </button>
      </div>
      <div v-else-if="loadingRows" class="mt-2 space-y-1.5" aria-busy="true">
        <div v-for="i in 2" :key="i" class="h-14 animate-pulse rounded-lg bg-surface-sunken" />
      </div>
      <p v-else class="mt-2 text-body-sm text-text-muted">
        Not part of the current plan's recipes.
      </p>
    </div>

    <!-- The single action: tonal full-width Done (a reading surface's
    close, never a fill). -->
    <div class="px-4 pb-6 pt-4 lg:px-5">
      <button
        type="button"
        class="h-11 w-full rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand active:bg-brand-strong"
        data-test="ingredient-detail-done"
        @click="dismiss"
      >
        Done
      </button>
    </div>
  </AppModal>
</template>
