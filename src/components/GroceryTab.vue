<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  Receipt,
  Recycle,
  ShoppingCart,
  Sparkles,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-vue-next'
import { useGroceryList } from '../lib/useGroceryList'
import { extraCollapseKey, groupExtras, storeCollapseKey } from '../lib/extraSections'
import { extraCheckedKey } from '../lib/extraCheckedKeys'
import type { GroceryItem } from '../lib/grocery'
import { STORE_SECTIONS } from '../lib/sections'
import { aisleRole } from '../lib/aisleRole'
import { imageSrc, onImgError } from '../lib/images'
import HueIcon from './HueIcon.vue'
import { usePlanStore } from '../stores/plan'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { useRoomStore } from '../stores/room'
import IngredientAutocomplete from './IngredientAutocomplete.vue'

const plan = usePlanStore()
const router = useRouter()
const room = useRoomStore()
const {
  checked,
  loadError,
  loading,
  items,
  totalCount,
  checkedCount,
  totalServings,
  mealSummaries,
  sections,
  ensureDocs,
  confirmAndClearGrocery,
} = useGroceryList()

/* ---------- Custom (free-form) grocery items ---------- */

const customIngredients = useCustomIngredientsStore()

/** Ref of the add form (for the emptyState→list focus handoff, ADR-0014). */
const addForm = ref<InstanceType<typeof IngredientAutocomplete> | null>(null)
/**
 * The add form mounts as the compact empty-state variant first; the first
 * add makes customItems non-empty so that instance unmounts. Hand the
 * keyboard to the freshly mounted main-form instance instead of dropping
 * focus (the bulk-add loop never loses the keyboard, ADR-0014).
 *
 * ADR-0071 relocates the DESKTOP instance into the sidebar's Quick Extra
 * Entry, so the handoff target is whichever instance is mounted: `isDesktop`
 * selects between the sidebar slot and the in-content one, never both.
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

/**
 * Checkbox key for an extra row comes from `extraCheckedKey`, imported at
 * the top from `src/lib/extraCheckedKeys.ts` — the ONE definition, shared
 * with ShopView, the done-map and the reconciler. Never re-spell the format
 * here: the reconciler has to recognise an extras key for what it is, and a
 * second copy of the prefix is how the two key spaces would drift apart.
 */

/**
 * Remove an extra AND its checkbox key (ADR-0050 addendum). The checked
 * map is keyed by the extra's NAME, so a removed extra used to leave
 * `custom||<name>` behind; re-adding it then read as an already-done
 * row, the sub-section's done-map went false→true and ADR-0008's
 * watcher collapsed the group that had just been emptied — hiding the
 * row the user had just added.
 *
 * The cleanup lives HERE, at the removal site, not in
 * `plan.removeCustomItem`: the plan store owns `customItems`, the
 * grocery store owns checkbox keys, and wiring plan → grocery would
 * make a synced, backup-registered store depend on a view-owned one for
 * a key whose format (`custom||<lowercased name>`) the RENDERERS own.
 * `checked.forget` is a one-key store primitive that knows nothing about
 * extras.
 */
function removeExtra(name: string): void {
  plan.removeCustomItem(name)
  checked.forget(extraCheckedKey(name))
}

/** How many of a sub-section's extras are checked off. */
function extraDoneCount(group: { items: { name: string }[] }): number {
  return group.items.filter((i) => !!checked.map[extraCheckedKey(i.name)]).length
}

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

/* ---------- Aisle index (ADR-0071) ---------- */

/**
 * Walk order comes from `STORE_SECTIONS` itself (1-based), so the number
 * beside a section name is the catalog's own aisle order and can never
 * hand-drift when a section is added. Extras sub-sections deliberately
 * carry NO number: they are a view (ADR-0050 §2), not an aisle.
 */
function aisleNumber(name: string): number {
  return STORE_SECTIONS.indexOf(name as (typeof STORE_SECTIONS)[number]) + 1
}

/* ---------- Progress ---------- */

const progressPct = computed(() =>
  totalCount.value ? Math.round((checkedCount.value / totalCount.value) * 100) : 0,
)

/* ---------- Editorial header (ADR-0071 / ADR-0075 rule 1) ---------- */

const headerCounts = computed(() => {
  const meals = plan.plan.length
  const servings = totalServings.value
  const mealsText = `${meals} planned meal${meals === 1 ? '' : 's'}`
  return `Derived from ${mealsText} (${servings} serving${servings === 1 ? '' : 's'}) · ${items.value.length} ingredient${items.value.length === 1 ? '' : 's'} merged across aisles`
})

/* ---------- Desktop sidebar (ADR-0071, lg+ only) ---------- */

/**
 * One `matchMedia`, one listener, one boolean — the sidebar exists only
 * at `lg:`, where it also takes over the Quick Extra Entry slot so the
 * add-row is never mounted twice (two mounted add-rows would fight over
 * the ADR-0014 focus handoff and double-announce in AT).
 */
const desktopQuery = '(min-width: 1024px)'
const isDesktop = ref(false)
let media: MediaQueryList | null = null
function onMediaChange(e: MediaQueryListEvent) {
  isDesktop.value = e.matches
}
onMounted(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return
  media = window.matchMedia(desktopQuery)
  isDesktop.value = media.matches
  media.addEventListener('change', onMediaChange)
})
onBeforeUnmount(() => media?.removeEventListener('change', onMediaChange))

/** The room strip only exists for a joined room (owner ruling, ADR-0071). */
const inRoom = computed(() => room.inRoom && room.code !== null)
const shopperCount = computed(() => room.peers ?? 1)
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
  <!-- Editorial header (ADR-0071 delta 2, ADR-0075 rule 1): an eyebrow, the
  H1 and a derived-from subtitle built from REAL counts — the plan's meal
  count, the servings it covers and the ingredients the aggregation
  merged. Nothing here is invented, so the block carries no claim the
  list cannot back. -->
  <header class="space-y-1">
  <p class="flex items-center gap-1.5 text-label-sm font-semibold tracking-wide text-brand-text uppercase">
  <Receipt :size="16" aria-hidden="true" />
  Household meal run
  </p>
  <h1 class="text-headline-sm text-text">Grocery List</h1>
  <p class="text-body-sm text-text-muted" data-test="grocery-derived-from">
  {{ headerCounts }}
  </p>
  </header>

  <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-6">
  <!-- READING COLUMN ------------------------------------------------- -->
  <div class="space-y-4 lg:col-span-8">
  <!-- Progress card (the old toolbar, restyled): mono counts, percent,
  bar, and the confirm-first Clear-checked action. Stays sticky under
  the app header (ADR-0071 delta 2). -->
  <div
  v-if="totalCount > 0"
  class="sticky top-12 z-10 flex items-center gap-3 rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-border"
  data-test="grocery-progress"
  >
  <p
  class="min-w-0 flex-1 font-mono-data text-label-md font-semibold tabular-nums text-text"
  data-test="grocery-progress-count"
  aria-live="polite"
  >
  {{ checkedCount }} / {{ totalCount }} items
  </p>
  <div class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-sunken">
  <div
  class="h-full rounded-full bg-brand transition-all"
  :style="{ width: `${progressPct}%` }"
  />
  </div>
  <span
  class="shrink-0 font-mono-data text-label-sm tabular-nums text-text-muted"
  data-test="grocery-progress-percent"
  >{{ progressPct }}%</span>
  <button
  v-if="checkedCount > 0"
  class="flex h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-label-sm font-medium text-text-muted hover:text-text"
  data-test="clear-list"
  aria-label="Clear grocery list"
  @click="confirmAndClearGrocery()"
  >
  <Eraser :size="16" aria-hidden="true" class="mr-1 inline" />
  Clear list
  </button>
  </div>

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

  <!-- Start the run: ONE filled tomato intent on this surface
  (ADR-0072 — tomato is the START, never the completion). -->
  <button
  v-if="totalCount > 0"
  class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong lg:w-auto lg:px-6"
  data-test="start-shopping"
  @click="router.push('/shop')"
  >
  <ShoppingCart :size="20" aria-hidden="true" />
  Start shopping
  </button>

  <!-- Room strip (ADR-0071 delta 4): only for a joined room, from real
  ADR-0063 presence — code + live member count. Never awaited on a
  render path, and hidden entirely when solo. -->
  <div
  v-if="inRoom"
  class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface-raised px-3 py-2.5 text-label-md ring-1 ring-border"
  data-test="grocery-room-strip"
  >
  <span class="flex items-center gap-2">
  <span
  v-if="room.status === 'live'"
  class="size-2 shrink-0 rounded-full bg-success"
  aria-hidden="true"
  />
  <span class="text-text">Synced live with room:</span>
  <span class="font-mono-data text-text">{{ room.code }}</span>
  </span>
  <span class="flex items-center gap-1 text-text-muted">
  <Users :size="14" aria-hidden="true" />
  {{ shopperCount }} active shopper{{ shopperCount === 1 ? '' : 's' }}
  </span>
  </div>

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
  <!-- The extras GROUP header is a group label, not an aisle: no
  `(Aisle N)`, no hue glyph (ADR-0071 / ADR-0050 §2). -->
  <div
  class="flex items-center gap-2 overflow-hidden rounded-xl bg-surface-raised px-3 py-2.5 ring-1 ring-border"
  >
  <span class="min-w-0 flex-1 text-label-md font-semibold text-text">Extra items</span>
  <span
  class="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 font-mono-data text-label-sm tabular-nums text-text-muted"
  >{{ plan.customItems.length }}</span>
  </div>

  <IngredientAutocomplete v-if="!isDesktop" ref="addForm" />

  <div
  v-for="group in extraGroups"
  :key="group.name"
  class="space-y-1.5"
  data-test="extra-subsection"
  :data-extra-category="group.name"
  >
  <!-- The sub-section band: same index-card grammar as an aisle band,
  minus the aisle index (an extras sub-section is a view, not an aisle). -->
  <div class="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border">
  <h3>
  <button
  class="flex w-full items-center gap-2 border-b border-border bg-surface-sunken px-3 py-2.5 text-left"
  :aria-expanded="!isCollapsed(extraKey(group.name))"
  :aria-label="`${group.name}: ${extraDoneCount(group)} of ${group.items.length} checked`"
  data-test="extra-subsection-toggle"
  @click="toggleSection(extraKey(group.name))"
  >
  <span class="min-w-0 flex-1 truncate text-label-md font-semibold text-text">
  {{ group.name }}
  </span>
  <span class="flex shrink-0 items-center gap-2">
  <span
  class="rounded-full px-2 py-0.5 font-mono-data text-label-sm tabular-nums"
  :class="
  extraDoneCount(group) === group.items.length
  ? 'bg-success/12 text-success'
  : 'bg-surface-sunken text-text-muted'
  "
  data-test="section-count-pill"
  >{{ extraDoneCount(group) }}/{{ group.items.length }}</span>
  <ChevronRight v-if="isCollapsed(extraKey(group.name))" :size="16" aria-hidden="true" />
  <ChevronDown v-else :size="16" aria-hidden="true" />
  </span>
  </button>
  </h3>
  <ul
  v-if="!isCollapsed(extraKey(group.name))"
  class="divide-y divide-border"
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
  class="check-box done"
  :checked="!!checked.map[extraCheckedKey(item.name)]"
  @change="checked.toggleChecked(extraCheckedKey(item.name))"
  />
  <!-- No per-row category tag (ADR-0050 7): the sub-section heading
  directly above IS the category, so a #Produce pill here would only
  repeat it. The heading carries the accessible name instead. -->
  <span
  class="min-w-0 flex-1 truncate text-body-sm"
  :class="checked.map[extraCheckedKey(item.name)] ? 'text-text-muted line-through' : 'text-text'"
  >{{ item.name }}</span>
  </label>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-favourite"
  :aria-label="`Remove ${item.name} from the grocery list`"
  @click="removeExtra(item.name)"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </li>
  </ul>
  </div>
  </div>
  </div>

  <!-- No extras yet: the same add-row, unheaded, at the very top (desktop
  owns its copy in the sidebar's Quick Extra Entry). -->
  <IngredientAutocomplete v-if="!isDesktop" ref="addForm" />

  <!-- STORE SECTIONS as aisle index cards (ADR-0071 delta 3): one rounded
  `surface-raised` card per aisle with keyline dividers, a header BAND
  carrying the section's registry hue glyph, the name, the derived aisle
  index and the mono `N/M` pill. -->
  <div
  v-for="section in sections"
  :key="section.name"
  class="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border"
  data-test="grocery-section"
  >
  <h3>
  <button
  class="flex w-full items-center gap-2 border-b border-border bg-surface-sunken px-3 py-2.5 text-left"
  :aria-expanded="!isCollapsed(sectionKey(section.name))"
  :aria-label="`${section.name}: ${sectionDoneCount(section)} of ${sectionTotalCount(section)} checked`"
  data-test="grocery-section-toggle"
  @click="toggleSection(sectionKey(section.name))"
  >
  <!-- Registry hue glyph, DECORATIVE: the band prints the section name
  beside it, so the label is the carrier and the glyph is the aisle's
  identity (ADR-0036). Only Produce and Meat & Seafood have an identity
  the registry already claims — the rest render no glyph rather than a
  borrowed hue (src/lib/aisleRole.ts). -->
  <HueIcon v-if="aisleRole(section.name)" :role="aisleRole(section.name)!" :size="18" />
  <span class="min-w-0 flex-1 truncate text-label-md font-semibold text-text">
  {{ section.name }}
  <span class="ml-1 font-normal text-text-muted">(Aisle {{ aisleNumber(section.name) }})</span>
  </span>
  <!-- Completion pill: `success`-tinted when the aisle is done, tonal
  while it is open (ADR-0072). -->
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
  <ChevronRight v-if="isCollapsed(sectionKey(section.name))" :size="16" aria-hidden="true" />
  <ChevronDown v-else :size="16" aria-hidden="true" />
  </span>
  </button>
  </h3>
  <ul v-if="!isCollapsed(sectionKey(section.name))" class="divide-y divide-border" data-test="grocery-section-rows">
  <li v-for="item in section.items" :key="item.normalized">
  <!-- READING, not a task queue: a checked row stays exactly where it
  was checked, struck through and muted (ADR-0071 delta 1). The sink
  lives on in ShopView, where "next tap at the top" is the point. -->
  <div
  v-for="line in item.lines"
  :key="line.key"
  class="flex min-h-11 items-center gap-3 px-3 py-2"
  data-test="grocery-row"
  >
  <label class="flex min-w-0 flex-1 hovercap:cursor-pointer items-center gap-3">
  <input
  type="checkbox"
  class="check-box done"
  :checked="!!checked.map[line.key]"
  @change="checked.toggleChecked(line.key)"
  />
  <span
  class="min-w-0 flex-1 truncate text-body-sm"
  :class="checked.map[line.key] ? 'text-text-muted line-through' : 'text-text'"
  >
  <!-- No quantity prefix (ADR-0071 delta 4): the amount is the row's
  right-aligned mono badge below, not a bold run-on in the name. -->
  <span>{{ item.name }}</span>
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
  class="cursor-help whitespace-nowrap rounded-full bg-brand/10 px-2 py-0.5 text-label-sm font-semibold text-brand-text outline-none focus-visible:ring-2 focus-visible:ring-brand"
  >{{ item.recipes.length }} recipes</span>
  <span
  class="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden w-56 rounded-lg bg-surface-dark px-2.5 py-1.5 text-[11px] leading-snug text-on-brand shadow-popover group-hover/pill:block group-focus-within/pill:block"
  >
  <span class="block font-semibold">Used by {{ item.recipes.length }} planned meal{{ item.recipes.length === 1 ? '' : 's' }}:</span>
  {{ item.recipes.join(', ') }}
  </span>
  </span>
  </label>
  <!-- Data voice: the merged amount, re-rendered from `line.text` — the
  SAME string the unit system already produces (ADR-0047), never a new
  parser, and always the canonical metric basis so a checked key can
  never orphan itself. -->
  <span
  v-if="line.text"
  class="shrink-0 rounded-md bg-surface-sunken px-2 py-1 font-mono-data text-label-sm tabular-nums"
  :class="checked.map[line.key] ? 'text-text-muted' : 'text-text'"
  data-test="grocery-qty"
  >{{ line.text }}</span>
  </div>
  </li>
  </ul>
  </div>
  </div>

  <!-- DESKTOP SIDEBAR (ADR-0071 delta 4) ---------------------------- -->
  <aside
  v-if="isDesktop"
  class="sticky top-24 space-y-4 lg:col-span-4"
  data-test="grocery-sidebar"
  >
  <!-- Contributing Meals: thumbnails, planned servings and the grocery
  line counts from the SAME aggregation pass (`mealSummaries`), so the
  card can never disagree with the list it explains. -->
  <div class="rounded-xl bg-surface-raised p-3 ring-1 ring-border">
  <div class="flex items-center justify-between gap-2">
  <h2 class="flex items-center gap-1.5 text-label-md font-semibold text-text">
  <UtensilsCrossed :size="16" aria-hidden="true" />
  Contributing meals
  </h2>
  <span class="font-mono-data text-label-sm tabular-nums text-brand-text">{{
  plan.plan.length
  }} planned</span>
  </div>
  <ul v-if="mealSummaries.length" class="mt-2 space-y-1.5">
  <li
  v-for="meal in mealSummaries"
  :key="meal.id"
  class="flex items-center gap-2.5 rounded-lg bg-surface-sunken p-2"
  data-test="contributing-meal"
  >
  <img
  :src="imageSrc(meal.image)"
  :alt="meal.name"
  loading="lazy"
  @error="onImgError"
  class="size-14 shrink-0 rounded-md bg-surface-raised object-cover"
  />
  <div class="min-w-0 flex-1">
  <p class="truncate text-label-md font-semibold text-text">{{ meal.name }}</p>
  <p class="font-mono-data text-label-sm tabular-nums text-text-muted">
  {{ meal.servings }} serving{{ meal.servings === 1 ? '' : 's' }} ·
  {{ meal.lines }} grocery line{{ meal.lines === 1 ? '' : 's' }}
  </p>
  </div>
  </li>
  </ul>
  <p v-else class="mt-2 text-body-sm text-text-muted">Loading the plan's meals…</p>
  </div>

  <!-- Zero-waste explainer: ADR-0017's ceiling rule in prose, with NO
  invented numbers (ADR-0071 rejected fictions). -->
  <div class="rounded-xl bg-brand/8 p-3">
  <h2 class="flex items-center gap-1.5 text-label-md font-bold text-text">
  <Recycle :size="16" aria-hidden="true" class="text-success" />
  Waste-aware ceiling logic
  </h2>
  <p class="mt-1 text-body-sm text-text">
  Container measures — a package, a bunch, a head — round UP to the whole
  container and merge across meals, so the list buys one package instead of
  several part-used ones. Weights, volumes and spoons add up as usual.
  </p>
  </div>

  <!-- Quick Extra Entry: the ONE add-row, relocated here at lg: (ADR-0071
  delta 4). Mobile keeps it under the extras header. -->
  <div class="rounded-xl bg-surface-raised p-3 ring-1 ring-border">
  <h2 class="text-label-md font-semibold text-text">Quick extra entry</h2>
  <div class="mt-2">
  <IngredientAutocomplete v-if="isDesktop" ref="addForm" />
  </div>
  </div>
  </aside>
  </div>
  </template>
  </section>
</template>
