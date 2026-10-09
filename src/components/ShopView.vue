<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, ChevronDown, ChevronRight, Eraser, ShoppingCart, X } from 'lucide-vue-next'
import { useGroceryList } from '../lib/useGroceryList'
import { extraCollapseKey, groupExtras, storeCollapseKey, type ExtraGroup } from '../lib/extraSections'
import { sinkChecked } from '../lib/sink'
import { extraCheckedKey } from '../lib/extraCheckedKeys'
import { STORE_SECTIONS } from '../lib/sections'
import { aisleIcon } from '../lib/aisleRole'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import IngredientAutocomplete from './IngredientAutocomplete.vue'

const router = useRouter()
const customIngredients = useCustomIngredientsStore()
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

/**
 * Collapse state is NAMESPACED (extraCollapseKey / storeCollapseKey,
 * ADR-0050 §5): an extras "Produce" sub-section and a recipe-derived
 * "Produce" section are different groups, and the shopping screen now
 * renders both under names the user can see side by side.
 */
const manualCollapsed = ref(new Set<string>())
/** Sections collapsed automatically because every item was checked off. */
const autoCollapsed = ref(new Set<string>())
/**
 * The outer "Extra items" group header keeps its own single boolean: it
 * is a GROUP label, not a section, and its row is manual-collapse-only
 * like every extras row on this screen (ADR-0008 addendum).
 */
const extrasGroupCollapsed = ref(false)

function isCollapsed(key: string): boolean {
  return manualCollapsed.value.has(key) || autoCollapsed.value.has(key)
}

function toggleSection(key: string) {
  // A header click always wins over the auto state (like the Grocery
  // tab): clicking an auto-collapsed header re-opens ONLY that category
  // and pins it open until it is done again — other auto-collapsed
  // categories keep their state (qodo 4128519637).
  const next = new Set(manualCollapsed.value)
  if (isCollapsed(key)) {
    next.delete(key)
    if (autoCollapsed.value.has(key)) {
      const auto = new Set(autoCollapsed.value)
      auto.delete(key)
      autoCollapsed.value = auto
    }
  } else {
    next.add(key)
  }
  manualCollapsed.value = next
}

function toggleExtrasGroup(): void {
  extrasGroupCollapsed.value = !extrasGroupCollapsed.value
}

/* ---------- Extras sub-sections (ADR-0050) ---------- */

/**
 * The SAME grouping lib the Grocery tab uses — extras are grouped into
 * their own category sub-sections there, and the shopping screen used to
 * keep one flat list, which is what the owner's screenshot shows. A
 * second implementation here would drift from the Grocery tab the first
 * time a rule changed, so there is none (DRY beats everything else).
 */
const extraGroups = computed(() =>
  groupExtras(
    plan.customItems.map((name) => ({ name, category: customIngredients.find(name)?.category })),
  ),
)

/**
 * Checkbox key for an extra row comes from `extraCheckedKey` (imported at
 * the top) — the same ONE definition the Grocery tab and the reconciler use.
 * This used to be a local "mirror" of the Grocery tab's copy, which is
 * precisely how two key formats drift apart.
 */

/** How many of a sub-section's extras are checked off (for the N/N pill). */
function extraDoneCount(group: { items: { name: string }[] }): number {
  return group.items.filter((i) => !!checked.map[extraCheckedKey(i.name)]).length
}

/** Collapse key for an extras sub-section. */
function extraKey(name: string): string {
  return extraCollapseKey(name)
}

/** Collapse key for a recipe-derived store section. */
function storeKey(name: string): string {
  return storeCollapseKey(name)
}

/**
 * Walk order from `STORE_SECTIONS` (1-based) — the same derived index the
 * Grocery tab prints, so a shopper reading either screen counts the same
 * aisles (ADR-0071 delta 3, re-converged in ADR-0075's grammar sweep).
 */
function aisleNumber(name: string): number {
  return STORE_SECTIONS.indexOf(name as (typeof STORE_SECTIONS)[number]) + 1
}

/**
 * A group is "done" when every grocery line under it is checked. ONE map
 * feeds ONE watcher for BOTH kinds of group on this screen — recipe-derived
 * store sections AND extras sub-sections (ADR-0050 addendum: the owner
 * reversed the manual-only rule; the shopping screen keeps one rule, not
 * two) — exactly the Grocery tab's shape.
 */
const sectionDone = computed(() => {
  const m = new Map<string, boolean>()
  for (const s of sections.value) {
    const lines = s.items.flatMap((i) => i.lines)
    m.set(storeKey(s.name), lines.length > 0 && lines.every((l) => !!checked.map[l.key]))
  }
  for (const g of extraGroups.value) {
    m.set(
      extraKey(g.name),
      g.items.length > 0 && g.items.every((i) => !!checked.map[extraCheckedKey(i.name)]),
    )
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
 *
 * Extras sub-sections ARE in this map now (ADR-0050 addendum, 2026-10-05:
 * the owner reversed ADR-0008's addendum and ADR-0050's own manual-only
 * rule — a group reading N/N while its neighbour is collapsed reads as
 * "not working", so ONE done→collapse rule applies to every group on this
 * screen, a one-item sub-section included). The outer "Extra items" GROUP
 * header is still not a section and stays manual-only. The same ordering
 * contract holds for the extras path: the sink re-sorts a sub-section's
 * rows BEFORE the collapse hides it.
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

/**
 * Rendered row order: checked items sink to the bottom, stable within
 * each group (ADR-0008) — ONE sink helper for both kinds of group, so
 * store sections and extras sub-sections cannot drift apart.
 */
function sinkedStoreRows(section: {
  items: { name: string; lines: { key: string; text?: string }[] }[]
}) {
  return sinkChecked(
    section.items.flatMap((item) => item.lines.map((line) => ({ item, line }))),
    (e) => !!checked.map[e.line.key],
  )
}

function sinkedExtraRows(group: ExtraGroup) {
  return sinkChecked(group.items, (i) => !!checked.map[extraCheckedKey(i.name)])
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
  class="sticky top-0 z-20 border-b border-border bg-surface-raised"
  >
  <div class="mx-auto flex max-w-app items-center gap-3 px-4 py-3">
  <button
  class="flex h-11 shrink-0 items-center rounded-xl border border-border-strong bg-surface-raised px-3 text-sm font-medium text-text active:bg-surface-sunken"
  data-test="exit-shopping"
  @click="exitShopping"
  >
  <X :size="16" aria-hidden="true" class="mr-1 inline" />
  Exit
  </button>
  <div class="min-w-0 flex-1">
  <div class="flex items-center justify-between font-mono-data text-xs tabular-nums">
  <span class="font-semibold" data-test="shopping-progress" aria-live="polite">
  {{ checkedCount }} / {{ totalCount }}
  </span>
  <span>{{ progressPct }}%</span>
  </div>
  <div class="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken">
  <div
  class="h-full rounded-full bg-brand transition-all"
  :style="{ width: `${progressPct}%` }"
  />
  </div>
  </div>
  <button
  v-if="checkedCount > 0"
  class="flex h-11 shrink-0 items-center gap-1 rounded-xl border border-border-strong bg-surface-raised px-3 text-sm font-medium text-text active:bg-surface-sunken"
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
  <div v-for="i in 6" :key="i" class="h-12 animate-pulse rounded-lg bg-surface-sunken" />
  </div>

  <div
  v-else-if="loadError"
  class="rounded-xl bg-surface p-4 text-center text-sm text-danger"
  >
  <p class="font-medium">Couldn't build the grocery list</p>
  <p class="mt-1 text-xs">{{ loadError }}</p>
  <button class="mt-2 rounded-lg bg-brand px-3 py-1.5 text-on-brand" @click="ensureDocs">
  Retry
  </button>
  </div>

  <template v-else>
  <!-- The outer "Extra items" GROUP header stays manual-only (it is a
  group label, not a section). Its sub-sections now follow the SAME
  done→collapse rule as the store sections below (ADR-0050 addendum:
  the owner reversed the earlier manual-only rule — consistency, one
  rule for every group on the shopping screen). Grouped into their OWN
  category sub-sections (ADR-0050) via the same `groupExtras` the
  Grocery tab uses, rows sunk by the same `sinkChecked` helper. An
  extras "Produce" sub-section is NOT the recipe-derived "Produce"
  below it (ADR-0015 §2, still in force): the namespaced collapse keys
  are what keep the two apart. -->
  <section
  v-if="plan.customItems.length > 0"
  class="mb-6"
  data-test="shop-custom-items"
  >
  <!-- The outer "Extra items" GROUP header stays manual-only (it is a
  group label, not a section) and keeps its own band grammar: same
  index-card treatment as an aisle band, but NO aisle index — an extras
  sub-section is a view, not an aisle (ADR-0050 §2, ADR-0075 rule 2). -->
  <div class="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border">
  <button
  class="flex w-full items-center justify-between border-b border-border bg-surface-sunken px-3 py-2.5 text-left"
  :aria-expanded="!extrasGroupCollapsed"
  aria-label="Extra items"
  data-test="shop-section-toggle"
  @click="toggleExtrasGroup"
  >
  <span class="text-label-md font-semibold text-text">Extra items</span>
  <span class="flex items-center gap-2">
  <span class="text-label-sm">
  <ChevronRight v-if="extrasGroupCollapsed" :size="18" aria-hidden="true" />
  <ChevronDown v-else :size="18" aria-hidden="true" />
  </span>
  </span>
  </button>
  <div v-if="!extrasGroupCollapsed" class="space-y-2 p-2">
  <div
  v-for="group in extraGroups"
  :key="group.name"
  class="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border"
  data-test="shop-extra-subsection"
  :data-extra-category="group.name"
  >
  <button
  class="flex w-full items-center justify-between border-b border-border bg-surface-sunken px-3 py-2.5 text-left"
  :aria-expanded="!isCollapsed(extraKey(group.name))"
  :aria-label="`${group.name}: ${extraDoneCount(group)} of ${group.items.length} checked`"
  data-test="shop-extra-subsection-toggle"
  @click="toggleSection(extraKey(group.name))"
  >
  <!-- Same glyph grammar as the Grocery tab's extras band (ADR-0076):
  department hue where the name is a real department; `Uncategorized`
  (a view label) renders no glyph. -->
  <component
  :is="aisleIcon(group.name)!.glyph"
  v-if="aisleIcon(group.name)"
  :size="16"
  :class="aisleIcon(group.name)!.className"
  class="shrink-0"
  aria-hidden="true"
  />
  <span class="min-w-0 flex-1 truncate text-label-md font-semibold text-text">{{ group.name }}</span>
  <span class="flex items-center gap-2">
  <span
  class="rounded-full px-2 py-0.5 font-mono-data text-label-sm tabular-nums"
  :class="
  extraDoneCount(group) === group.items.length
  ? 'bg-success/12 text-success'
  : 'bg-surface-sunken text-text-muted'
  "
  data-test="section-count-pill"
  >{{ extraDoneCount(group) }}/{{ group.items.length }}</span>
  <span class="text-label-sm">
  <ChevronRight v-if="isCollapsed(extraKey(group.name))" :size="18" aria-hidden="true" />
  <ChevronDown v-else :size="18" aria-hidden="true" />
  </span>
  </span>
  </button>
  <ul
  v-if="!isCollapsed(extraKey(group.name))"
  class="divide-y divide-border"
  data-test="shop-extra-subsection-rows"
  >
  <!-- Checked items sink, stable within the sub-section — the same
  sink the store sections render through. -->
  <li v-for="item in sinkedExtraRows(group)" :key="item.name">
  <button
  class="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left text-body-md"
  :class="checked.map[extraCheckedKey(item.name)] ? 'opacity-40' : ''"
  data-test="shop-row"
  @click="checked.toggleChecked(extraCheckedKey(item.name))"
  >
  <span
  class="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border-strong"
  :class="checked.map[extraCheckedKey(item.name)] ? 'border-success bg-success text-on-success' : ''"
  aria-hidden="true"
  >
  <Check v-if="checked.map[extraCheckedKey(item.name)]" :size="16" />
  </span>
  <span
  class="min-w-0 flex-1 truncate text-body-md"
  :class="checked.map[extraCheckedKey(item.name)] ? 'text-text-muted line-through' : 'text-text'"
  >{{ item.name }}</span
  >
  </button>
  </li>
  </ul>
  </div>
  </div>
  </div>
  </section>

  <!-- Store sections: auto-collapse on done (ADR-0008 addendum), same
  watcher contract as the Grocery tab, header + count pill stay. The
  band re-converges with the grocery reading surface (ADR-0071 delta 3,
  ADR-0075 rule 2) — card, sunken band, derived aisle index, success-
  tinted pill — while the ROW behaviour stays a task surface: the sink
  order and the >=52px targets are untouched. -->
  <section
  v-for="section in sections"
  :key="section.name"
  class="mb-6 overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border"
  data-test="shop-section"
  >
  <!-- The hue glyph sits OUTSIDE the toggle: the toggle's own svg count
  is pinned at one (the chevron) by the shop auto-collapse spec, and a
  decorative glyph must not become part of that count. Every department
  wears its glyph + aisle hue (ADR-0076); the band's name span carries
  the accessible label. -->
  <div class="flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-2.5">
  <component
  :is="aisleIcon(section.name)!.glyph"
  :size="18"
  :class="aisleIcon(section.name)!.className"
  class="shrink-0"
  aria-hidden="true"
  />
  <button
  class="flex min-w-0 flex-1 items-center justify-between text-left"
  :aria-expanded="!isCollapsed(storeKey(section.name))"
  :aria-label="`${section.name}: ${sectionDoneCount(section)} of ${sectionTotalCount(section)} checked`"
  data-test="shop-section-toggle"
  @click="toggleSection(storeKey(section.name))"
  >
  <span class="min-w-0 flex-1 truncate text-label-md font-semibold text-text">
  <span>{{ section.name }}</span>
  <span class="ml-1 font-normal text-text-muted">(Aisle {{ aisleNumber(section.name) }})</span>
  </span>
  <span class="flex shrink-0 items-center gap-2">
  <span
  class="rounded-full px-2 py-0.5 font-mono-data text-label-sm tabular-nums"
  :class="
  sectionDoneCount(section) === sectionTotalCount(section)
  ? 'bg-success/12 text-success'
  : 'bg-surface-sunken text-text-muted'
  "
  data-test="section-count-pill"
  >{{ sectionDoneCount(section) }}/{{ sectionTotalCount(section) }}</span>
  <span class="text-label-sm">
  <ChevronRight v-if="isCollapsed(storeKey(section.name))" :size="18" aria-hidden="true" />
  <ChevronDown v-else :size="18" aria-hidden="true" />
  </span>
  </span>
  </button>
  </div>
  <template v-if="!isCollapsed(storeKey(section.name))">
  <ul class="divide-y divide-border" data-test="shop-section-rows">
  <!-- Unchecked first (checked items sink), stable within each group;
  the ordering lives once in src/lib/sink.ts, shared with the extras
  sub-sections above. -->
  <li v-for="entry in sinkedStoreRows(section)" :key="entry.line.key">
  <button
  class="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left text-body-md"
  :class="checked.map[entry.line.key] ? 'opacity-40' : ''"
  data-test="shop-row"
  @click="checked.toggleChecked(entry.line.key)"
  >
  <span
  class="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border-strong"
  :class="checked.map[entry.line.key] ? 'border-success bg-success text-on-success' : ''"
  aria-hidden="true"
  >
  <Check v-if="checked.map[entry.line.key]" :size="16" />
  </span>
  <span
  class="min-w-0 flex-1 truncate text-body-md"
  :class="checked.map[entry.line.key] ? 'text-text-muted line-through' : 'text-text'"
  >{{ entry.item.name }}</span
  >
  <!-- Data voice (ADR-0066/ADR-0075 rule 3): the quantity is a mono
  badge, not a run-on prefix. -->
  <span
  v-if="entry.line.text"
  class="shrink-0 rounded-md bg-surface-sunken px-2 py-1 font-mono-data text-label-sm tabular-nums"
  :class="checked.map[entry.line.key] ? 'text-text-muted' : 'text-text'"
  >{{ entry.line.text }}</span>
  </button>
  </li>
  </ul>
  </template>
  </section>

  <p
  v-if="totalCount === 0"
  class="py-16 text-center text-text-muted"
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
