<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDark, useToggle } from '@vueuse/core'
import { TABS, useUiStore } from './stores/ui'
import { getCatalog } from './lib/catalog'
import { decodePlan } from './lib/share'
import { usePlanStore } from './stores/plan'
import { initFavourites } from './stores/favourites'

const reload = () => location.reload()

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const plan = usePlanStore()

/** Dark mode: follows the system preference until the user overrides it
 *  (the override persists in localStorage via useDark). */
const isDark = useDark({
  selector: 'html',
  attribute: 'class',
  valueDark: 'dark',
  valueLight: 'light',
})
const toggleDark = useToggle(isDark)

const loading = ref(true)
const loadError = ref<string | null>(null)

/** Cooking is a fullscreen focus mode: no app header, no bottom nav. */
const isCooking = computed(() => route.name === 'cooking')

/** The recipe detail view is full-bleed (edge-to-edge hero image). */
const isRecipe = computed(() => route.name === 'recipe')

/** Import a shared plan from `?p=` (replaces the current plan). */
async function importSharedPlan() {
  const p = route.query.p
  if (typeof p !== 'string' || p === '') return
  const entries = await decodePlan(p)
  if (entries) {
    plan.replacePlan(entries)
    ui.showToast('Plan loaded from link')
  } else {
    ui.showToast("Couldn't load the shared plan")
  }
  // Strip the param so a reload doesn't re-import (the plan persists).
  void router.replace({ query: {} })
}

onMounted(async () => {
  await router.isReady()
  void importSharedPlan()
  try {
    await getCatalog()
    loading.value = false
    void initFavourites()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-2xl flex-col">
    <header
      v-if="!isCooking"
      class="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur dark:border-stone-700 dark:bg-stone-900/90"
    >
      <div class="flex items-center justify-between px-4 py-2">
        <h1 class="py-1 text-lg font-bold tracking-tight text-primary-dark dark:text-primary">
          🥗 Mealime Planner
        </h1>
        <button
          class="flex size-11 items-center justify-center rounded-full text-xl transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
          :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleDark()"
        >
          <span aria-hidden="true">{{ isDark ? '☀️' : '🌙' }}</span>
        </button>
      </div>
    </header>

    <main v-if="loadError" class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p class="text-4xl">😵</p>
      <p class="font-semibold">Couldn't load the recipe catalog</p>
      <p class="text-sm text-stone-500">{{ loadError }}</p>
      <button class="mt-2 rounded-lg bg-primary px-4 py-2 font-semibold text-white" @click="reload()">
        Retry
      </button>
    </main>

    <main v-else-if="loading" class="flex flex-1 items-center justify-center">
      <div class="size-8 animate-spin rounded-full border-4 border-stone-200 border-t-primary" role="status">
        <span class="sr-only">Loading…</span>
      </div>
    </main>

    <main
      v-else
      class="flex-1"
      :class="isRecipe || isCooking ? '' : 'px-4 pt-4 pb-28'"
    >
      <RouterView v-slot="{ Component }">
        <KeepAlive include="RecipesTab,PlanTab,GroceryTab">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>

    <Transition name="toast">
      <div
        v-if="ui.toast"
        class="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-lg"
        role="status"
      >
        {{ ui.toast }}
      </div>
    </Transition>

    <nav
      v-if="!isCooking"
      class="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900"
      aria-label="Main navigation"
    >
      <div class="mx-auto flex max-w-2xl">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors"
          :class="route.path === tab.to ? 'text-primary-dark' : 'text-stone-400'"
          :aria-current="route.path === tab.to ? 'page' : undefined"
          @click="router.push(tab.to)"
        >
          <span class="text-xl leading-none">{{ tab.icon }}</span>
          {{ tab.label }}
        </button>
      </div>
    </nav>
  </div>
</template>
