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
import { onMounted, onUnmounted } from 'vue'
import {
  ArrowLeft,
  ChefHat,
  ChevronDown,
  Clock,
  Droplet,
  Flame,
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
    { label: 'Protein', value: m.protein, color: 'bg-emerald-500' },
    { label: 'Carbs', value: m.carbs, color: 'bg-amber-500' },
    { label: 'Fat', value: m.fats, color: 'bg-rose-400' },
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
    class="min-h-full dark:bg-stone-950"
    role="dialog"
    :aria-label="meta.name"
    tabindex="-1"
    @keydown="onKey"
  >
    <div class="relative">
      <img
        :src="imageSrc(meta.presentation_image_url)"
        :alt="meta.name"
        loading="lazy"
        @error="onImgError"
        class="max-h-72 w-full dark:bg-stone-700 object-cover"
      />
      <button
        class="absolute top-3 left-3 flex size-11 items-center justify-center rounded-full dark:bg-stone-900/90 text-lg shadow"
        aria-label="Back"
        @click="close"
      >
        <ArrowLeft :size="20" aria-hidden="true" />
      </button>
      <button
        class="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full dark:bg-stone-900/90 text-xl shadow"
        :aria-label="favourites.isFavourite(meta.id) ? 'Remove from favourites' : 'Add to favourites'"
        @click="favourites.toggleFavourite(meta.id)"
      >
        <Heart
          :size="22"
          aria-hidden="true"
          :fill="favourites.isFavourite(meta.id) ? 'currentColor' : 'none'"
          :class="favourites.isFavourite(meta.id) ? 'text-rose-500' : 'text-stone-400'"
        />
      </button>
    </div>

    <div class="mx-auto max-w-2xl space-y-6 p-4 pb-24">
      <header class="space-y-2">
        <div class="flex items-center gap-2 text-xs dark:text-stone-400">
          <span v-if="meta.is_pro" class="rounded bg-stone-900 px-1.5 py-0.5 font-bold text-amber-300">PRO</span>
          <span class="capitalize">{{ catalog?.dataById.get(meta.id)?.category_name ?? meta.ruleset }}</span>
        </div>
        <h2 class="text-2xl font-bold tracking-tight">{{ meta.name }}</h2>
        <div class="flex items-center gap-2" data-test="recipe-detail-rating">
          <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="20" />
          <span class="text-xs text-stone-400 dark:text-stone-500">rate it for your household</span>
        </div>
        <p class="flex flex-wrap gap-3 text-sm dark:text-stone-400">
          <span class="flex items-center gap-1">
            <Flame :size="14" aria-hidden="true" />{{ Math.round(meta.calories) }} kcal / serving
          </span>
          <span class="flex items-center gap-1">
            <Clock :size="14" aria-hidden="true" />{{ meta.cooking_minutes }} min
          </span>
          <span class="flex items-center gap-1" data-test="serves-label">
            <Utensils :size="14" aria-hidden="true" />serves {{ servings }}
          </span>
          <span v-if="meta.sodium_mg" class="flex items-center gap-1">
            <Droplet :size="14" aria-hidden="true" />{{ Math.round(meta.sodium_mg) }} mg sodium
          </span>
        </p>
        <p
          v-if="cookLine"
          class="text-sm font-medium text-primary-dark dark:text-primary"
          :title="cookLastTitle"
          data-test="cook-history"
        >
          <ChefHat :size="14" aria-hidden="true" class="mr-1 inline align-[-2px]" />{{ cookLine }}
        </p>
        <!-- Per-cook spoiler: one row per cook EVENT, relative AND absolute
             date, so "cooked twice" can be told apart into "last night" and
             "the Sunday before" (ADR-0034). -->
        <div v-if="cookEvents.length" class="mt-1" data-test="cook-history-spoiler">
          <button
            class="flex items-center gap-1 text-xs font-medium text-stone-500 dark:text-stone-400"
            :aria-expanded="cookSpoilerOpen"
            aria-controls="cook-history-events"
            data-test="cook-history-toggle"
            @click="cookSpoilerOpen = !cookSpoilerOpen"
          >
            <ChevronDown
              :size="14"
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
              class="text-xs text-stone-500 dark:text-stone-400"
              data-test="cook-history-event"
            >
              {{ formatRelative(at) }} · {{ formatAbsolute(at) }}
            </li>
          </ul>
        </div>
      </header>

      <!-- Servings + add to plan -->
      <div class="sticky top-0 z-10 -mx-4 border-y dark:border-stone-700 dark:bg-stone-900/95 px-4 py-2 backdrop-blur">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">Servings</span>
            <div class="flex items-center rounded-lg border dark:border-stone-700">
              <button
                class="flex size-11 items-center justify-center text-lg dark:text-stone-300"
                :disabled="servings <= 1"
                aria-label="Fewer servings"
                @click="servings--"
              >
                <Minus :size="18" aria-hidden="true" />
              </button>
              <span class="w-8 text-center text-sm font-semibold">{{ servings }}</span>
              <button
                class="flex size-11 items-center justify-center text-lg dark:text-stone-300"
                :aria-label="`More servings`"
                @click="servings++"
              >
                <Plus :size="18" aria-hidden="true" />
              </button>
            </div>
          </div>
          <button
            class="h-11 flex-1 max-w-48 rounded-xl bg-primary px-4 text-sm font-semibold text-white shadow-sm active:bg-primary-dark"
            @click="addToPlan"
          >
            {{ inPlan ? 'Update in plan' : 'Add to plan' }}
          </button>
        </div>
        <button
          class="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-amber-300 shadow-sm active:bg-stone-800"
          @click="startCooking"
        >
          <ChefHat :size="16" aria-hidden="true" class="mr-1 inline align-[-2px]" />
          Start cooking
        </button>
      </div>

      <!-- Macros -->
      <section class="space-y-2">
        <h3 class="text-sm font-semibold tracking-wide dark:text-stone-400 uppercase">Macro split</h3>
        <div class="space-y-1.5 rounded-xl dark:bg-stone-900 p-4 ring-1 dark:ring-stone-700">
          <div v-for="bar in macroBars" :key="bar.label" class="flex items-center gap-2">
            <span class="w-16 text-xs dark:text-stone-400">{{ bar.label }}</span>
            <div class="h-2.5 flex-1 overflow-hidden rounded-full dark:bg-stone-800">
              <div class="h-full rounded-full" :class="bar.color" :style="{ width: `${Math.round(bar.value * 100)}%` }" />
            </div>
            <span class="w-10 text-right text-xs font-medium">{{ Math.round(bar.value * 100) }}%</span>
          </div>
        </div>
      </section>

      <template v-if="loading">
        <div class="space-y-3">
          <div v-for="i in 3" :key="i" class="h-6 w-2/3 animate-pulse rounded dark:bg-stone-700" />
        </div>
      </template>

      <div v-else-if="loadError" class="rounded-xl dark:bg-rose-950 p-4 text-center text-sm dark:text-rose-300">
        <p class="font-medium">Couldn't load recipe details</p>
        <p class="mt-1 text-xs">{{ loadError }}</p>
        <button class="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-white" @click="loadDoc">Retry</button>
      </div>

      <template v-else-if="doc">
        <!-- Cookwares -->
        <section v-if="doc.cookwares.length">
          <h3 class="mb-2 text-sm font-semibold tracking-wide dark:text-stone-400 uppercase">Cookware</h3>
          <ul class="flex flex-wrap gap-2">
            <li v-for="cw in doc.cookwares" :key="cw.id" class="rounded-full dark:bg-stone-900 px-3 py-1 text-xs ring-1 dark:ring-stone-700">
              {{ cw.name }}
            </li>
          </ul>
        </section>

        <!-- Ingredients -->
        <section>
          <h3 class="mb-2 text-sm font-semibold tracking-wide dark:text-stone-400 uppercase">
            Ingredients ({{ servings }} servings)
          </h3>
          <ul class="divide-y dark:divide-stone-800 rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700">
            <li v-for="item in scaledIngredients" :key="item.id" class="flex gap-3 px-4 py-2.5 text-sm">
              <span class="w-24 shrink-0 font-medium text-primary-dark">{{ item.quantity || '—' }}</span>
              <span>{{ item.ingredient_name }}</span>
            </li>
          </ul>
        </section>

        <!-- Instructions -->
        <section>
          <h3 class="mb-2 text-sm font-semibold tracking-wide dark:text-stone-400 uppercase">Instructions</h3>
          <ol class="space-y-3">
            <li v-for="(step, i) in scaledSteps" :key="i" class="rounded-xl dark:bg-stone-900 p-4 ring-1 dark:ring-stone-700">
              <div class="flex gap-3">
                <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
                  {{ i + 1 }}
                </span>
                <p class="text-sm leading-5">{{ step.primary }}</p>
              </div>
              <ul v-if="step.details.length" class="mt-2 ml-9 space-y-0.5 border-l-2 dark:border-stone-800 pl-3 text-xs dark:text-stone-400">
                <li v-for="(d, j) in step.details" :key="j">{{ d }}</li>
              </ul>
            </li>
          </ol>
        </section>
      </template>
    </div>
  </div>
</template>
