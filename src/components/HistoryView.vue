<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarSearch, ChefHat, Clock, RefreshCw, Search } from 'lucide-vue-next'
import { catalog } from '../lib/catalog'
import {
  filterHistoryEvents,
  formatAbsolute,
  formatRelative,
  groupHistoryByPlan,
  summarizeHistory,
} from '../lib/history'
import { imageSrc, onImgError } from '../lib/images'
import type { VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'
import TooltipBubble from './TooltipBubble.vue'
import HueIcon from './HueIcon.vue'
import { ICON_ROLES, ingredientRole } from '../lib/palette'

const router = useRouter()
const plan = usePlanStore()
const ui = useUiStore()

/** Catalog meta attached to each aggregated row (missing recipes drop). */
interface Row {
  variantId: number
  count: number
  lastAt: number
  meta: VariantMeta
}

/**
 * The cook events grouped by the plan they were cooked under, most recent
 * plan first (ADR-0034). A NEW read-side view, not a second storage: the
 * per-recipe rows above are the same events aggregated by recipe, and both
 * views are derived from `plan.cookedHistory`. A recipe cooked in two plans
 * legitimately appears under both.
 */
interface Group {
  key: string
  planId: string | null
  planCreatedAt: number | null
  lastAt: number
  count: number
  rows: Row[]
}

const groups = computed<Group[]>(() => {
  const c = catalog.value
  if (!c) return []
  return groupHistoryByPlan(windowedEvents.value).map((g) => {
  const rows = g.entries.flatMap((e) => {
  const meta = c.byId.get(e.variantId)
  return meta ? [{ ...e, meta }] : []
  })
  return {
  key: g.planId ?? 'earlier-cooks',
  planId: g.planId,
  planCreatedAt: g.planCreatedAt,
  lastAt: g.lastAt,
  count: g.events.length,
  // A group whose recipes all left the catalog renders nothing; drop
  // it rather than showing an empty heading.
  rows,
  }
  }).filter((g) => g.rows.length > 0)
})

/** "Planned 3 days ago" / "Earlier cooks" heading for one group. */
function groupTitle(g: Group): string {
  if (g.planCreatedAt === null) return g.planId ? 'Cooked plan' : 'Earlier cooks'
  return `Planned ${formatRelative(g.planCreatedAt)}`
}

function openRecipe(id: number) {
  void router.push({ name: 'recipe', params: { id: String(id) } })
}

/** The ingredient-TYPE hue beside a card's title (ADR-0036/0077): real
 *  category data, the same registry the cards and the detail sheet use. */
function roleFor(row: Row) {
  return ingredientRole(catalog.value?.dataById.get(row.variantId)?.category_name)
}

/** Date-only voice for the group rule ("Feb 18, 2025"): the render's mono
 *  date chip. `formatAbsolute` carries the time too, which the group rule
 *  does not want; the per-card tooltip keeps the full stamp. */
function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/* ---------- Client-side name filter (ADR-0077) ----------
 *
 * The render pairs the period pills with a search well. Like the period,
 * this is a QUESTION, not a preference: ephemeral view state — never
 * persisted, never in QuickFilters (that object is the Recipes surface),
 * never room-synced. It narrows the VISIBLE rows only; nothing in storage
 * is filtered, and the period keeps its own meaning.
 */
const query = ref('')

const filteredGroups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return groups.value
  return groups.value
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.meta.name.toLowerCase().includes(q)) }))
    .filter((g) => g.rows.length > 0)
})

/** Re-plan the meal at the remembered default servings (ADR-0037) — same
 *  flow as the detail view, and no per-recipe stepper is offered here, so
 *  this is the only sensible count. Was the authored `serving_count`. */
function addToPlan(row: Row) {
  plan.addToPlan(row.meta, ui.defaultServings)
  ui.showToast(`Added ${row.meta.name} to plan`)
}

/* ---------- Period pills (EXPERIENCE.md §7; ADR-0069 pill geometry) ---------- */

/**
 * The log's read window. Like the search query, this is a QUESTION, not a
 * household preference: ephemeral view state — never persisted, never in
 * QuickFilters (that object is the Recipes-tab surface) and never
 * room-synced. The pills only choose which slice of `cookedHistory` the
 * grouping re-derives from; nothing in storage is filtered.
 */
interface Period {
  id: 'all' | '30' | '90'
  label: string
  days: number | null
}
const PERIODS: Period[] = [
  { id: 'all', label: 'All time', days: null },
  { id: '30', label: 'Past 30 days', days: 30 },
  { id: '90', label: 'Past 90 days', days: 90 },
]
const period = ref<Period>(PERIODS[0]!)

/** The windowed event slice; the grouping and the summary both derive. */
const windowedEvents = computed(() =>
  filterHistoryEvents(plan.cookedHistory, period.value.days),
)

/** Factual totals for the chosen window — counts, never ranks: no
 *  streaks, no badges, nothing the roster rule calls gamification. */
const summary = computed(() => summarizeHistory(windowedEvents.value))

/** Does this household have ANY cook at all, window or not? */
const hasAnyCook = computed(() => plan.cookedHistory.length > 0)
</script>

<template>
  <section class="space-y-4" aria-label="Cooking history">
  <!-- Editorial head (ADR-0075 rule 1, ADR-0077): the tab opens with the
       display step of the ladder — the mock's H1 is the tab's largest
       type — over the subtitle that says what the log IS. No invented
       copy; the subtitle is the same one sentence. -->
  <header class="space-y-1">
  <h1 class="text-headline-lg-mobile sm:text-headline-lg">Cooking history</h1>
  <p class="text-body-sm text-text-muted">
  A private record of the meals you have cooked at home and with your household.
  </p>
  </header>

  <!-- Sharing-status CHIP (ADR-0032, default ON): the render states the
       sharing fact as a compact bordered chip beside the head, not a
       full-width paragraph. The toggle itself lives in Settings (ADR-0016)
  and this chip points there — one control, never duplicated; no room
  code is printed because the app header's room chip already carries it
  on this surface (ADR-0075: the pill appears ONCE per surface). -->
  <p
  class="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-label-md text-text"
  data-test="history-sync-note"
  >
  <RefreshCw :size="15" class="shrink-0 text-success" aria-hidden="true" />
  <span class="min-w-0">
  Shared with your household — every phone contributes to one cooking log. Turn off
  <strong>“Sync cooked history”</strong> in Settings → Household sync.
  </span>
  </p>

  <div
  v-if="groups.length === 0 && !hasAnyCook"
  class="rounded-xl bg-surface-raised py-16 text-center text-text-muted ring-1 ring-border"
  data-test="history-empty"
  >
  <ChefHat :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">Nothing cooked yet</p>
  <p class="mx-auto mt-1 max-w-xs text-body-sm">Mark meals as cooked when you finish them.</p>
  <button
  class="mt-4 min-h-11 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98]"
  @click="router.push('/')"
  >
  Browse recipes
  </button>
  </div>

  <!-- The PERIOD PILLS + the search well sit OUTSIDE both branches on
       purpose: an empty 30/90-day window must never remove the only
       control that gets the reader back to "All time", and a household
       whose whole log is older than the window is not the same fact as a
       household with no log. The search is the render's pairing — pills
       left, well right, one row from `sm` up. It is a plain `.field` (the
       generic well): the tab's BIGGEST control treatment is the Recipes
       tab's (ADR-0077), this is a utility filter. -->
  <div v-if="hasAnyCook" class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
    <div
      class="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="History period"
      data-test="history-period"
    >
      <button
        v-for="p in PERIODS"
        :key="p.id"
        class="min-h-11 rounded-full border px-3 py-1 text-xs font-semibold transition-colors"
        :class="
          period.id === p.id
            ? 'border-brand bg-brand-tint text-brand-text'
            : 'border-border bg-surface-sunken text-text-muted'
        "
        :aria-pressed="period.id === p.id"
        :aria-label="`Show the ${p.label.toLowerCase()} history`"
        :data-test="`history-period-${p.id}`"
        @click="period = p"
      >
        {{ p.label }}
      </button>
    </div>
    <div class="relative sm:w-72">
      <Search
        :size="16"
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <input
        v-model="query"
        type="search"
        placeholder="Filter cooked recipes…"
        class="field w-full pl-9 pr-3"
        aria-label="Filter cooked recipes by name"
        data-test="history-search"
      />
    </div>
  </div>

  <!-- An empty WINDOW is not an empty log: say so, and keep the pills. -->
  <div
    v-if="hasAnyCook && groups.length === 0"
    class="rounded-xl bg-surface-raised py-16 text-center text-text-muted ring-1 ring-border"
    data-test="history-empty-window"
  >
    <CalendarSearch :size="40" class="mx-auto" aria-hidden="true" />
    <p class="mt-2 font-medium">Nothing cooked in this window</p>
    <p class="mx-auto mt-1 max-w-xs text-body-sm">
      Your earlier cooks are still here — widen the period above to see them.
    </p>
  </div>

  <template v-else-if="groups.length > 0">
  <!-- The window's DATA numbers (counts, never ranks — no streaks, no
       badges): total cooks, distinct dishes, most recent. The render's
       3-cell strip: keyline-divided cells (the `bg-border` gap trick,
       ADR-0077), UPPERCASE mono labels, headline-step numbers in the mono
       DATA voice (ADR-0066). -->
  <div
  class="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border text-center"
  data-test="history-summary"
  >
  <div class="flex flex-col gap-0.5 bg-surface-raised p-3">
  <p class="font-mono-data text-[11px] font-medium uppercase tracking-wider text-text-muted">Cooks logged</p>
  <p class="text-headline-md font-bold font-mono-data tabular-nums text-text">{{ summary.total }}</p>
  </div>
  <div class="flex flex-col gap-0.5 bg-surface-raised p-3">
  <p class="font-mono-data text-[11px] font-medium uppercase tracking-wider text-text-muted">Distinct dishes</p>
  <p class="text-headline-md font-bold font-mono-data tabular-nums text-text">{{ summary.dishes }}</p>
  </div>
  <div class="flex flex-col gap-0.5 bg-surface-raised p-3">
  <p class="font-mono-data text-[11px] font-medium uppercase tracking-wider text-text-muted">Most recent</p>
  <p class="text-headline-md font-bold font-mono-data tabular-nums text-text">
  {{ summary.lastAt === null ? '—' : formatRelative(summary.lastAt) }}
  </p>
  </div>
  </div>

  <!-- A filter that matches nothing is not an empty log either (ADR-0077):
       say what cleared, and keep both the pills and the search above. -->
  <div
  v-if="filteredGroups.length === 0"
  class="rounded-xl bg-surface-raised py-12 text-center text-text-muted ring-1 ring-border"
  data-test="history-no-matches"
  >
  <CalendarSearch :size="32" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">No cooked recipe matches “{{ query.trim() }}”</p>
  <p class="mx-auto mt-1 max-w-xs text-body-sm">Clear the filter above to see the whole window.</p>
  </div>

  <div v-else class="space-y-8">
  <section
  v-for="group in filteredGroups"
  :key="group.key"
  class="space-y-3"
  :data-test="group.planId ? `history-group-${group.planId}` : 'history-group-legacy'"
  >
  <!-- What plan this batch was, and when it was put together
  (ADR-0034). The absolute date lives in the title: the
  relative one is the one that reads well in a list. -->
  <!-- ADR-0055: the absolute date lives in the bubble now (hover only —
  the h2 is not focusable, same parity the native title had). The bubble
  is a DESCENDANT of the group host (group-hover is a descendant
  selector); the h2's textContent is only asserted with toContainText,
  which tolerates it. -->
  <!-- What plan this batch was, and when it was put together
       (ADR-0034). The absolute date lives in the bubble: the relative
       one is the one that reads well in a list. The COUNT is the DATA
       voice (ADR-0066) — mono, beside the prose head, under a warm
       rule the way the render's group headers separate. -->
  <!-- The render's group rule: a warm rule under a header row — the plan
       title (ADR-0034's provenance, kept: a cook event belongs to a plan
  and the render's "Unscheduled Plan #14" numbering is fiction), the mono
  cook count, and the ABSOLUTE date in a mono chip when the plan has one.
  The rule's right end carries the group's most recent cook, relative. -->
  <div class="flex items-center justify-between gap-2 border-b border-border pb-2">
  <div class="flex min-w-0 flex-wrap items-center gap-2">
  <h2
  class="group relative flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
  data-test="history-group-title"
  >
  {{ groupTitle(group) }}
  <span class="font-normal font-mono-data normal-case tabular-nums">
  {{ group.count === 1 ? '1 cook' : `${group.count} cooks` }}
  </span>
  <TooltipBubble
  :text="group.planCreatedAt === null ? '' : `Planned ${formatAbsolute(group.planCreatedAt)}`"
  placement="below-right"
  />
  </h2>
  <span
  v-if="group.planCreatedAt !== null"
  class="rounded bg-brand-tint px-1.5 py-0.5 font-mono-data text-label-sm font-semibold tabular-nums text-brand-text"
  data-test="history-group-date"
  >{{ formatDay(group.planCreatedAt) }}</span
  >
  </div>
  <span class="shrink-0 font-mono-data text-label-sm tabular-nums text-text-muted">
  {{ formatRelative(group.lastAt) }}
  </span>
  </div>
  <!-- The render's meal cards: a photo-card grid (3 across on desktop,
  one on a phone) instead of one compact ribbon row per dish. The card
  carries the count ON the photo (the ADR-0074 espresso-disc overlay),
  the mono date under the title, and the real facts + action in a
  footer rule. The render's per-card filled tomato is NOT adopted — the
  tab's ONE filled intent stays the empty state's Browse recipes
  (ADR-0036/0072) — so Add to plan keeps the outlined secondary. -->
  <ul class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
  <li
  v-for="row in group.rows"
  :key="`${group.key}-${row.variantId}`"
  class="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border"
  data-test="history-row"
  >
  <div class="relative">
  <img
  :src="imageSrc(row.meta.thumbnail_image_url)"
  :alt="row.meta.name"
  loading="lazy"
  class="aspect-[4/3] w-full hovercap:cursor-pointer object-cover"
  @error="onImgError"
  @click="openRecipe(row.variantId)"
  />
  <!-- Cooked N×: the DATA voice on the photo, the ADR-0074 disc
  grammar (espresso disc, white mono text). -->
  <span
  class="absolute right-2.5 top-2.5 rounded-full bg-espresso px-2 py-0.5 font-mono-data text-label-sm text-on-brand"
  :data-test="`history-count-${row.variantId}`"
  >
  Cooked {{ row.count }}×
  </span>
  </div>
  <div class="flex flex-col gap-1.5 p-3.5">
  <div class="flex items-start justify-between gap-2">
  <h3
  class="line-clamp-2 hovercap:cursor-pointer text-headline-sm font-bold leading-snug"
  @click="openRecipe(row.variantId)"
  >{{ row.meta.name }}</h3>
  <HueIcon
  v-if="roleFor(row)"
  :role="roleFor(row)!"
  :size="18"
  :label="ICON_ROLES[roleFor(row)!].label"
  tap-reveal
  />
  </div>
  <!-- Date: mono, relative; the absolute stamp is the bubble
  (ADR-0055 — the h3 is not focusable, hover-only parity). -->
  <p class="group relative flex items-center gap-1.5 font-mono-data text-label-md tabular-nums text-text-muted">
  <Clock :size="14" aria-hidden="true" />
  {{ formatRelative(row.lastAt) }}
  <TooltipBubble :text="formatAbsolute(row.lastAt)" placement="below-right" />
  </p>
  <div class="mt-1 flex items-center justify-between gap-2 border-t border-border pt-2.5">
  <span class="font-mono-data text-label-md tabular-nums text-text-muted">
  {{ row.meta.cooking_minutes }} min
  </span>
  <button
  class="min-h-11 shrink-0 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs font-semibold text-brand-text hover:bg-surface-sunken"
  :aria-label="`Add ${row.meta.name} to plan`"
  :data-test="`history-add-${row.variantId}`"
  @click="addToPlan(row)"
  >
  Add to plan
  </button>
  </div>
  </div>
  </li>
  </ul>
  </section>
  </div>
  </template>
  </section>
</template>
