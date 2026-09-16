<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { catalog } from '../lib/catalog'
import { popularityScore } from '../lib/quantity'
import { searchVariantIds } from '../lib/search'
import type { VariantMeta } from '../lib/types'
import { useFavouritesStore } from '../stores/favourites'
import RecipeCard from './RecipeCard.vue'

const query = ref('')
const category = ref('all')
const favOnly = ref(false)
const proOnly = ref(false)
const maxTime = ref<number | null>(null)
const sortBy = ref<
  'rating' | 'time' | 'calories' | 'popularity' | 'latest'
>('rating')

const favourites = useFavouritesStore()

const categories = computed(() => catalog.value?.categories ?? [])

const results = computed<VariantMeta[]>(() => {
  const c = catalog.value
  if (!c) return []
  const maxT = maxTime.value
  const q = query.value.trim()

  const facets = (meta: VariantMeta): boolean => {
    if (favOnly.value && !favourites.ids.has(meta.id)) return false
    if (proOnly.value && !meta.is_pro) return false
    if (category.value !== 'all' && c.dataById.get(meta.id)?.category_name !== category.value)
      return false
    if (maxT !== null && meta.cooking_minutes > maxT) return false
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
  switch (sortBy.value) {
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

const filtersActive = computed(
  () => query.value || favOnly.value || proOnly.value || category.value !== 'all' || maxTime.value !== null,
)

function clearFilters() {
  query.value = ''
  category.value = 'all'
  favOnly.value = false
  proOnly.value = false
  maxTime.value = null
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

    <div class="flex flex-wrap items-center gap-2">
      <select
        v-model="category"
        class="h-11 rounded-lg border dark:border-stone-700 dark:bg-stone-900 px-2 text-sm"
        aria-label="Filter by category"
      >
        <option value="all">All diets</option>
        <option v-for="c in categories" :key="c" :value="c" class="capitalize">
          {{ c }}
        </option>
      </select>

      <select
        v-model.number="maxTime"
        class="h-11 rounded-lg border dark:border-stone-700 dark:bg-stone-900 px-2 text-sm"
        aria-label="Filter by max cook time"
      >
        <option :value="null">Any cook time</option>
        <option :value="20">≤ 20 min</option>
        <option :value="30">≤ 30 min</option>
        <option :value="45">≤ 45 min</option>
      </select>

      <button
        class="h-11 rounded-lg border px-3 text-sm font-medium transition-colors"
        :class="favOnly ? 'border-amber-400 dark:bg-amber-950 dark:text-amber-300' : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'"
        :aria-pressed="favOnly"
        @click="favOnly = !favOnly"
      >
        ★ Favourites
      </button>

      <button
        class="h-11 rounded-lg border px-3 text-sm font-medium transition-colors"
        :class="proOnly ? 'border-stone-900 bg-stone-900 text-amber-300' : 'dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'"
        :aria-pressed="proOnly"
        @click="proOnly = !proOnly"
      >
        PRO
      </button>

      <select
        v-model="sortBy"
        class="ml-auto h-11 rounded-lg border dark:border-stone-700 dark:bg-stone-900 px-2 text-sm"
        aria-label="Sort recipes"
      >
        <option value="rating">Sort: Top rated</option>
        <option value="latest">Sort: Latest</option>
        <option value="popularity">Sort: Most popular</option>
        <option value="time">Sort: Quickest</option>
        <option value="calories">Sort: Fewest calories</option>
      </select>
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
      <p class="text-4xl">🔍</p>
      <p class="mt-2 font-medium">No recipes match your filters</p>
    </div>
  </section>
</template>
