<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useHead } from '@unhead/vue'
import { ArrowUpDown, ChevronDown, Clock, Crown, Heart, Layers, SearchX, Sparkles, UserRound } from 'lucide-vue-next'
import type { Component } from 'vue'
import { recipesSeoHead } from '../lib/seo'
import { catalog } from '../lib/catalog'
import { useRestrictions } from '../composables/useRestrictions'
import {
  DIET_DESCRIPTIONS,
  DIET_IDS,
  DIET_LABELS,
  dietChipLabel,
  dietIndexFor,
  matchesAllDiets,
  type DietId,
} from '../lib/dietFilter'
import {
  PROTEIN_OPTIONS,
  SORT_OPTIONS,
  SOURCE_OPTIONS,
  TIME_OPTIONS,
  defaultQuickFilters,
  hasActiveFilters,
  matchesSource,
  type ProteinFilter,
  type QuickFilters,
  type SortBy,
  type SourceFilter,
} from '../lib/quickFilters'
import { popularityScore } from '../lib/quantity'
import {
  OFFERED_MEAL_TYPES,
  matchesMealType,
  type MealTypeId,
} from '../lib/mealTypeFilter'
import {
  dietHueClass,
  dietRole,
  mealRole,
  proteinHueClass,
  roleGlyph,
  type IconRole,
} from '../lib/palette'
import type { VariantMeta } from '../lib/types'
import { useFavouritesStore } from '../stores/favourites'
import { useUiStore } from '../stores/ui'
import RecipeCard from './RecipeCard.vue'
import RecipeSearchField from './RecipeSearchField.vue'
import FilterDropdown from './FilterDropdown.vue'
import type { FilterDropdownOption } from './FilterDropdown.vue'
import HueIcon from './HueIcon.vue'
import { useRecipeSearch } from '../composables/useRecipeSearch'
import { useSearchTips } from '../composables/useSearchTips'

/** ADR-0070: the query is EPHEMERAL state in a module-scope composable
 *  (never persisted, never room-synced — a search is a question, not a
 *  household preference, ADR-0027). Header well and this content field
 *  read the same singleton; switching tabs keeps the query in memory. */
const { query, searchResults, searchPending } = useRecipeSearch()

/** ADR-0078 Decision 9: the recipes list is its OWN indexable surface.
 *  The prerendered `dist/recipes/index.html` carries `recipesSeoHead`,
 *  and this scoped `useHead` re-asserts the SAME head client-side — the
 *  ADR-0048 parity rule: a hydrating browser must reproduce the head a
 *  crawler read, instead of letting the app-shell default (the hero's
 *  homepage head) win after hydration. Unhead drops these scoped entries
 *  on unmount, so every other tab falls back to the app-shell default. */
useHead(computed(() => recipesSeoHead()))

/** The desktop breakpoint where the search well moves into the header.
 *  Same lg: value as the Tailwind variant used in App.vue. */
const isDesktop = useMediaQuery('(min-width: 1024px)')

/** Search-tips disclosure: closed by default, user-toggled, device-local
 *  (ADR-0027) — content-level, so it survives the field's header move.
 *  The STATE is the module singleton in `useSearchTips`, shared with the
 *  header's `?` affordance (ADR-0070 Addendum 1): the panel itself stays
 *  here, with the content it explains. */
const { showTips, toggleTips } = useSearchTips()

const favourites = useFavouritesStore()
const ui = useUiStore()
// Dietary restrictions (the restriction ADR): removal is a DISCOVERY filter,
// applied here where the search pipeline runs — a recipe already in the plan
// stays planned regardless.
const restrictions = useRestrictions()

/** The ONE filter object (ADR-0027): persisted, and synced in the room. */
const filters = computed<QuickFilters>(() => ui.quickFilters)

/** Replace part of the selection; always a fresh object so the store's
 *  deep watcher (and the room push) sees a change. */
function patchFilters(part: Partial<QuickFilters>) {
  ui.quickFilters = { ...ui.quickFilters, ...part }
}

/* ---------- Diet filter chips (ADR-0018, unified in ADR-0027) ---------- */

/** Whole-catalog verdicts + chip counts, classified once at load time. */
const dietIndex = computed(() => {
  const c = catalog.value
  return c ? dietIndexFor(c.variantMeta) : null
})

/** Active diet rules, ANDed together. */
const activeDiets = computed<DietId[]>(() => filters.value.diets)

const dietCounts = computed(() => {
  const counts = {} as Record<DietId, number>
  for (const id of DIET_IDS) counts[id] = dietIndex.value?.counts[id] ?? 0
  return counts
})

function toggleDiet(diet: DietId) {
  const current = [...filters.value.diets]
  const at = current.indexOf(diet)
  if (at === -1) current.push(diet)
  else current.splice(at, 1)
  patchFilters({ diets: current })
}

function setProtein(protein: ProteinFilter) {
  patchFilters({ protein })
}

/* ---------- The three dropdowns (ADR-0045: ONE FilterDropdown) ---------- */

/**
 * Cook time, sort and meal type all render through `FilterDropdown`, so
 * the trigger classes, the popup shell, the check-or-spacer alignment and
 * the focus bookkeeping exist ONCE (the native `<select>` is deleted —
 * its OS-drawn popup was the third visual language). Each control only
 * supplies data: the option list, the selected index, the `data-test`
 * contract VERBATIM (ADR-0045 §3) and the leading icon that genuinely
 * differs.
 *
 * `maxTime` keeps its exact `number | null` store type — the dropdown is
 * presentation only; `normalizeQuickFilters` semantics are untouched.
 */
const cookOptions: FilterDropdownOption[] = TIME_OPTIONS.map((minutes) => ({
  value: minutes === null ? 'any' : String(minutes),
  label: minutes === null ? 'Any cook time' : `≤ ${minutes} min`,
}))

const cookSelectedIndex = computed(() => {
  const at = cookOptions.findIndex((o) => o.value === String(filters.value.maxTime ?? 'any'))
  return Math.max(0, at)
})

function setMaxTime(value: string) {
  patchFilters({ maxTime: value === 'any' ? null : Number(value) })
}

const sortOptions: FilterDropdownOption[] = SORT_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
  ariaLabel: `Sort by ${o.label}`,
}))

const sortSelectedIndex = computed(() => {
  const at = SORT_OPTIONS.findIndex((o) => o.value === filters.value.sortBy)
  return Math.max(0, at)
})

function setSort(value: string) {
  patchFilters({ sortBy: value as SortBy })
}

/* ---------- Source (ADR-0054) ---------- */

/**
 * All / PRO / New, with a per-bucket count beside each option.
 *
 * The counts are WHOLE-CATALOG counts (they ignore the other filters),
 * for the same reason ADR-0043's meal-type counts do: a count that moved
 * as you toggled the diet chips would answer "how many of these?" and be
 * read as "how many in total?", and the number next to "New" that
 * shrank every time you picked "New" would look like a bug.
 *
 * `pro` is counted by scanning `variant_meta` once per catalog load, not
 * at build time: it is a facet on a FROZEN field (`is_pro`) of a catalog
 * that the user recipes now share, so a committed table beside
 * recipe_types.json would be a second source of truth for a boolean.
 */
const SOURCE_ICONS: Record<SourceFilter, Component> = {
  all: Layers,
  pro: Crown,
  new: UserRound,
}

const sourceCounts = computed(() => {
  const c = catalog.value
  if (!c) return { all: 0, pro: 0, new: 0 }
  let pro = 0
  for (const meta of c.byId.values()) if (meta.is_pro) pro++
  return { all: c.byId.size, pro, new: c.userRecipeIds.size }
})

const sourceOptions = computed<FilterDropdownOption[]>(() =>
  SOURCE_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    // The bucket says what it selects, not what it is called: "New" is
    // every recipe the household authored, forever, and the aria-label is
    // where that is spelled out (locked decision L1).
    ariaLabel:
      o.value === 'new' ? 'Your own recipes (all of them)' : `Filter by source: ${o.label}`,
    count: sourceCounts.value[o.value],
    icon: SOURCE_ICONS[o.value],
  })),
)

const sourceSelectedIndex = computed(() => {
  const at = SOURCE_OPTIONS.findIndex((o) => o.value === filters.value.source)
  return Math.max(0, at)
})

/** The trigger's glyph mirrors the SELECTED option, like the meal menu. */
const sourceIcon = computed(() => SOURCE_ICONS[filters.value.source] ?? Layers)

function setSource(value: string) {
  patchFilters({ source: value as SourceFilter })
}

/* ---------- Meal type (ADR-0043) ---------- */

/**
 * Occasion dropdown over the catalog's own `ruleset` field, so this
 * filter is exact — unlike the diet lens above there is no guessing. The
 * option LIST is "Any" plus the five offered buckets, and the counts
 * beside each option are tallied at BUILD time into the committed
 * recipe_types.json, never by a 2,759-recipe scan in the client.
 */
const mealOptions: FilterDropdownOption[] = [
  { value: 'any', label: 'Any', ariaLabel: 'Any meal type', icon: Sparkles },
  ...OFFERED_MEAL_TYPES.map((option) => ({
    value: String(option.id),
    label: option.label,
    ariaLabel: `${option.label}, ${option.count} recipes`,
    count: option.count,
    iconRole: mealRole(option.ruleset),
  })),
]

const mealSelectedIndex = computed(() => {
  const at = OFFERED_MEAL_TYPES.findIndex((o) => o.id === filters.value.mealType)
  return at === -1 ? 0 : at + 1
})

function setMealType(value: string) {
  patchFilters({ mealType: value === 'any' ? null : (Number(value) as MealTypeId) })
}

/**
 * The meal hue is the icon's IDENTITY, not its state (ADR-0036): the
 * option row keeps its meal hue whether or not it is the selected one —
 * selection is painted by the brand tint + check, never by recolouring
 * the glyph. These are the owner's five SEPARATE occasion hues; a meal
 * icon never borrows a protein hue (which already means "contains meat"
 * on the chips two rows away).
 *
 * `simple` is Mealime's own ruleset name; the surface calls it Lunch
 * (ADR-0043), which is exactly why the mapping goes through
 * `mealRole(ruleset)` instead of through the raw ruleset string.
 */
const selectedMealRole = computed<IconRole | null>(() => {
  const option = OFFERED_MEAL_TYPES.find((o) => o.id === filters.value.mealType)
  return option ? mealRole(option.ruleset) : null
})

/**
 * "Any" is not an occasion, so it has NO hue and borrows the neutral
 * Sparkles glyph (the same rule the protein chips' "Any protein" row
 * follows). It is deliberately a bare icon, not a `HueIcon`: there is no
 * role for "no occasion", and inventing one would put a sixth
 * meaningless colour in the palette.
 */
const ANY_MEAL_ICON: Component = Sparkles

/* ---------- Icon maps (WS5: one Lucide icon per filter) ---------- */

/** Every food chip renders the SAME glyph and hue in every state: the
 *  hue is the icon's identity, never its state. Selection is painted by
 *  the chip surface (brand tint + brand outline + `aria-pressed`), so a
 *  red icon is never invisible on a red fill, and the pill never changes
 *  width when it is pressed (ADR-0036 item 6). */
const PROTEIN_ICONS: Record<ProteinFilter, { icon: Component; cls: string }> = {
  '': { icon: Sparkles, cls: '' }, // "Any" is not a food, so it has no hue
  fish: { icon: roleGlyph('fish'), cls: proteinHueClass('fish') },
  meat: { icon: roleGlyph('meat'), cls: proteinHueClass('meat') },
  vegetarian: { icon: roleGlyph('vegetarian'), cls: proteinHueClass('vegetarian') },
}

const DIET_ICONS: Record<DietId, { icon: Component; cls: string }> = Object.fromEntries(
  DIET_IDS.map((d) => {
  const role = dietRole(d)
  return [d, { icon: role === null ? Sparkles : roleGlyph(role), cls: dietHueClass(d) }]
  }),
) as Record<DietId, { icon: Component; cls: string }>

/* ---------- Result pipeline (owned by useRecipeSearch, ADR-0070) ---------- */

/* searchResults / searchPending come off the composable above — one
 * pipeline shared with the header mount, never a per-instance copy. */

/** Comparator for the current sortBy selection, used to sort primary and fallback separately. */
function getSortComparator(sortBy: SortBy): (a: VariantMeta, b: VariantMeta) => number {
  switch (sortBy) {
  case 'rating':
  return (a, b) => b.rating - a.rating || b.rating_count - a.rating_count
  case 'time':
  return (a, b) => a.cooking_minutes - b.cooking_minutes
  case 'calories':
  return (a, b) => a.calories - b.calories
  case 'popularity':
  return (a, b) => popularityScore(b.popularity) - popularityScore(a.popularity)
  case 'latest':
  return (a, b) => (b.first_published_at ?? 0) - (a.first_published_at ?? 0)
  default:
  return () => 0
  }
}

/** Primary result count AFTER facet filtering (drives the divider). */
const primaryCount = computed(() => results.value.primaryLength)

const results = computed<{ list: VariantMeta[]; primaryLength: number }>(() => {
  const c = catalog.value
  if (!c) return { list: [], primaryLength: 0 }
  const f = filters.value
  const q = query.value.trim()
  const diets = f.diets
  const index = dietIndex.value

  const facets = (meta: VariantMeta): boolean => {
  // The restriction verdict is upstream's own (removed = a strict subset);
  // user recipes are never in it (no upstream rework exists for them).
  if (restrictions.isRemoved(meta.recipe_id)) return false
  if (f.favOnly && !favourites.ids.has(meta.id)) return false
  // ADR-0054: 'pro' is the retired proOnly chip, 'new' is the household's
  // own recipes (permanent — only the card's NEW badge expires).
  if (!matchesSource(f.source, meta, c.userRecipeIds)) return false
  if (f.protein !== '' && c.dataById.get(meta.id)?.category_name !== f.protein)
  return false
  // ADR-0043: an exact compare against the catalog's own `ruleset`, so
  // unlike the diet lens above this narrows with no guessing at all.
  if (!matchesMealType(meta.ruleset, f.mealType)) return false
  if (f.maxTime !== null && meta.cooking_minutes > f.maxTime) return false
  if (diets.length > 0) {
  const verdict = index?.verdictById.get(meta.id)
  if (!verdict || !matchesAllDiets(verdict, diets)) return false
  }
  return true
  }

  let list: VariantMeta[]
  let primaryLength: number
  if (q) {
  // Indexed fuzzy/prefix search over name + ingredients, intersected with
  // the active facet filters. Primary AND matches first, OR-fallback after.
  const r = searchResults.value
  if (r) {
  const primarySet = new Set(r.primary)
  const fallbackSet = new Set(r.fallback)
  const primary = c.variantMeta.filter((meta) => {
  if (primarySet.has(meta.id)) return facets(meta)
  return false
  })
  const fallback = c.variantMeta.filter((meta) => {
  if (primarySet.has(meta.id)) return false
  if (!fallbackSet.has(meta.id)) return false
  return facets(meta)
  })
  // Sort primary and fallback separately so primary always comes first.
  primary.sort(getSortComparator(f.sortBy))
  fallback.sort(getSortComparator(f.sortBy))
  // The split point is the FILTERED primary length — using the raw id
  // count would label facet-passing fallback cards as primary and
  // misplace the "More results" divider.
  primaryLength = primary.length
  list = [...primary, ...fallback]
  } else {
  list = []
  primaryLength = 0
  }
  } else {
  list = c.variantMeta.filter(facets)
  // The browse path sorts like the search path: without this the sort
  // dropdown is dead whenever the search box is empty (a regression the
  // search rewrite introduced — main sorted every list).
  list.sort(getSortComparator(f.sortBy))
  primaryLength = list.length
  }
  return { list, primaryLength }
})

const filtersActive = computed(() => query.value !== '' || hasActiveFilters(filters.value))

function clearFilters() {
  query.value = ''
  ui.quickFilters = defaultQuickFilters()
}

/* ---------- Incremental rendering ---------- */

/** Cards rendered per batch; the rest load in as the sentinel scrolls in. */
const BATCH_SIZE = 60
const visibleCount = ref(BATCH_SIZE)
const visibleResults = computed(() => results.value.list.slice(0, visibleCount.value))
const visiblePrimaryResults = computed(() => {
  if (!searchResults.value) return visibleResults.value
  return results.value.list.slice(0, Math.min(visibleCount.value, primaryCount.value))
})
const visibleFallbackResults = computed(() => {
  if (!searchResults.value) return []
  return results.value.list.slice(primaryCount.value, visibleCount.value)
})
const hasMore = computed(() => visibleCount.value < results.value.list.length)

// New filter/search/sort results reset the window back to the first batch.
watch(results, () => {
  visibleCount.value = BATCH_SIZE
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  // Warm the restriction artifacts (control plane + overlays) so the
  // removal filter and any swapped names are ready when needed. No-op when
  // no restriction is active.
  void restrictions.ensureLoaded()
  observer = new IntersectionObserver(
  (entries) => {
  if (entries.some((e) => e.isIntersecting) && hasMore.value) {
  visibleCount.value = Math.min(visibleCount.value + BATCH_SIZE, results.value.list.length)
  }
  },
  { rootMargin: '800px' },
  )
  observer.observe(sentinel.value!)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <section class="space-y-3">
  <!-- ADR-0064: the search control (input, suggest dropdown, both
  debounce pipelines) lives in ONE component; the facets, sort and grid
  below stay here. ADR-0070: below lg the field lives in-content; at lg+
  it moves into the header well (App.vue) — one component, two mount
  points, and v-if (not a CSS hide) so ids and data-test hooks never
  duplicate. The query state is the module singleton both mounts share. -->
  <RecipeSearchField v-if="!isDesktop" />

  <!-- The tips disclosure is CONTENT, not a mount of the field: it
  must stay available at lg+ (where the field moved to the header) and
  it must not bloat the header band. Toggle state stays device-local
  (ADR-0027), panel closed by default. At lg+ the header's `?`
  affordance (RecipeSearchField) opens the SAME disclosure, so this
  in-content toggle is the mobile/panel-mount face of one state. -->
  <div v-if="!isDesktop" class="flex w-full justify-end">
  <!-- A 44px hit target (DESIGN.md Controls), and the rotation belongs to
       the CHEVRON: rotating the whole button turned the "Search tips"
       label upside down. -->
  <button
  data-test="search-tips-toggle"
  :aria-expanded="showTips"
  aria-controls="search-tips-panel"
  class="flex min-h-11 items-center gap-1 px-2 py-2 text-xs text-text-muted"
  @click="toggleTips"
  >
  Search tips
  <ChevronDown
  :size="14"
  aria-hidden="true"
  class="transition-transform"
  :class="showTips ? 'rotate-180' : ''"
  />
  </button>
  </div>

  <div
  v-if="showTips"
  id="search-tips-panel"
  data-test="search-tips-panel"
  class="rounded-xl border border-border bg-popover px-4 py-3 text-xs text-text-muted space-y-1"
  >
  <div><code>word word</code> — all words (AND)</div>
  <div><code>rice OR quinoa</code> — either word</div>
  <div><code>"tomato soup"</code> — exact phrase</div>
  <div><code>-word</code> — exclude</div>
  <div><code>word*</code> — starts with</div>
  <div><code>soup (rice OR quinoa) -cream</code> — combine them</div>
  </div>

  <!-- WS1: a 2-column GRID on phones, a wrapping flex row from `sm` up.
  Grid cells never orphan a control on a line of its own, which is
  what `ml-auto` used to do to the sort control on a ~390px screen. -->
  <div
  class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
  data-test="filter-bar"
  >
  <!-- ADR-0045: one FilterDropdown for all three — cook time, sort and
  meal type finally share one trigger + popup shell, and the native
  `<select>` (whose OS-drawn popup matched nothing) is deleted. -->
  <FilterDropdown
  :options="cookOptions"
  :selected-index="cookSelectedIndex"
  label="Filter by max cook time"
  trigger-test="cook-time-filter"
  menu-test="cook-time-menu"
  :option-test="(o) => `cook-time-option-${o.value}`"
  :active="filters.maxTime !== null"
  @select="setMaxTime"
  >
  <template #icon><Clock :size="16" aria-hidden="true" /></template>
  </FilterDropdown>

  <!-- ADR-0069: the favourites chip is always rose-tinted at rest
  (8% favourite tint + favourite text) and brand-selected when on. -->
  <button
  class="flex h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors"
  :class="
  filters.favOnly
  ? 'border-brand-text bg-brand-tint text-brand-text'
  : 'chip-tint border-transparent text-favourite'
  "
  :aria-pressed="filters.favOnly"
  aria-label="Favourites only"
  data-test="favourites-filter"
  @click="patchFilters({ favOnly: !filters.favOnly })"
  >
  <Heart
  :size="16"
  :fill="filters.favOnly ? 'currentColor' : 'none'"
  :class="filters.favOnly ? 'text-favourite' : ''"
  aria-hidden="true"
  />
  <span class="truncate">Favourites</span>
  </button>

  <!-- Source (ADR-0054): a DROPDOWN, replacing the PRO chip. Rendered
  through the shared FilterDropdown (ADR-0045) so the listbox semantics,
  the roving tabindex and the Pixel 7 fit are the ones the other three
  dropdowns already have — never a fourth hand-rolled popup. -->
  <FilterDropdown
  :options="sourceOptions"
  :selected-index="sourceSelectedIndex"
  label="Filter by recipe source"
  trigger-test="source-button"
  menu-test="source-menu"
  :option-test="(o) => `source-option-${o.value}`"
  :active="filters.source !== 'all'"
  @select="setSource"
  >
  <template #icon><component :is="sourceIcon" :size="16" aria-hidden="true" /></template>
  </FilterDropdown>

  <!-- Compact sort affordance: icon + current label, never a wide
  native select with "Sort: …" options. -->
  <FilterDropdown
  :options="sortOptions"
  :selected-index="sortSelectedIndex"
  label="Sort recipes"
  trigger-test="sort-button"
  menu-test="sort-menu"
  :option-test="(o) => `sort-option-${o.value}`"
  @select="setSort"
  >
  <template #icon><ArrowUpDown :size="16" aria-hidden="true" /></template>
  </FilterDropdown>
  <!-- Meal type (ADR-0043): occasion buckets taken straight from the
  catalog's own `ruleset` field, so this filter is exact — the counts
  beside each option are tallied at BUILD time into the committed
  recipe_types.json, never by a 2,759-recipe scan in the client.

  Icon colour stays neutral: an occasion is not a food, so it has no
  hue, and the selected row is marked by the brand tint + check exactly
  like the sort menu (DESIGN.md "Selection and actions"). -->
  <FilterDropdown
  :options="mealOptions"
  :selected-index="mealSelectedIndex"
  label="Meal type"
  trigger-test="mealtype-button"
  menu-test="mealtype-menu"
  :option-test="(o) => `mealtype-option-${o.label}`"
  menu-width="w-56"
  :active="filters.mealType !== null"
  @select="setMealType"
  >
  <template #icon>
  <component
  :is="ANY_MEAL_ICON"
  v-if="selectedMealRole === null"
  :size="16"
  aria-hidden="true"
  />
  <HueIcon v-else :role="selectedMealRole" :size="16" />
  </template>
  </FilterDropdown>
  </div>

  <!-- WS2: ONE filter surface. The former "All diets" dropdown is gone;
  the protein slice it used to own is the first chip group here, and
  the diet rules follow beneath it. On a PHONE each GROUP is one
  scrollable line instead of three wrapped ones: at 390px the wrap pushed
  the first food off the screen entirely, and food is the point of this
  tab. From `sm` up they wrap exactly as before.

  The outer box only STACKS the two groups — it must never be the
  scroller, or the diet row scrolls away out of sight beside the
  protein row. -->
  <div
  class="space-y-2"
  role="group"
  aria-label="Quick filters"
  data-test="quick-filters"
  >
  <div
  class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:items-center sm:overflow-visible sm:px-0 sm:pb-0"
  role="group"
  aria-label="Protein filters"
  data-test="protein-filters"
  >
  <!-- ADR-0069: chips are ALWAYS tinted. Idle = 8% hue tint + hue text
  (the food hue IS the chip's identity at rest); selected = brand tint
  + brand text + brand keyline. "Any" has no hue and stays neutral. -->
  <button
  v-for="p in PROTEIN_OPTIONS"
  :key="p.value || 'any'"
  type="button"
  :data-test="`protein-chip-${p.value || 'any'}`"
  class="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 text-sm font-medium whitespace-nowrap transition-colors"
  :class="
  filters.protein === p.value
  ? 'border-brand-text bg-brand-tint text-brand-text'
  : [PROTEIN_ICONS[p.value].cls, 'chip-tint border-transparent']
  "
  :aria-pressed="filters.protein === p.value"
  :aria-label="`Protein: ${p.label}`"
  @click="setProtein(p.value)"
  >
  <component
  :is="PROTEIN_ICONS[p.value].icon"
  :size="14"
  :class="PROTEIN_ICONS[p.value].cls"
  aria-hidden="true"
  />
  {{ p.label }}
  </button>
  </div>

  <div
  class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:items-center sm:overflow-visible sm:px-0 sm:pb-0"
  role="group"
  aria-label="Diet filters"
  data-test="diet-filters"
  >
  <!-- ADR-0069 always-tinted idle (8% hue tint + hue text; exclusions
  keep their explicit wording beside the borrowed hue); selected is
  brand tint + brand text, never a filled food hue. -->
  <button
  v-for="d in DIET_IDS"
  :key="d"
  type="button"
  :data-test="`diet-chip-${d}`"
  class="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 text-sm font-medium whitespace-nowrap transition-colors"
  :class="
  activeDiets.includes(d)
  ? 'border-brand-text bg-brand-tint text-brand-text'
  : [DIET_ICONS[d].cls, 'chip-tint border-transparent']
  "
  :aria-pressed="activeDiets.includes(d)"
  :aria-label="`${DIET_LABELS[d]}: ${DIET_DESCRIPTIONS[d]}`"
  @click="toggleDiet(d)"
  >
  <!-- The role hue is the icon's IDENTITY and survives selection
  (DESIGN.md "Selection and actions"): the selected chip is a TINT,
  never a fill, so the icon keeps `DIET_ICONS[d].cls` in BOTH states. -->
  <component
  :is="DIET_ICONS[d].icon"
  :size="14"
  :class="DIET_ICONS[d].cls"
  aria-hidden="true"
  />
  {{ dietChipLabel(d, dietCounts[d]) }}
  </button>
  </div>
  </div>

  <p class="font-mono-data text-xs tabular-nums text-text-muted">
  {{ results.list.length }} recipe{{ results.list.length === 1 ? '' : 's' }}
  <button
  v-if="filtersActive"
  class="ml-2 text-brand-text underline"
  @click="clearFilters"
  >
  Clear filters
  </button>
  </p>

  <!-- Grid (DESIGN.md Layout): ONE column below 360px, two from 360px,
  three from 720px, four from 1024px. There is no five-column
  stage — at the 1100px cap a fifth column makes the cards narrow
  exactly when their metadata grew. 12px gaps on phones, 20px on
  desktop. -->
  <div
  class="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 min-[720px]:grid-cols-3 min-[1024px]:grid-cols-4 min-[1024px]:gap-5"
  data-test="recipe-grid"

  >
  <template v-if="searchResults">
  <RecipeCard
  v-for="meta in visiblePrimaryResults"
  :key="meta.id"
  :meta="meta"
  />
  <div
  v-if="visibleFallbackResults.length > 0"
  data-test="more-results"
  class="col-span-full py-2 text-center text-xs text-text-muted"
  >
  More results
  </div>
  <RecipeCard
  v-for="meta in visibleFallbackResults"
  :key="meta.id"
  :meta="meta"
  />
  </template>
  <template v-else>
  <RecipeCard v-for="meta in visibleResults" :key="meta.id" :meta="meta" />
  </template>
  </div>

  <div
  v-if="hasMore"
  ref="sentinel"
  class="py-4 text-center text-xs text-text-muted"
  aria-live="polite"
  >
  Loading more recipes…
  </div>

  <div v-if="results.list.length === 0 && !searchPending" class="py-16 text-center text-text-muted">
  <SearchX :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">No recipes match your filters</p>
  <!-- ADR-0070 Addendum 1: the hint no longer dead-ends as static
  text — it OPENS the disclosure, so a reader who got here with a
  too-clever query has a way out of it. -->
  <p v-if="query.trim()" class="mt-2 text-sm">
  <button
  class="rounded-lg px-2 py-1 font-medium text-brand-text underline hover:bg-surface-sunken"
  data-test="search-empty-tip"
  :aria-expanded="showTips"
  aria-controls="search-tips-panel"
  @click="toggleTips"
  >
  Show search tips
  </button>
  </p>
  </div>
  </section>
</template>
