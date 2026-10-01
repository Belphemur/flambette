<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { catalog, getRecipe } from '../lib/catalog'
import { imageSrc, onImgError } from '../lib/images'
import { scaleQuantity } from '../lib/quantity'
import { scaleSteps, type ScaledStep } from '../lib/recipe'
import type { RecipeDoc, VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useFavouritesStore } from '../stores/favourites'
import RatingStars from './RatingStars.vue'
import { formatAbsolute, formatRelative, useCookHistory } from '../lib/history'
import { ICON_ROLES, ingredientRole } from '../lib/palette'
import HueIcon from './HueIcon.vue'
import { onMounted, onUnmounted } from 'vue'
import {
  ArrowLeft,
  ChefHat,
  ChevronDown,
  Clock,
  Heart,
  Minus,
  Plus,
  Utensils,
} from 'lucide-vue-next'

const plan = usePlanStore()
const favourites = useFavouritesStore()
const router = useRouter()

/** Recipe variant id, passed as a route prop from /recipe/:id. */
const props = defineProps<{ id: number }>()

const doc = ref<RecipeDoc | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const servings = ref(1)

const meta = computed<VariantMeta | null>(
  () => catalog.value?.byId.get(props.id) ?? null,
)

/** Categorical ingredient-TYPE hue beside the category name (ADR-0035). */
const typeRole = computed(() =>
  ingredientRole(catalog.value?.dataById.get(props.id)?.category_name),
)

/** Scale factor for ingredients/instructions vs. the recipe's base servings. */
const factor = computed(() => (doc.value ? servings.value / doc.value.serving_count : 1))

const scaledIngredients = computed(() => {
  if (!doc.value) return []
  return doc.value.line_items.map((item) => ({
  ...item,
  quantity: scaleQuantity(item.quantity, factor.value),
  }))
})

const scaledSteps = computed<ScaledStep[]>(() =>
  doc.value ? scaleSteps(doc.value, factor.value) : [],
)

const macroBars = computed(() => {
  const m = meta.value?.macros
  if (!m) return []
  return [
  // Macro bars stay on the BRAND ramp only: a green "protein" bar would
  // collide with the vegetarian food hue, which means "this is a
  // vegetarian dish", and energy/sodium hues are reserved for the facts
  // that already wear them.
  { label: 'Protein', value: m.protein, color: 'bg-brand' },
  { label: 'Carbs', value: m.carbs, color: 'bg-brand-soft' },
  { label: 'Fat', value: m.fats, color: 'bg-brand/40' },
  ]
})

const inPlan = computed(() => (meta.value ? plan.planContains(meta.value.id) : false))

/** Personal cooked history (this device only, ADR-0011). */
const cooked = useCookHistory()
const cookCount = computed(() => (meta.value ? cooked.count(meta.value.id) : 0))
/**
 * Every cook EVENT of this recipe, newest first (ADR-0034). The count line
 * above answers "how often"; the spoiler below answers "when exactly",
 * which the per-variant aggregate has already thrown away. Collapsed by
 * default: it is a detail, not a headline.
 */
const cookEvents = computed(() => (meta.value ? cooked.events(meta.value.id) : []))
const cookSpoilerOpen = ref(false)
const cookLine = computed(() => {
  if (cookCount.value === 0) return null
  const times = cookCount.value === 1 ? '1 time' : `${cookCount.value} times`
  const last = meta.value ? cooked.last(meta.value.id) : null
  return last ? `Cooked ${times} · last ${formatRelative(last)}` : `Cooked ${times}`
})
const cookLastTitle = computed(() => {
  const last = meta.value ? cooked.last(meta.value.id) : null
  return last ? `Last cooked ${formatAbsolute(last)}` : undefined
})

async function loadDoc() {
  if (!meta.value) return
  loading.value = true
  loadError.value = null
  doc.value = null
  servings.value = meta.value.serving_count
  try {
  doc.value = await getRecipe(meta.value)
  } catch (e) {
  loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
  loading.value = false
  }
}

watch(
  meta,
  (m) => {
  if (m) void loadDoc()
  },
  { immediate: true },
)

/** Back to wherever the user came from; deep links fall back to `/`. */
function close() {
  if (window.history.state?.back) router.back()
  else router.replace('/')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function addToPlan() {
  if (!meta.value) return
  plan.addToPlan(meta.value, servings.value)
}

/** Cooking is plan-driven: head to the gated /cooking/:id route. */
function startCooking() {
  if (!meta.value) return
  void router.push({ name: 'cooking', params: { id: String(meta.value.id) } })
}
</script>

<template>
  <div
  v-if="meta"
  class="min-h-full"
  role="dialog"
  :aria-label="meta.name"
  tabindex="-1"
  @keydown="onKey"
  >
  <div class="mx-auto max-w-app px-4 pt-4 pb-24">
  <!-- Desktop composes the photograph BESIDE the introduction and the
  action panel (DESIGN.md Layout); the photograph stops being a
  shallow screen-wide ribbon. On phones the same cells simply
  stack in the order photo -> intro -> actions -> sections. -->
  <div
  class="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start"
  data-test="detail-hero"
  >
  <figure class="relative -mx-4 lg:mx-0">
  <img
  :src="imageSrc(meta.presentation_image_url)"
  :alt="meta.name"
  loading="lazy"
  @error="onImgError"
  class="aspect-[4/3] w-full object-cover lg:rounded-xl"
  />
  <!-- Solid espresso discs over the photo (DESIGN.md Elevation):
  the contrast never depends on the photograph's brightness. -->
  <button
  class="absolute top-3 left-3 flex size-11 items-center justify-center rounded-full bg-surface-dark text-text-dark shadow"
  aria-label="Back"
  @click="close"
  >
  <ArrowLeft :size="20" aria-hidden="true" />
  </button>
  <button
  class="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full bg-surface-dark shadow"
  :aria-label="favourites.isFavourite(meta.id) ? 'Remove from favourites' : 'Add to favourites'"
  :aria-pressed="favourites.isFavourite(meta.id)"
  @click="favourites.toggleFavourite(meta.id)"
  >
  <Heart
  :size="22"
  aria-hidden="true"
  :fill="favourites.isFavourite(meta.id) ? 'currentColor' : 'none'"
  :class="favourites.isFavourite(meta.id) ? 'text-favourite-soft' : 'text-text-dark'"
  />
  </button>
  </figure>

  <div class="space-y-4">
  <header class="space-y-3">
  <div class="flex items-center gap-2 text-label-md text-text-muted">
  <span
  v-if="meta.is_pro"
  class="rounded bg-surface-dark px-1.5 py-0.5 font-bold text-warning-soft"
  >PRO</span
  >
  <!-- Type icon only: no redundant category word beside an
  already informative icon (DESIGN.md Components). The
  icon is role="img" with the category as its name, and
  the text survives only for a category we have no hue
  for, so an unrecognised type is never silently
  dropped. -->
  <HueIcon
  v-if="typeRole"
  :role="typeRole"
  :size="18"
  :label="ICON_ROLES[typeRole].label"
  />
  <span v-else class="capitalize">{{
  catalog?.dataById.get(meta.id)?.category_name ?? meta.ruleset
  }}</span>
  </div>
  <h2 class="text-headline-md sm:text-headline-lg" data-test="detail-title">
  {{ meta.name }}
  </h2>
  <div class="flex flex-wrap items-center gap-3" data-test="recipe-detail-rating">
  <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="20" />
  <span class="text-label-md text-text-muted">rate it for your household</span>
  <span class="flex items-center gap-1 text-label-md text-text-muted" data-test="serves-label">
  <Utensils :size="16" aria-hidden="true" />serves {{ servings }}
  </span>
  </div>
  <p
  v-if="cookLine"
  class="text-sm font-medium text-brand-text"
  :title="cookLastTitle"
  data-test="cook-history"
  >
  <ChefHat :size="16" aria-hidden="true" class="mr-1 inline align-[-2px]" />{{ cookLine }}
  </p>
  <!-- Per-cook spoiler: one row per cook EVENT, relative AND absolute
  date, so "cooked twice" can be told apart into "last night" and
  "the Sunday before" (ADR-0034). -->
  <div v-if="cookEvents.length" data-test="cook-history-spoiler">
  <button
  class="flex items-center gap-1 text-label-md font-medium text-text-muted"
  :aria-expanded="cookSpoilerOpen"
  aria-controls="cook-history-events"
  data-test="cook-history-toggle"
  @click="cookSpoilerOpen = !cookSpoilerOpen"
  >
  <ChevronDown
  :size="16"
  aria-hidden="true"
  class="transition-transform"
  :class="cookSpoilerOpen ? '' : '-rotate-90'"
  />
  {{ cookSpoilerOpen ? 'Hide' : 'Show' }} cook history
  </button>
  <ul
  v-if="cookSpoilerOpen"
  id="cook-history-events"
  class="mt-1 space-y-0.5"
  data-test="cook-history-events"
  >
  <li
  v-for="(at, i) in cookEvents"
  :key="`${at}-${i}`"
  class="text-label-md text-text-muted"
  data-test="cook-history-event"
  >
  {{ formatRelative(at) }} · {{ formatAbsolute(at) }}
  </li>
  </ul>
  </div>
  </header>

  <!-- Action panel (DESIGN.md Selection and actions): ONE filled
  primary CTA, 48px tall, white label, with the dark-theme
  keyline. Add/Update in plan is a real outlined secondary
  action. Not sticky: a sticky bar here would sit under the
  app header and cover the content it is meant to serve. -->
  <div
  class="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  data-test="detail-actions"
  >
  <div class="flex items-center justify-between gap-3">
  <span class="text-sm font-medium">Servings</span>
  <div class="flex items-center rounded-lg ring-1 ring-border-strong">
  <button
  class="flex size-11 items-center justify-center text-lg"
  :disabled="servings <= 1"
  aria-label="Fewer servings"
  @click="servings--"
  >
  <Minus :size="18" aria-hidden="true" />
  </button>
  <span class="w-8 text-center text-sm font-semibold tabular-nums">{{
  servings
  }}</span>
  <button
  class="flex size-11 items-center justify-center text-lg"
  :aria-label="`More servings`"
  @click="servings++"
  >
  <Plus :size="18" aria-hidden="true" />
  </button>
  </div>
  </div>
  <button
  class="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-base font-semibold text-on-brand shadow-sm active:bg-brand-strong dark:ring-1 dark:ring-brand-soft"
  data-test="start-cooking"
  @click="startCooking"
  >
  <ChefHat :size="18" aria-hidden="true" />Start cooking
  </button>
  <button
  class="flex h-11 w-full items-center justify-center rounded-lg bg-surface-raised px-4 text-sm font-semibold text-brand-text ring-1 ring-border-strong active:bg-surface-sunken"
  data-test="add-to-plan"
  @click="addToPlan"
  >
  {{ inPlan ? 'Update in plan' : 'Add to plan' }}
  </button>
  </div>
  </div>
  </div>

  <!-- Nutrition comes AFTER the actions, never ahead of them
  (DESIGN.md Recipe detail). Units and the supplied sodium are
  kept: only the compact browse cards drop sodium. -->
  <section class="mt-6" data-test="nutrition">
  <h3 class="mb-2 text-body-sm font-semibold">Nutrition</h3>
  <div class="rounded-xl bg-surface-sunken p-4">
  <p class="flex flex-wrap gap-4 text-body-sm">
  <span class="flex items-center gap-1.5">
  <HueIcon role="energy" :size="18" />
  <span class="tabular-nums">{{ Math.round(meta.calories) }} kcal / serving</span>
  </span>
  <span class="flex items-center gap-1.5">
  <Clock :size="18" aria-hidden="true" />
  <span class="tabular-nums">{{ meta.cooking_minutes }} min</span>
  </span>
  <span v-if="meta.sodium_mg" class="flex items-center gap-1.5" data-test="nutrition-sodium">
  <HueIcon role="sodium" :size="18" />
  <span class="tabular-nums">{{ Math.round(meta.sodium_mg) }} mg sodium</span>
  </span>
  </p>
  <div class="mt-3 space-y-1.5">
  <div v-for="bar in macroBars" :key="bar.label" class="flex items-center gap-2">
  <span class="w-16 text-label-md">{{ bar.label }}</span>
  <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
  <div
  class="h-full rounded-full"
  :class="bar.color"
  :style="{ width: `${Math.round(bar.value * 100)}%` }"
  />
  </div>
  <span class="w-10 text-right text-label-md font-medium tabular-nums">{{
  Math.round(bar.value * 100)
  }}%</span>
  </div>
  </div>
  </div>
  </section>

  <template v-if="loading">
  <div class="mt-6 space-y-3">
  <div v-for="i in 3" :key="i" class="h-6 w-2/3 animate-pulse rounded bg-surface-sunken" />
  </div>
  </template>

  <div
  v-else-if="loadError"
  class="mt-6 rounded-xl bg-surface p-4 text-center text-sm"
  data-test="detail-error"
  >
  <p class="font-medium text-danger">Couldn't load recipe details</p>
  <p class="mt-1 text-xs text-text-muted">{{ loadError }}</p>
  <button
  class="mt-2 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand"
  @click="loadDoc"
  >
  Retry
  </button>
  </div>

  <template v-else-if="doc">
  <!-- Cookwares -->
  <section v-if="doc.cookwares.length" class="mt-6">
  <h3 class="mb-2 text-body-sm font-semibold">Cookware</h3>
  <ul class="flex flex-wrap gap-2">
  <li
  v-for="cw in doc.cookwares"
  :key="cw.id"
  class="rounded-full bg-surface-sunken px-3 py-1 text-label-md"
  >
  {{ cw.name }}
  </li>
  </ul>
  </section>

  <!-- Ingredients + Instructions (DESIGN.md Layout): the ingredient
  list is a reference beside the prose at roughly 1:1.5, instead
  of one 1100px ribbon. Below `lg` it is the phone layout. -->
  <div
  class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:items-start"
  data-test="detail-columns"
  >
  <section>
  <h3 class="mb-2 text-body-sm font-semibold">
  Ingredients ({{ servings }} servings)
  </h3>
  <ul class="divide-y divide-border rounded-xl bg-surface-raised ring-1 ring-border">
  <li
  v-for="item in scaledIngredients"
  :key="item.id"
  class="flex gap-3 px-4 py-2.5 text-body-sm"
  >
  <span class="w-24 shrink-0 font-medium text-brand-text tabular-nums">{{
  item.quantity || '—'
  }}</span>
  <span>{{ item.ingredient_name }}</span>
  </li>
  </ul>
  </section>

  <section>
  <h3 class="mb-2 text-body-sm font-semibold">Instructions</h3>
  <ol class="space-y-3">
  <li
  v-for="(step, i) in scaledSteps"
  :key="i"
  class="rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  >
  <div class="flex gap-3">
  <span
  class="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-on-brand"
  >
  {{ i + 1 }}
  </span>
  <p class="text-body-md">{{ step.primary }}</p>
  </div>
  <ul
  v-if="step.details.length"
  class="mt-2 ml-9 space-y-0.5 border-l-2 border-border pl-3 text-body-sm text-text-muted"
  >
  <li v-for="(d, j) in step.details" :key="j">{{ d }}</li>
  </ul>
  </li>
  </ol>
  </section>
  </div>
  </template>
  </div>
  </div>
</template>
