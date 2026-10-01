<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, Eraser, ShoppingCart, Sparkles, X } from 'lucide-vue-next'
import { useGroceryList } from '../lib/useGroceryList'
import type { GroceryItem } from '../lib/grocery'
import { usePlanStore } from '../stores/plan'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import IngredientAutocomplete from './IngredientAutocomplete.vue'

const plan = usePlanStore()
const router = useRouter()
const { checked, loadError, loading, items, totalCount, checkedCount, sections, ensureDocs, confirmAndClearGrocery } =
  useGroceryList()

/* ---------- Auto-collapse of completed categories ---------- */

/** Sections the user collapsed by hand. */
const manualCollapsed = ref(new Set<string>())
/** Sections collapsed automatically because every item was checked off. */
const autoCollapsed = ref(new Set<string>())

function isCollapsed(name: string): boolean {
  return manualCollapsed.value.has(name) || autoCollapsed.value.has(name)
}

/** Header click: re-open a collapsed section, or collapse an open one. */
function toggleSection(name: string): void {
  if (isCollapsed(name)) {
    const m = new Set(manualCollapsed.value)
    const a = new Set(autoCollapsed.value)
    m.delete(name)
    a.delete(name)
    manualCollapsed.value = m
    autoCollapsed.value = a
  } else {
    manualCollapsed.value = new Set(manualCollapsed.value).add(name)
  }
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
 * Collapse a section the moment it becomes fully checked; re-open it as
 * soon as any item is unchecked. Manual collapses are left alone here —
 * an uncheck re-opens only sections that were auto-collapsed.
 */
watch(sectionDone, (now, prev) => {
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
})

function sectionDoneCount(section: { items: GroceryItem[] }): number {
  return section.items.flatMap((i) => i.lines).filter((l) => !!checked.map[l.key]).length
}

function sectionTotalCount(section: { items: GroceryItem[] }): number {
  return section.items.reduce((n, i) => n + i.lines.length, 0)
}

/* ---------- Custom (free-form) grocery items ---------- */

const customIngredients = useCustomIngredientsStore()

/** Ref of the add form (for the emptyState→list focus handoff, ADR-0014). */
const addForm = ref<InstanceType<typeof IngredientAutocomplete> | null>(null)
/**
 * The add form mounts as the compact empty-state variant first; the first
 * add makes customItems non-empty so that instance unmounts. Hand the
 * keyboard to the freshly mounted main-form instance instead of dropping
 * focus (the bulk-add loop never loses the keyboard, ADR-0014).
 */
watch(
  () => plan.customItems.length > 0 || plan.plan.length > 0,
  () => void nextTick(() => addForm.value?.focus()),
)

/** Remembered store category for an extra row. "Other" (and a missing
 *  memory) is the UNKNOWN bucket, not a real store section — an extra with
 *  no known category renders as a plain row with no tag (ADR-0015). */
function customCategory(item: string): string | undefined {
  const category = customIngredients.find(item)?.category
  if (!category || category === 'Other') return undefined
  return category
}
</script>

<template>
  <section class="space-y-3">
    <div
      v-if="plan.plan.length === 0 && plan.customItems.length === 0"
      class="py-16 text-center text-stone-400"
    >
      <ShoppingCart :size="40" class="mx-auto" aria-hidden="true" />
      <p class="mt-2 font-medium">Nothing to buy yet</p>
      <p class="mt-1 text-sm">Add meals to your plan and the grocery list builds itself.</p>
      <button
        class="mt-4 mb-8 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white"
        @click="router.push('/')"
      >
        Browse recipes
      </button>

      <IngredientAutocomplete ref="addForm" compact />
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
      <!-- Meals planned but every ingredient cleared (phase 9) -->
      <div
        v-if="totalCount === 0 && plan.plan.length > 0"
        class="py-16 text-center text-stone-400"
        data-test="cleared-empty"
      >
        <Sparkles :size="40" class="mx-auto" aria-hidden="true" />
        <p class="mt-2 font-medium">All ingredients cleared.</p>
        <p class="mt-1 text-sm">They'll come back when you plan new recipes.</p>
      </div>

      <template v-else>
        <button
          class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-white shadow-sm active:bg-brand-strong"
          data-test="start-shopping"
          @click="router.push('/shop')"
        >
          <ShoppingCart :size="20" aria-hidden="true" />
          Start shopping
        </button>

        <div
          class="sticky top-12 z-10 -mx-4 flex items-center justify-between border-b dark:border-stone-700 dark:bg-stone-950/95 px-4 py-2 backdrop-blur"
        >
          <p class="text-sm font-semibold" aria-live="polite">
            {{ checkedCount }} / {{ totalCount }} items
          </p>
          <div class="h-1.5 w-24 overflow-hidden rounded-full dark:bg-stone-700">
            <div
              class="h-full rounded-full bg-brand transition-all"
              :style="{ width: totalCount ? `${(checkedCount / totalCount) * 100}%` : '0%' }"
            />
          </div>
          <button
            v-if="checkedCount > 0"
            class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium dark:text-stone-400 dark:hover:bg-stone-700"
            data-test="clear-list"
            aria-label="Clear grocery list"
            @click="confirmAndClearGrocery()"
          >
            <Eraser :size="16" aria-hidden="true" class="mr-1 inline" />
            Clear list
          </button>
        </div>
      </template>

      <!-- EXTRA ITEMS (ADR-0015): the static group for free-form items —
           not part of any planned meal. It renders FIRST (above every real
           store section) with the add-row anchored under its header, and a
           known category is shown as a TAG: the item stays here and is
           never routed into the category section (the user keeps manual
           control of placement). -->
      <div v-if="plan.customItems.length > 0" class="space-y-1.5" data-test="extra-section">
        <h3 class="flex items-center gap-2 px-1 pt-2 text-xs font-bold tracking-wider text-stone-400 uppercase">
          Extra items
          <span class="rounded-full bg-stone-100 px-2 py-px text-[10px] font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-400">
            {{ plan.customItems.length }}
          </span>
        </h3>

        <IngredientAutocomplete ref="addForm" />

        <ul class="divide-y dark:divide-stone-800 rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700">
          <li
            v-for="item in plan.customItems"
            :key="item"
            class="flex min-h-11 items-center gap-3 px-3 py-2"
            data-test="extra-row"
          >
            <label class="flex min-w-0 flex-1 hovercap:cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                class="size-5 shrink-0 accent-brand"
                :checked="!!checked.map[`custom||${item.toLowerCase()}`]"
                @change="checked.toggleChecked(`custom||${item.toLowerCase()}`)"
              />
              <span
                class="min-w-0 truncate text-sm"
                :class="checked.map[`custom||${item.toLowerCase()}`] ? 'text-stone-400 line-through' : ''"
              >{{ item }}</span>
              <!-- Category TAG (ADR-0015): a shrink-0 flex sibling OUTSIDE
                   the truncating name span (never clipped) reading the
                   remembered store category. The item stays in EXTRA
                   ITEMS — this is a label, not a move. -->
              <span
                v-if="customCategory(item)"
                class="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-strong dark:bg-brand/20 dark:text-brand-soft"
                data-test="extra-item-category-tag"
                :aria-label="`Category: ${customCategory(item)} (stays in Extra items)`"
              >#{{ customCategory(item) }}</span>
            </label>
            <button
              class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-rose-600"
              :aria-label="`Remove ${item} from the grocery list`"
              @click="plan.removeCustomItem(item)"
            >
              <X :size="16" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </div>

      <!-- No extras yet: the same add-row, unheaded, at the very top. -->
      <IngredientAutocomplete v-else ref="addForm" />

      <div
        v-for="section in sections"
        :key="section.name"
        class="space-y-1.5"
        data-test="grocery-section"
      >
        <h3 class="pt-2">
          <button
            class="flex w-full items-center justify-between text-left"
            :aria-expanded="!isCollapsed(section.name)"
            :aria-label="`${section.name}: ${sectionDoneCount(section)} of ${sectionTotalCount(section)} checked`"
            data-test="grocery-section-toggle"
            @click="toggleSection(section.name)"
          >
            <span class="text-xs font-bold tracking-wider text-stone-400 uppercase">
              {{ section.name }}
            </span>
            <span class="flex items-center gap-2">
              <span
                class="rounded-full bg-stone-100 px-2 py-px text-[10px] font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-400"
                data-test="section-count-pill"
              >{{ sectionDoneCount(section) }}/{{ sectionTotalCount(section) }}</span>
              <ChevronRight v-if="isCollapsed(section.name)" :size="16" aria-hidden="true" />
              <ChevronDown v-else :size="16" aria-hidden="true" />
            </span>
          </button>
        </h3>
        <ul
          v-if="!isCollapsed(section.name)"
          class="divide-y dark:divide-stone-800 rounded-xl dark:bg-stone-900 ring-1 dark:ring-stone-700"
          data-test="grocery-section-rows"
        >
          <li v-for="item in section.items" :key="item.normalized">
            <div
              v-for="line in item.lines"
              :key="line.key"
              class="flex min-h-11 items-center gap-3 px-3 py-2"
              data-test="grocery-row"
            >
              <label class="flex min-w-0 flex-1 hovercap:cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  class="size-5 shrink-0 accent-brand"
                  :checked="!!checked.map[line.key]"
                  @change="checked.toggleChecked(line.key)"
                />
                <span
                  class="min-w-0 flex-1 truncate text-sm"
                  :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                >
                  <span
                    v-if="line.display"
                    class="mr-1.5 font-medium text-brand-strong"
                    :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''"
                  >{{ line.display }}</span>
                  <span :class="checked.map[line.key] ? 'text-stone-400 line-through' : ''">{{ item.name }}</span>
                </span>
                <!-- Provenance pill: a shrink-0 flex sibling OUTSIDE the
                     truncating span, so the tooltip is never clipped by the
                     name's overflow and the pill can never crowd the text
                     (or the checkbox, which sits at the row's far left). -->
                <span
                  v-if="item.recipes.length > 1"
                  class="group/pill relative inline-flex shrink-0"
                  data-test="provenance-pill"
                  @click.stop
                >
                  <span
                    tabindex="0"
                    role="note"
                    :aria-label="`Used by ${item.recipes.length} planned meals: ${item.recipes.join(', ')}`"
                    class="cursor-help whitespace-nowrap rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-strong outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand/20 dark:text-brand-soft"
                  >{{ item.recipes.length }} recipes</span>
                  <span
                    class="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden w-56 rounded-lg bg-stone-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg group-hover/pill:block group-focus-within/pill:block dark:bg-stone-700"
                  >
                    <span class="block font-semibold">Used by {{ item.recipes.length }} planned meal{{ item.recipes.length === 1 ? '' : 's' }}:</span>
                    {{ item.recipes.join(', ') }}
                  </span>
                </span>
              </label>
            </div>
          </li>
        </ul>
      </div>

      <p class="pt-2 pb-4 text-center text-xs text-stone-400">
        {{ plan.plan.length }} meal{{ plan.plan.length === 1 ? '' : 's' }} ·
        {{ items.length }} ingredients shown
      </p>
    </template>
  </section>
</template>
