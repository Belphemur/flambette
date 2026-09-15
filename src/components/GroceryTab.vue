<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { catalog, getRecipe } from '../lib/catalog'
import { aggregateGroceries, type GroceryItem } from '../lib/grocery'
import { STORE_SECTIONS } from '../lib/sections'
import type { RecipeDoc, VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useGroceryStore } from '../stores/grocery'

const plan = usePlanStore()
const checked = useGroceryStore()
const router = useRouter()

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
    return [{ doc, factor: entryServings(meta.id) / doc.serving_count }]
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

const totalCount = computed(() => items.value.reduce((n, item) => n + item.lines.length, 0))
const checkedCount = computed(
  () => items.value.reduce((n, item) => n + item.lines.filter((l) => checked.map[l.key]).length, 0),
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
</script>

<template>
  <section class="space-y-3">
    <div v-if="plan.plan.length === 0" class="py-16 text-center text-stone-400">
      <p class="text-4xl">🛒</p>
      <p class="mt-2 font-medium">Nothing to buy yet</p>
      <p class="mt-1 text-sm">Add meals to your plan and the grocery list builds itself.</p>
      <button
        class="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
        @click="router.push('/')"
      >
        Browse recipes
      </button>
    </div>

    <template v-else-if="loading && items.length === 0">
      <div class="space-y-2" aria-busy="true">
        <div v-for="i in 6" :key="i" class="h-10 animate-pulse rounded-lg dark:bg-stone-700" />
      </div>
    </template>

    <div v-else-if="loadError" class="rounded-xl dark:bg-rose-950 p-4 text-center text-sm dark:text-rose-300">
      <p class="font-medium">Couldn't build the grocery list</p>
      <p class="mt-1 text-xs">{{ loadError }}</p>
      <button class="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-white" @click="ensureDocs">Retry</button>
    </div>

    <template v-else>
      <div
        class="sticky top-12 z-10 -mx-4 flex items-center justify-between border-b dark:border-stone-700 dark:bg-stone-950/95 px-4 py-2 backdrop-blur"
      >
        <p class="text-sm font-semibold" aria-live="polite">
          {{ checkedCount }} / {{ totalCount }} items
        </p>
        <div class="h-1.5 w-24 overflow-hidden rounded-full dark:bg-stone-700">
          <div
            class="h-full rounded-full bg-primary transition-all"
            :style="{ width: totalCount ? `${(checkedCount / totalCount) * 100}%` : '0%' }"
          />
        </div>
        <button
          v-if="checkedCount > 0"
          class="rounded-lg px-2 py-1 text-xs font-medium dark:text-stone-400 hover:dark:bg-stone-700"
          @click="checked.clearChecked"
        >
          Clear checked
        </button>
      </div>

      <div v-for="section in sections" :key="section.name" class="space-y-1.5">
        <h3 class="px-1 pt-2 text-xs font-bold tracking-wider text-stone-400 uppercase">
          {{ section.name }}
        </h3>
        <ul class="divide-y dark:divide-stone-800 overflow-hidden rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700">
          <li v-for="item in section.items" :key="item.normalized">
            <div
              v-for="line in item.lines"
              :key="line.key"
              class="flex min-h-11 items-center gap-3 px-3 py-2"
            >
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  class="size-5 shrink-0 accent-primary"
                  :checked="!!checked.map[line.key]"
                  @change="checked.toggleChecked(line.key)"
                />
                <span
                  class="min-w-0 truncate text-sm"
                  :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                >
                  <span
                    v-if="line.display"
                    class="mr-1.5 font-medium text-primary-dark"
                    :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                  >{{ line.display }}</span>
                  <span :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''">{{ item.name }}</span>
                </span>
              </label>
            </div>
          </li>
        </ul>
      </div>

      <p class="pt-2 pb-4 text-center text-xs text-stone-400">
        {{ plan.plan.length }} meal{{ plan.plan.length === 1 ? '' : 's' }} ·
        {{ items.length }} ingredients
      </p>
    </template>
  </section>
</template>
