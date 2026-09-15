<script setup lang="ts">
import { computed, ref } from 'vue'
import { catalog } from '../lib/catalog'
import { popularityScore } from '../lib/quantity'
import type { VariantMeta } from '../lib/types'
import { favourites } from '../stores/favourites'
import RecipeCard from './RecipeCard.vue'

const query = ref('')
const category = ref('all')
const favOnly = ref(false)
const proOnly = ref(false)
const maxTime = ref<number | null>(null)
const sortBy = ref<'rating' | 'time' | 'calories' | 'popularity'>('rating')

const categories = computed(() => catalog.value?.categories ?? [])

const results = computed<VariantMeta[]>(() => {
  const c = catalog.value
  if (!c) return []
  const q = query.value.trim().toLowerCase()
  const maxT = maxTime.value
  let list = c.data.variant_meta.filter((meta) => {
    if (favOnly.value && !favourites.ids.has(meta.id)) return false
    if (proOnly.value && !meta.is_pro) return false
    if (category.value !== 'all' && c.dataById.get(meta.id)?.category_name !== category.value)
      return false
    if (maxT !== null && meta.cooking_minutes > maxT) return false
    if (q) {
      const inName = meta.name.toLowerCase().includes(q)
      const inIngredients = meta.ingredient_names.some((ing) => ing.toLowerCase().includes(q))
      if (!inName && !inIngredients) return false
    }
    return true
  })
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
</script>

<template>
  <section class="space-y-3">
    <input
      v-model="query"
      type="search"
      placeholder="Search recipes or ingredients…"
      class="h-11 w-full rounded-xl border border-stone-200 bg-white px-4 text-sm outline-none focus:border-primary"
      aria-label="Search recipes or ingredients"
    />

    <div class="flex flex-wrap items-center gap-2">
      <select
        v-model="category"
        class="h-11 rounded-lg border border-stone-200 bg-white px-2 text-sm"
        aria-label="Filter by category"
      >
        <option value="all">All diets</option>
        <option v-for="c in categories" :key="c" :value="c" class="capitalize">
          {{ c }}
        </option>
      </select>

      <select
        v-model.number="maxTime"
        class="h-11 rounded-lg border border-stone-200 bg-white px-2 text-sm"
        aria-label="Filter by max cook time"
      >
        <option :value="null">Any cook time</option>
        <option :value="20">≤ 20 min</option>
        <option :value="30">≤ 30 min</option>
        <option :value="45">≤ 45 min</option>
      </select>

      <button
        class="h-11 rounded-lg border px-3 text-sm font-medium transition-colors"
        :class="favOnly ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-stone-200 bg-white text-stone-600'"
        :aria-pressed="favOnly"
        @click="favOnly = !favOnly"
      >
        ★ Favourites
      </button>

      <button
        class="h-11 rounded-lg border px-3 text-sm font-medium transition-colors"
        :class="proOnly ? 'border-stone-900 bg-stone-900 text-amber-300' : 'border-stone-200 bg-white text-stone-600'"
        :aria-pressed="proOnly"
        @click="proOnly = !proOnly"
      >
        PRO
      </button>

      <select
        v-model="sortBy"
        class="ml-auto h-11 rounded-lg border border-stone-200 bg-white px-2 text-sm"
        aria-label="Sort recipes"
      >
        <option value="rating">Sort: Top rated</option>
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
      <RecipeCard v-for="meta in results" :key="meta.id" :meta="meta" />
    </div>

    <div v-if="results.length === 0" class="py-16 text-center text-stone-400">
      <p class="text-4xl">🔍</p>
      <p class="mt-2 font-medium">No recipes match your filters</p>
    </div>
  </section>
</template>
