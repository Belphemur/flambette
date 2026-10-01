<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, ChevronDown, ChevronRight, Eraser, ShoppingCart, X } from 'lucide-vue-next'
import { useGroceryList } from '../lib/useGroceryList'
import IngredientAutocomplete from './IngredientAutocomplete.vue'

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

/* ---------- Auto-collapse of completed categories (ADR-0008 addendum) ---------- */

/** Collapsed store sections (open by default). */
const collapsed = ref(new Set<string>())
/** Sections collapsed automatically because every item was checked off. */
const autoCollapsed = ref(new Set<string>())

function isCollapsed(name: string): boolean {
  return collapsed.value.has(name) || autoCollapsed.value.has(name)
}

function toggleSection(name: string) {
  // A header click always wins over the auto state (like the Grocery
  // tab): clicking an auto-collapsed header re-opens ONLY that category
  // and pins it open until it is done again — other auto-collapsed
  // categories keep their state (qodo 4128519637).
  const next = new Set(collapsed.value)
  if (isCollapsed(name)) {
    next.delete(name)
    if (autoCollapsed.value.has(name)) {
      const auto = new Set(autoCollapsed.value)
      auto.delete(name)
      autoCollapsed.value = auto
    }
  } else {
    next.add(name)
  }
  collapsed.value = next
}

/** A section is "done" when every grocery line under it is checked. */
const sectionDone = computed(() => {
  const m = new Map<string, boolean>()
  for (const s of sections.value) {
    const lines = s.items.flatMap((i) => i.lines)
    m.set(s.name, lines.length > 0 && lines.every((l) => !!checked.map[l.key]))
  }
  return m
})

/**
 * Collapse the category group the moment it becomes fully checked, and
 * re-open it as soon as any line is unchecked — the same transition rule
 * as the Grocery tab (ADR-0008), now extended to the shopping screen.
 *
 * Ordering: this watcher runs flush:'post', i.e. AFTER the checked-sink
 * re-sort (a plain computed) has rendered. The sink moves the last
 * checked row to the bottom of its group; the collapse then hides the
 * whole group, so the header reads N/N for a frame before it hides.
 * Doing it the other way round would hide the group before the sink
 * order settled, and the re-expanded list would come back mid-sink.
 */
watch(
  sectionDone,
  (now, prev) => {
    for (const [name, done] of now) {
      const wasDone = prev?.get(name) ?? false
      if (done && !wasDone) {
        autoCollapsed.value = new Set(autoCollapsed.value).add(name)
      } else if (!done && autoCollapsed.value.has(name)) {
        const next = new Set(autoCollapsed.value)
        next.delete(name)
        autoCollapsed.value = next
      }
    }
  },
  { flush: 'post' },
)

function sectionDoneCount(section: { items: { lines: { key: string }[] }[] }): number {
  return section.items.flatMap((i) => i.lines).filter((l) => !!checked.map[l.key]).length
}

function sectionTotalCount(section: { items: { lines: unknown[] }[] }): number {
  return section.items.reduce((n, i) => n + i.lines.length, 0)
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
      <div class="mx-auto flex max-w-app items-center gap-3 px-4 py-3">
        <button
          class="flex h-10 shrink-0 items-center rounded-xl border dark:border-stone-700 px-3 text-sm font-medium dark:text-stone-300 active:bg-stone-100 dark:active:bg-stone-800"
          data-test="exit-shopping"
          @click="exitShopping"
        >
          <X :size="16" aria-hidden="true" class="mr-1 inline" />
          Exit
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
              class="h-full rounded-full bg-brand transition-all"
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
          <Eraser :size="16" aria-hidden="true" class="mr-1 inline" />
          Clear list
        </button>
      </div>
    </div>

    <main class="mx-auto w-full max-w-app flex-1 px-4 pb-24 pt-4">
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
        <!-- Extra items stay manual-only: they are the user's own scratch
             pad, and a mis-tap on a one-item extra would yank the list. -->
        <section
          v-if="plan.customItems.length > 0"
          class="mb-6"
          data-test="shop-custom-items"
        >
          <button
            class="flex w-full items-center justify-between rounded-lg py-2 text-left"
            :aria-expanded="!collapsed.has('Extra items')"
            data-test="shop-section-toggle"
            @click="toggleSection('Extra items')"
          >
            <span class="text-lg font-bold tracking-tight">Extra items</span>
            <span class="text-lg dark:text-stone-400">
              <ChevronRight v-if="collapsed.has('Extra items')" :size="20" aria-hidden="true" />
              <ChevronDown v-else :size="20" aria-hidden="true" />
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
                  :class="checked.map[`custom||${item.toLowerCase()}`] ? 'border-brand bg-brand text-white' : ''"
                  aria-hidden="true"
                >
                  <Check
                    v-if="checked.map[`custom||${item.toLowerCase()}`]"
                    :size="18"
                  />
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

        <!-- Store sections: auto-collapse on done (ADR-0008 addendum), same
             watcher contract as the Grocery tab, header + count pill stay. -->
        <section
          v-for="section in sections"
          :key="section.name"
          class="mb-6"
          data-test="shop-section"
        >
          <button
            class="flex w-full items-center justify-between rounded-lg py-2 text-left"
            :aria-expanded="!isCollapsed(section.name)"
            :aria-label="`${section.name}: ${sectionDoneCount(section)} of ${sectionTotalCount(section)} checked`"
            data-test="shop-section-toggle"
            @click="toggleSection(section.name)"
          >
            <span class="text-lg font-bold tracking-tight">{{ section.name }}</span>
            <span class="flex items-center gap-2">
              <span
                class="rounded-full bg-stone-100 px-2 py-px text-[10px] font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-400"
                data-test="section-count-pill"
              >{{ sectionDoneCount(section) }}/{{ sectionTotalCount(section) }}</span>
              <span class="text-lg dark:text-stone-400">
                <ChevronRight v-if="isCollapsed(section.name)" :size="20" aria-hidden="true" />
                <ChevronDown v-else :size="20" aria-hidden="true" />
              </span>
            </span>
          </button>
          <template v-if="!isCollapsed(section.name)">
            <ul class="divide-y dark:divide-stone-800" data-test="shop-section-rows">
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
                    :class="checked.map[entry.line.key] ? 'border-brand bg-brand text-white' : ''"
                    aria-hidden="true"
                  >
                    <Check v-if="checked.map[entry.line.key]" :size="18" />
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    <span
                      v-if="entry.line.display"
                      class="mr-2 font-semibold text-brand-strong"
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
          <ShoppingCart :size="40" class="mx-auto" aria-hidden="true" />
          <span class="mt-2 block font-medium">{{
            plan.plan.length > 0
              ? "All ingredients cleared. They'll come back when you plan new recipes."
              : 'The list is empty'
          }}</span>
        </p>

        <!-- Add-item flow (ADR-0012): same autocomplete as the Grocery tab
             — picking a suggestion defaults the category, Enter keeps raw. -->
        <div class="pt-2">
          <IngredientAutocomplete />
        </div>
      </template>
    </main>
  </div>
</template>
