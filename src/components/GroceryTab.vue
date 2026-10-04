<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, Eraser, ShoppingCart, Sparkles, X } from 'lucide-vue-next'
import { useGroceryList } from '../lib/useGroceryList'
import { extraCollapseKey, groupExtras, storeCollapseKey } from '../lib/extraSections'
import type { GroceryItem } from '../lib/grocery'
import { usePlanStore } from '../stores/plan'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import IngredientAutocomplete from './IngredientAutocomplete.vue'

const plan = usePlanStore()
const router = useRouter()
const { checked, loadError, loading, items, totalCount, checkedCount, sections, ensureDocs, confirmAndClearGrocery } =
  useGroceryList()

/* ---------- Auto-collapse of completed categories ---------- */

/**
 * Collapse state is keyed by a NAMESPACED key, not a bare section name:
 * an extras sub-section and a store section can share a name (both have a
 * "Produce"), and toggling one must never collapse the other
 * (extraCollapseKey / storeCollapseKey, ADR-0050 §5).
 */
const manualCollapsed = ref(new Set<string>())
/** Sections collapsed automatically because every item was checked off. */
const autoCollapsed = ref(new Set<string>())

function isCollapsed(key: string): boolean {
  return manualCollapsed.value.has(key) || autoCollapsed.value.has(key)
}

/** Header click: re-open a collapsed section, or collapse an open one. */
function toggleSection(key: string): void {
  if (isCollapsed(key)) {
  const m = new Set(manualCollapsed.value)
  const a = new Set(autoCollapsed.value)
  m.delete(key)
  a.delete(key)
  manualCollapsed.value = m
  autoCollapsed.value = a
  } else {
  manualCollapsed.value = new Set(manualCollapsed.value).add(key)
  }
}

/**
 * A section is "done" when every grocery line under it is checked.
 * ONE done-map feeds ONE watcher for BOTH consumers (store sections and,
 * from ADR-0050, the extras sub-sections) — a second collapse
 * implementation would be a copy that silently diverges.
 */
const sectionDone = computed(() => {
  const m = new Map<string, boolean>()
  for (const s of sections.value) {
  const lines = s.items.flatMap((i) => i.lines)
  m.set(sectionKey(s.name), lines.length > 0 && lines.every((l) => !!checked.map[l.key]))
  }
  // The SAME done-map also carries the extras sub-sections (ADR-0050), so
  // ONE watcher drives both lists' auto-collapse (ADR-0008's rule).
  for (const g of extraGroups.value) {
  m.set(extraKey(g.name), g.items.length > 0 && extraDoneCount(g) === g.items.length)
  }
  return m
})

/**
 * Collapse a section the moment it becomes fully checked; re-open it as
 * soon as any item is unchecked. Manual collapses are left alone here —
 * an uncheck re-opens only sections that were auto-collapsed.
 */
watch(sectionDone, (now, prev) => {
  for (const [key, done] of now) {
  const wasDone = prev?.get(key) ?? false
  if (done && !wasDone) {
  autoCollapsed.value = new Set(autoCollapsed.value).add(key)
  } else if (!done && autoCollapsed.value.has(key)) {
  const next = new Set(autoCollapsed.value)
  next.delete(key)
  autoCollapsed.value = next
  }
  }
})

/** Collapse key for a recipe-derived store section (ADR-0050 §5). */
function sectionKey(name: string): string {
  return storeCollapseKey(name)
}

/** Collapse key for an extras sub-section (ADR-0050 §5). */
function extraKey(name: string): string {
  return extraCollapseKey(name)
}

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

/**
 * Extras grouped into their own category sub-sections (ADR-0050). The
 * grouping is a PURE lib function, unit-tested next to `grocery.ts` —
 * only the per-extra memory lookup lives here.
 *
 * The categories come from `customIngredients`, which is DEVICE-LOCAL and
 * out of the room sync payload (ADR-0012), so a second household device
 * may render the same shared extras under different sub-sections (or all
 * under Uncategorized). Pre-existing behaviour, now visible by design.
 */
const extraGroups = computed(() =>
  groupExtras(
    plan.customItems.map((name) => ({ name, category: customIngredients.find(name)?.category })),
  ),
)

/** Checkbox key for an extra row (shared by the row and the done-map). */
function extraCheckedKey(item: string): string {
  return `custom||${item.toLowerCase()}`
}

/** How many of a sub-section's extras are checked off. */
function extraDoneCount(group: { items: { name: string }[] }): number {
  return group.items.filter((i) => !!checked.map[extraCheckedKey(i.name)]).length
}
</script>

<template>
  <section class="space-y-3">
  <div
  v-if="plan.plan.length === 0 && plan.customItems.length === 0"
  class="py-16 text-center text-text-muted"
  >
  <ShoppingCart :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">Nothing to buy yet</p>
  <p class="mt-1 text-sm">Add meals to your plan and the grocery list builds itself.</p>
  <button
  class="mt-4 mb-8 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand"
  @click="router.push('/')"
  >
  Browse recipes
  </button>

  <IngredientAutocomplete ref="addForm" compact />
  </div>

  <template v-else-if="loading && items.length === 0">
  <div class="space-y-2" aria-busy="true">
  <div v-for="i in 6" :key="i" class="h-10 animate-pulse rounded-lg bg-surface-sunken" />
  </div>
  </template>

  <div v-else-if="loadError" class="rounded-xl bg-surface p-4 text-center text-sm text-danger">
  <p class="font-medium">Couldn't build the grocery list</p>
  <p class="mt-1 text-xs">{{ loadError }}</p>
  <button class="mt-2 rounded-lg bg-brand px-3 py-1.5 text-on-brand" @click="ensureDocs">Retry</button>
  </div>

  <template v-else>
  <!-- Meals planned but every ingredient cleared (phase 9) -->
  <div
  v-if="totalCount === 0 && plan.plan.length > 0"
  class="py-16 text-center text-text-muted"
  data-test="cleared-empty"
  >
  <Sparkles :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">All ingredients cleared.</p>
  <p class="mt-1 text-sm">They'll come back when you plan new recipes.</p>
  </div>

  <template v-else>
  <button
  class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-on-brand shadow-sm active:bg-brand-strong"
  data-test="start-shopping"
  @click="router.push('/shop')"
  >
  <ShoppingCart :size="20" aria-hidden="true" />
  Start shopping
  </button>

  <!-- Solid surface, real border: DESIGN.md bans translucent control
  surfaces, and without a fill the rows scrolled behind this toolbar
  showed straight through the progress text. -->
  <div
  class="sticky top-12 z-10 -mx-4 flex items-center justify-between border-b border-border bg-surface px-4 py-2"
  >
  <p class="text-sm font-semibold" aria-live="polite">
  {{ checkedCount }} / {{ totalCount }} items
  </p>
  <div class="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken">
  <div
  class="h-full rounded-full bg-brand transition-all"
  :style="{ width: totalCount ? `${(checkedCount / totalCount) * 100}%` : '0%' }"
  />
  </div>
  <button
  v-if="checkedCount > 0"
  class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium"
  data-test="clear-list"
  aria-label="Clear grocery list"
  @click="confirmAndClearGrocery()"
  >
  <Eraser :size="16" aria-hidden="true" class="mr-1 inline" />
  Clear list
  </button>
  </div>
  </template>

  <!-- EXTRA ITEMS (ADR-0015 -> ADR-0050): the group for free-form items --
  not part of any planned meal. It renders FIRST (above every real store
  section) with the add-row anchored under its header, and it is a VIEW:
  inside it, extras are grouped into their OWN category sub-sections
  (Produce, ..., Uncategorized last) with the same count pill, chevron and
  auto-collapse as a store section.
  A sub-section is NEVER a move (ADR-0015 2, still in force): an extra
  tagged Produce lives in the extras group's Produce sub-section and must
  not appear in the recipe-derived Produce store section below. -->
  <div v-if="plan.customItems.length > 0" class="space-y-1.5" data-test="extra-section">
  <h3 class="flex items-center gap-2 px-1 pt-2 text-xs font-bold tracking-wider text-text-muted uppercase">
  Extra items
  <span class="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-text-muted">
  {{ plan.customItems.length }}
  </span>
  </h3>

  <IngredientAutocomplete ref="addForm" />

  <div
  v-for="group in extraGroups"
  :key="group.name"
  class="space-y-1.5"
  data-test="extra-subsection"
  :data-extra-category="group.name"
  >
  <h3 class="pt-2">
  <button
  class="flex w-full items-center justify-between text-left"
  :aria-expanded="!isCollapsed(extraKey(group.name))"
  :aria-label="`${group.name}: ${extraDoneCount(group)} of ${group.items.length} checked`"
  data-test="extra-subsection-toggle"
  @click="toggleSection(extraKey(group.name))"
  >
  <span class="text-xs font-bold tracking-wider text-text-muted uppercase">
  {{ group.name }}
  </span>
  <span class="flex items-center gap-2">
  <span
  class="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-text-muted"
  data-test="section-count-pill"
  >{{ extraDoneCount(group) }}/{{ group.items.length }}</span>
  <ChevronRight v-if="isCollapsed(extraKey(group.name))" :size="16" aria-hidden="true" />
  <ChevronDown v-else :size="16" aria-hidden="true" />
  </span>
  </button>
  </h3>
  <ul
  v-if="!isCollapsed(extraKey(group.name))"
  class="divide-y rounded-xl ring-1"
  data-test="extra-subsection-rows"
  >
  <li
  v-for="item in group.items"
  :key="item.name"
  class="flex min-h-11 items-center gap-3 px-3 py-2"
  data-test="extra-row"
  >
  <label class="flex min-w-0 flex-1 hovercap:cursor-pointer items-center gap-3">
  <input
  type="checkbox"
  class="size-5 shrink-0 accent-brand"
  :checked="!!checked.map[extraCheckedKey(item.name)]"
  @change="checked.toggleChecked(extraCheckedKey(item.name))"
  />
  <!-- No per-row category tag (ADR-0050 7): the sub-section heading
  directly above IS the category, so a #Produce pill here would only
  repeat it. The heading carries the accessible name instead. -->
  <span
  class="min-w-0 truncate text-sm"
  :class="checked.map[extraCheckedKey(item.name)] ? 'text-text-muted line-through' : ''"
  >{{ item.name }}</span>
  </label>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-favourite"
  :aria-label="`Remove ${item.name} from the grocery list`"
  @click="plan.removeCustomItem(item.name)"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </li>
  </ul>
  </div>
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
  :aria-expanded="!isCollapsed(sectionKey(section.name))"
  :aria-label="`${section.name}: ${sectionDoneCount(section)} of ${sectionTotalCount(section)} checked`"
  data-test="grocery-section-toggle"
  @click="toggleSection(sectionKey(section.name))"
  >
  <span class="text-xs font-bold tracking-wider text-text-muted uppercase">
  {{ section.name }}
  </span>
  <span class="flex items-center gap-2">
  <span
  class="rounded-full bg-surface-sunken px-2 py-px text-[10px] font-semibold text-text-muted"
  data-test="section-count-pill"
  >{{ sectionDoneCount(section) }}/{{ sectionTotalCount(section) }}</span>
  <ChevronRight v-if="isCollapsed(sectionKey(section.name))" :size="16" aria-hidden="true" />
  <ChevronDown v-else :size="16" aria-hidden="true" />
  </span>
  </button>
  </h3>
  <ul
  v-if="!isCollapsed(sectionKey(section.name))"
  class="divide-y rounded-xl ring-1"
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
  :class="checked.map[line.key] ? 'text-text-muted line-through' : ''"
  >
  <span
  v-if="line.text"
  class="mr-1.5 font-medium text-brand-text"
  :class="checked.map[line.key] ? 'text-text-muted line-through' : ''"
  >{{ line.text }}</span>
  <span :class="checked.map[line.key] ? 'text-text-muted line-through' : ''">{{ item.name }}</span>
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
  class="cursor-help whitespace-nowrap rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-text outline-none focus-visible:ring-2 focus-visible:ring-brand"
  >{{ item.recipes.length }} recipes</span>
  <span
  class="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden w-56 rounded-lg bg-surface-dark px-2.5 py-1.5 text-[11px] leading-snug text-on-brand shadow-lg group-hover/pill:block group-focus-within/pill:block"
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

  <p class="pt-2 pb-4 text-center text-xs text-text-muted">
  {{ plan.plan.length }} meal{{ plan.plan.length === 1 ? '' : 's' }} ·
  {{ items.length }} ingredients shown
  </p>
  </template>
  </section>
</template>
