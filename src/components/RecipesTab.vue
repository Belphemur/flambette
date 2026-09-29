<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowUpDown, Check, Ham, Salad, Shrimp, Drumstick, Star, Vegan, Beef, Fish, Sparkles, Wheat, SearchX } from 'lucide-vue-next'
import type { Component } from 'vue'
import { catalog } from '../lib/catalog'
import {
  DIET_DESCRIPTIONS,
  DIET_IDS,
  DIET_LABELS,
  dietChipLabel,
  dietIndexFor,
  matchesAllDiets,
  type DietId,
} from '../lib/dietFilter'
import {
  PROTEIN_OPTIONS,
  SORT_OPTIONS,
  defaultQuickFilters,
  hasActiveFilters,
  sortLabel,
  type ProteinFilter,
  type QuickFilters,
  type SortBy,
} from '../lib/quickFilters'
import { popularityScore } from '../lib/quantity'
import { searchVariantIds } from '../lib/search'
import type { VariantMeta } from '../lib/types'
import { useFavouritesStore } from '../stores/favourites'
import { useUiStore } from '../stores/ui'
import RecipeCard from './RecipeCard.vue'

/** The search box stays device-local: it is a question, not a household
 *  preference (ADR-0027). Everything below it is shared. */
const query = ref('')

const favourites = useFavouritesStore()
const ui = useUiStore()

/** The ONE filter object (ADR-0027): persisted, and synced in the room. */
const filters = computed<QuickFilters>(() => ui.quickFilters)

/** Replace part of the selection; always a fresh object so the store's
 *  deep watcher (and the room push) sees a change. */
function patchFilters(part: Partial<QuickFilters>) {
  ui.quickFilters = { ...ui.quickFilters, ...part }
}

/* ---------- Diet filter chips (ADR-0018, unified in ADR-0027) ---------- */

/** Whole-catalog verdicts + chip counts, classified once at load time. */
const dietIndex = computed(() => {
  const c = catalog.value
  return c ? dietIndexFor(c.data.variant_meta) : null
})

/** Active diet rules, ANDed together. */
const activeDiets = computed<DietId[]>(() => filters.value.diets)

const dietCounts = computed(() => {
  const counts = {} as Record<DietId, number>
  for (const id of DIET_IDS) counts[id] = dietIndex.value?.counts[id] ?? 0
  return counts
})

function toggleDiet(diet: DietId) {
  const current = [...filters.value.diets]
  const at = current.indexOf(diet)
  if (at === -1) current.push(diet)
  else current.splice(at, 1)
  patchFilters({ diets: current })
}

function setProtein(protein: ProteinFilter) {
  patchFilters({ protein })
}

/* ---------- Sort menu (compact icon+label affordance, WS1/WS5) ---------- */

const sortOpen = ref(false)

function setSort(value: SortBy) {
  patchFilters({ sortBy: value })
  sortOpen.value = false
}

/** Click-away + Escape close; the button itself stops propagation. */
function onDocumentPointerDown(e: PointerEvent) {
  if (!sortOpen.value) return
  const target = e.target as Node | null
  if (target && sortWrapEl.value?.contains(target)) return
  sortOpen.value = false
}

function onDocumentKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') sortOpen.value = false
}

const sortWrapEl = ref<HTMLElement | null>(null)
onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

/** The active sort mode's label, shown on the closed button. */
const sortText = computed(() => sortLabel(filters.value.sortBy))

/* ---------- Icon maps (WS5: one Lucide icon per filter) ---------- */

/** Protein chips carry the food icon; "Any" is a neutral sparkle. */
const PROTEIN_ICONS: Record<ProteinFilter, Component> = {
  '': Sparkles,
  fish: Fish,
  meat: Beef,
  vegetarian: Wheat,
}

const DIET_ICONS: Record<DietId, Component> = {
  'no-pork': Ham,
  'no-shellfish': Shrimp,
  'no-meat': Drumstick,
  vegetarian: Salad,
  vegan: Vegan,
}

/* ---------- Result pipeline ---------- */

const results = computed<VariantMeta[]>(() => {
  const c = catalog.value
  if (!c) return []
  const f = filters.value
  const q = query.value.trim()
  const diets = f.diets
  const index = dietIndex.value

  const facets = (meta: VariantMeta): boolean => {
    if (f.favOnly && !favourites.ids.has(meta.id)) return false
    if (f.proOnly && !meta.is_pro) return false
    if (f.protein !== '' && c.dataById.get(meta.id)?.category_name !== f.protein)
      return false
    if (f.maxTime !== null && meta.cooking_minutes > f.maxTime) return false
    if (diets.length > 0) {
      const verdict = index?.verdictById.get(meta.id)
      if (!verdict || !matchesAllDiets(verdict, diets)) return false
    }
    return true
  }

  let list: VariantMeta[]
  if (q) {
    // Indexed fuzzy/prefix search over name + ingredients, intersected with
    // the active facet filters.
    const matched = new Set(searchVariantIds(q))
    list = c.data.variant_meta.filter((meta) => matched.has(meta.id) && facets(meta))
  } else {
    list = c.data.variant_meta.filter(facets)
  }

  list = [...list]
  switch (f.sortBy) {
    case 'rating':
      list.sort(
        (a, b) => b.rating - a.rating || b.rating_count - a.rating_count,
      )
      break
    case 'time':
      list.sort((a, b) => a.cooking_minutes - b.cooking_minutes)
      break
    case 'calories':
      list.sort((a, b) => a.calories - b.calories)
      break
    case 'popularity':
      list.sort((a, b) => popularityScore(b.popularity) - popularityScore(a.popularity))
      break
    case 'latest':
      // Newest creations first; missing timestamps sink to the bottom.
      list.sort((a, b) => (b.first_published_at ?? 0) - (a.first_published_at ?? 0))
      break
  }
  return list
})

const filtersActive = computed(() => query.value !== '' || hasActiveFilters(filters.value))

function clearFilters() {
  query.value = ''
  ui.quickFilters = defaultQuickFilters()
}

/* ---------- Incremental rendering ---------- */

/** Cards rendered per batch; the rest load in as the sentinel scrolls in. */
const BATCH_SIZE = 60
const visibleCount = ref(BATCH_SIZE)
const visibleResults = computed(() => results.value.slice(0, visibleCount.value))
const hasMore = computed(() => visibleCount.value < results.value.length)

// New filter/search/sort results reset the window back to the first batch.
watch(results, () => {
  visibleCount.value = BATCH_SIZE
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore.value) {
        visibleCount.value = Math.min(visibleCount.value + BATCH_SIZE, results.value.length)
      }
    },
    { rootMargin: '800px' },
  )
  observer.observe(sentinel.value!)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <section class="space-y-3">
    <input
      v-model="query"
      type="search"
      placeholder="Search recipes or ingredients…"
      class="h-11 w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 px-4 text-sm outline-none focus:border-primary"
      aria-label="Search recipes or ingredients"
    />

    <!-- WS1: a 2-column GRID on phones, a wrapping flex row from `sm` up.
         Grid cells never orphan a control on a line of its own, which is
         what `ml-auto` used to do to the sort control on a ~390px screen. -->
    <div
      class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
      data-test="filter-bar"
    >
      <select
        :value="filters.maxTime ?? ''"
        class="h-11 w-full rounded-lg border px-2 text-sm dark:border-stone-700 dark:bg-stone-900 sm:w-auto"
        aria-label="Filter by max cook time"
        data-test="cook-time-filter"
        @change="patchFilters({ maxTime: ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value) })"
      >
        <option value="">Any cook time</option>
        <option :value="20">≤ 20 min</option>
        <option :value="30">≤ 30 min</option>
        <option :value="45">≤ 45 min</option>
      </select>

      <button
        class="flex h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors"
        :class="filters.favOnly ? 'border-amber-400 dark:bg-amber-950 dark:text-amber-300' : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'"
        :aria-pressed="filters.favOnly"
        aria-label="Favourites only"
        data-test="favourites-filter"
        @click="patchFilters({ favOnly: !filters.favOnly })"
      >
        <Star :size="16" :fill="filters.favOnly ? 'currentColor' : 'none'" aria-hidden="true" />
        <span class="truncate">Favourites</span>
      </button>

      <button
        class="h-11 rounded-lg border px-3 text-sm font-bold tracking-wide transition-colors"
        :class="filters.proOnly ? 'border-stone-900 bg-stone-900 text-amber-300' : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'"
        :aria-pressed="filters.proOnly"
        aria-label="PRO recipes only"
        data-test="pro-filter"
        @click="patchFilters({ proOnly: !filters.proOnly })"
      >
        PRO
      </button>

      <!-- Compact sort affordance: icon + current label, never a wide
           native select with "Sort: …" options. -->
      <div ref="sortWrapEl" class="relative">
        <button
          class="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
          aria-haspopup="listbox"
          :aria-expanded="sortOpen"
          aria-label="Sort recipes"
          data-test="sort-button"
          @click="sortOpen = !sortOpen"
        >
          <ArrowUpDown :size="16" aria-hidden="true" />
          <span class="truncate">{{ sortText }}</span>
        </button>
        <ul
          v-if="sortOpen"
          class="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl bg-white py-1 shadow-lg ring-1 dark:bg-stone-800 dark:ring-stone-700"
          role="listbox"
          aria-label="Sort recipes"
          data-test="sort-menu"
        >
          <li v-for="option in SORT_OPTIONS" :key="option.value" role="none">
            <button
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm dark:text-stone-200"
              role="option"
              :aria-selected="filters.sortBy === option.value"
              :aria-label="`Sort by ${option.label}`"
              :data-test="`sort-option-${option.value}`"
              @click="setSort(option.value)"
            >
              <Check
                v-if="filters.sortBy === option.value"
                :size="16"
                class="shrink-0 text-primary"
                aria-hidden="true"
              />
              <span v-else class="w-4 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ option.label }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- WS2: ONE filter surface. The former "All diets" dropdown is gone;
         the protein slice it used to own is the first chip group here, and
         the diet rules follow in the same group. -->
    <div
      class="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Quick filters"
      data-test="quick-filters"
    >
      <button
        v-for="p in PROTEIN_OPTIONS"
        :key="p.value || 'any'"
        type="button"
        :data-test="`protein-chip-${p.value || 'any'}`"
        class="flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors"
        :class="
          filters.protein === p.value
            ? 'border-primary bg-primary text-white'
            : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'
        "
        :aria-pressed="filters.protein === p.value"
        :aria-label="`Protein: ${p.label}`"
        @click="setProtein(p.value)"
      >
        <component :is="PROTEIN_ICONS[p.value]" :size="14" aria-hidden="true" />
        {{ p.label }}
      </button>

      <div
        class="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Diet filters"
        data-test="diet-filters"
      >
        <button
          v-for="d in DIET_IDS"
          :key="d"
          type="button"
          :data-test="`diet-chip-${d}`"
          class="flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors"
          :class="
            activeDiets.includes(d)
              ? 'border-primary bg-primary text-white'
              : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'
          "
          :aria-pressed="activeDiets.includes(d)"
          :aria-label="`${DIET_LABELS[d]}: ${DIET_DESCRIPTIONS[d]}`"
          @click="toggleDiet(d)"
        >
          <component :is="DIET_ICONS[d]" :size="14" aria-hidden="true" />
          {{ dietChipLabel(d, dietCounts[d]) }}
        </button>
      </div>
    </div>

    <p class="text-xs text-stone-400">
      {{ results.length }} recipe{{ results.length === 1 ? '' : 's' }}
      <button
        v-if="filtersActive"
        class="ml-2 text-primary-dark underline"
        @click="clearFilters"
      >
        Clear filters
      </button>
    </p>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <RecipeCard v-for="meta in visibleResults" :key="meta.id" :meta="meta" />
    </div>

    <div
      v-if="hasMore"
      ref="sentinel"
      class="py-4 text-center text-xs text-stone-400"
      aria-live="polite"
    >
      Loading more recipes…
    </div>

    <div v-if="results.length === 0" class="py-16 text-center text-stone-400">
      <SearchX :size="40" class="mx-auto" aria-hidden="true" />
      <p class="mt-2 font-medium">No recipes match your filters</p>
    </div>
  </section>
</template>
