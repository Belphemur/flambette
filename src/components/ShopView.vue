<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGroceryList } from '../lib/useGroceryList'

const router = useRouter()
const {
  checked,
  loadError,
  loading,
  totalCount,
  checkedCount,
  sections,
  ensureDocs,
  plan,
  confirmAndClearGrocery,
} = useGroceryList()

/** Collapsed store sections (open by default). */
const collapsed = ref(new Set<string>())

function toggleSection(name: string) {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
}

const progressPct = computed(() =>
  totalCount.value ? Math.round((checkedCount.value / totalCount.value) * 100) : 0,
)

function exitShopping() {
  void router.push('/grocery')
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <!-- Sticky progress bar -->
    <div
      class="sticky top-0 z-20 border-b border-stone-200 bg-white/95 backdrop-blur dark:border-stone-700 dark:bg-stone-900/95"
    >
      <div class="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
        <button
          class="flex h-10 shrink-0 items-center rounded-xl border dark:border-stone-700 px-3 text-sm font-medium dark:text-stone-300 active:bg-stone-100 dark:active:bg-stone-800"
          data-test="exit-shopping"
          @click="exitShopping"
        >
          ✕ Exit
        </button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between text-xs">
            <span class="font-semibold" data-test="shopping-progress" aria-live="polite">
              {{ checkedCount }} / {{ totalCount }}
            </span>
            <span class="dark:text-stone-400">{{ progressPct }}%</span>
          </div>
          <div class="mt-1 h-2 overflow-hidden rounded-full dark:bg-stone-700 bg-stone-200">
            <div
              class="h-full rounded-full bg-primary transition-all"
              :style="{ width: `${progressPct}%` }"
            />
          </div>
        </div>
        <button
          v-if="checkedCount > 0"
          class="flex h-10 shrink-0 items-center gap-1 rounded-xl border dark:border-stone-700 px-3 text-sm font-medium dark:text-stone-300 active:bg-stone-100 dark:active:bg-stone-800"
          data-test="clear-list"
          aria-label="Clear grocery list"
          @click="confirmAndClearGrocery()"
        >
          ♻️ Clear list
        </button>
      </div>
    </div>

    <main class="mx-auto w-full max-w-2xl flex-1 px-4 pb-24 pt-4">
      <div v-if="loading && totalCount === 0" class="space-y-2" aria-busy="true">
        <div v-for="i in 6" :key="i" class="h-12 animate-pulse rounded-lg dark:bg-stone-700" />
      </div>

      <div
        v-else-if="loadError"
        class="rounded-xl dark:bg-rose-950 p-4 text-center text-sm dark:text-rose-300"
      >
        <p class="font-medium">Couldn't build the grocery list</p>
        <p class="mt-1 text-xs">{{ loadError }}</p>
        <button class="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-white" @click="ensureDocs">
          Retry
        </button>
      </div>

      <template v-else>
        <!-- Extra (custom) items -->
        <section
          v-if="plan.customItems.length > 0"
          class="mb-6"
          data-test="shop-custom-items"
        >
          <button
            class="flex w-full items-center justify-between rounded-lg py-2 text-left"
            :aria-expanded="!collapsed.has('Extra items')"
            @click="toggleSection('Extra items')"
          >
            <span class="text-lg font-bold tracking-tight">Extra items</span>
            <span class="text-lg dark:text-stone-400" aria-hidden="true">
              {{ collapsed.has('Extra items') ? '▸' : '▾' }}
            </span>
          </button>
          <ul v-if="!collapsed.has('Extra items')" class="divide-y dark:divide-stone-800">
            <li v-for="item in plan.customItems" :key="item">
              <button
                class="flex min-h-16 w-full items-center gap-4 py-2 text-left text-lg"
                :class="checked.map[`custom||${item.toLowerCase()}`] ? 'opacity-40' : ''"
                data-test="shop-row"
                @click="checked.toggleChecked(`custom||${item.toLowerCase()}`)"
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 dark:border-stone-600 text-xl"
                  :class="checked.map[`custom||${item.toLowerCase()}`] ? 'border-primary bg-primary text-white' : ''"
                  aria-hidden="true"
                >
                  {{ checked.map[`custom||${item.toLowerCase()}`] ? '✓' : '' }}
                </span>
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="checked.map[`custom||${item.toLowerCase()}`] ? 'line-through' : ''"
                  >{{ item }}</span
                >
              </button>
            </li>
          </ul>
        </section>

        <!-- Store sections -->
        <section v-for="section in sections" :key="section.name" class="mb-6">
          <button
            class="flex w-full items-center justify-between rounded-lg py-2 text-left"
            :aria-expanded="!collapsed.has(section.name)"
            @click="toggleSection(section.name)"
          >
            <span class="text-lg font-bold tracking-tight">{{ section.name }}</span>
            <span class="text-lg dark:text-stone-400" aria-hidden="true">
              {{ collapsed.has(section.name) ? '▸' : '▾' }}
            </span>
          </button>
          <template v-if="!collapsed.has(section.name)">
            <ul class="divide-y dark:divide-stone-800">
              <!-- Unchecked first (checked items sink), stable within each group -->
              <li
                v-for="entry in [...section.items]
                  .flatMap((item) => item.lines.map((line) => ({ item, line })))
                  .sort((x, y) => Number(!!checked.map[x.line.key]) - Number(!!checked.map[y.line.key]))"
                :key="entry.line.key"
              >
                <button
                  class="flex min-h-16 w-full items-center gap-4 py-2 text-left text-lg"
                  :class="checked.map[entry.line.key] ? 'opacity-40' : ''"
                  data-test="shop-row"
                  @click="checked.toggleChecked(entry.line.key)"
                >
                  <span
                    class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 dark:border-stone-600 text-xl"
                    :class="checked.map[entry.line.key] ? 'border-primary bg-primary text-white' : ''"
                    aria-hidden="true"
                  >
                    {{ checked.map[entry.line.key] ? '✓' : '' }}
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    <span
                      v-if="entry.line.display"
                      class="mr-2 font-semibold text-primary-dark"
                      :class="checked.map[entry.line.key] ? 'text-stone-400' : ''"
                    >{{ entry.line.display }}</span>
                    <span :class="checked.map[entry.line.key] ? 'text-stone-400 line-through' : ''">{{
                      entry.item.name
                    }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </template>
        </section>

        <p
          v-if="totalCount === 0"
          class="py-16 text-center text-stone-400"
          :data-test="plan.plan.length > 0 ? 'cleared-empty' : 'shop-empty'"
        >
          <span class="text-4xl">🛒</span>
          <span class="mt-2 block font-medium">{{
            plan.plan.length > 0
              ? "All ingredients cleared. They'll come back when you plan new recipes."
              : 'The list is empty'
          }}</span>
        </p>
      </template>
    </main>
  </div>
</template>
