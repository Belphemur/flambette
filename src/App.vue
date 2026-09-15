<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ui, TABS, setTab } from './stores/ui'
import RecipesTab from './components/RecipesTab.vue'
import PlanTab from './components/PlanTab.vue'
import GroceryTab from './components/GroceryTab.vue'
import { getCatalog } from './lib/catalog'

const reload = () => location.reload()

const loading = ref(true)
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    await getCatalog()
    loading.value = false
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-2xl flex-col">
    <header
      class="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur"
    >
      <h1 class="px-4 py-3 text-lg font-bold tracking-tight text-primary-dark">
        🥗 Mealime Planner
      </h1>
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

    <main v-else class="flex-1 px-4 pt-4 pb-28">
      <RecipesTab v-if="ui.tab === 'recipes'" />
      <PlanTab v-else-if="ui.tab === 'plan'" />
      <GroceryTab v-else />
    </main>

    <nav
      class="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white"
      aria-label="Main navigation"
    >
      <div class="mx-auto flex max-w-2xl">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors"
          :class="ui.tab === tab.id ? 'text-primary-dark' : 'text-stone-400'"
          :aria-current="ui.tab === tab.id ? 'page' : undefined"
          @click="setTab(tab.id)"
        >
          <span class="text-xl leading-none">{{ tab.icon }}</span>
          {{ tab.label }}
        </button>
      </div>
    </nav>
  </div>
</template>
