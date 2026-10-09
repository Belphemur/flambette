<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChefHat, RefreshCw } from 'lucide-vue-next'
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
</script>

<template>
  <section class="space-y-4" aria-label="Cooking history">
  <!-- Page head (EXPERIENCE.md §7): the tab has never had one, and the
       editorial head says what the log IS before the pills narrow it. -->
  <header class="space-y-1">
  <h1 class="text-headline-sm">Cooking history</h1>
  <p class="text-body-sm text-text-muted">
  A private record of the meals you have cooked at home and with your household.
  </p>
  </header>

  <!-- Sharing-status note (ADR-0032, default ON): WHAT the tab is, said
       once, tonal — the toggle itself lives in Settings (ADR-0016), and
       this note points there without duplicating the control. -->
  <p
  class="flex items-start gap-2 rounded-xl bg-surface-sunken px-3 py-2.5 text-body-sm text-text-muted"
  data-test="history-sync-note"
  >
  <RefreshCw :size="14" class="mt-1 shrink-0" aria-hidden="true" />
  <span>
  Shared with your household by default — every phone in the room contributes to one cooking log, and histories
  merge rather than overwrite each other. Turn off
  <strong>“Sync cooked history”</strong> in Settings → Household sync to stop sharing new cooks — cooks shared
  earlier stay in the room, so this controls what goes out from here, not what has already been shared.
  </span>
  </p>

  <div
  v-if="groups.length === 0"
  class="rounded-xl bg-surface-raised py-16 text-center text-text-muted ring-1 ring-border"
  data-test="history-empty"
  >
  <ChefHat :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">Nothing cooked yet</p>
  <p class="mx-auto mt-1 max-w-xs text-body-sm">Mark meals as cooked when you finish them.</p>
  <button
  class="mt-4 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98]"
  @click="router.push('/')"
  >
  Browse recipes
  </button>
  </div>

  <template v-else>
  <!-- The window's DATA numbers (counts, never ranks — no streaks, no
       badges): total cooks, distinct dishes, most recent. Same tonal
       strip language as the Plan tab's totals, numbers in the mono
       DATA voice (ADR-0066). -->
  <div
  class="grid grid-cols-3 gap-2 rounded-xl p-4 text-center ring-1 ring-border"
  data-test="history-summary"
  >
  <div>
  <p class="text-lg font-bold font-mono-data tabular-nums text-brand-text">{{ summary.total }}</p>
  <p class="mt-0.5 text-xs text-text-muted">cooks logged</p>
  </div>
  <div>
  <p class="text-lg font-bold font-mono-data tabular-nums text-brand-text">{{ summary.dishes }}</p>
  <p class="mt-0.5 text-xs text-text-muted">distinct dishes</p>
  </div>
  <div>
  <p class="text-sm font-semibold font-mono-data tabular-nums text-brand-text">
  {{ summary.lastAt === null ? '—' : formatRelative(summary.lastAt) }}
  </p>
  <p class="mt-0.5 text-xs text-text-muted">most recent</p>
  </div>
  </div>

  <!-- Period pills (ADR-0069): 9999px, tinted selection. Selection is
       always brand; idle keeps the tonal surface. A read window, not a
       preference — ephemeral view state, like the search query. -->
  <div class="flex flex-wrap items-center gap-2" role="group" aria-label="History period" data-test="history-period">
  <button
  v-for="p in PERIODS"
  :key="p.id"
  class="rounded-full border px-3 py-1 text-xs font-semibold transition-colors"
  :class="
  period.id === p.id
    ? 'border-primary-tint bg-primary-tint text-primary-strong'
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
  </template>

  <div v-if="groups.length > 0" class="space-y-5">
  <section
  v-for="group in groups"
  :key="group.key"
  class="space-y-2"
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
  <h2
  class="group relative flex items-baseline gap-2 border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted"
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
  <ul class="space-y-2">
  <li
  v-for="row in group.rows"
  :key="`${group.key}-${row.variantId}`"
  class="flex items-center gap-3 rounded-xl bg-surface-raised p-2.5 ring-1 ring-border"
  data-test="history-row"
  >
  <img
  :src="imageSrc(row.meta.thumbnail_image_url)"
  :alt="row.meta.name"
  loading="lazy"
  class="size-16 shrink-0 hovercap:cursor-pointer rounded-lg object-cover"
  @error="onImgError"
  @click="openRecipe(row.variantId)"
  />
  <div class="min-w-0 flex-1 hovercap:cursor-pointer" @click="openRecipe(row.variantId)">
  <h3 class="line-clamp-2 text-sm font-semibold">{{ row.meta.name }}</h3>
  <!-- Count pill + date: the DATA voice (ADR-0066). The pill is the
       brand TINT (selection-adjacent emphasis is not a fill — the tab's
       one filled tomato is the empty state's Browse recipes), the date
       rides mono beside it. -->
  <p
  class="group relative mt-0.5 flex items-center text-xs text-text-muted"
  >
  <!-- ADR-0055: the absolute date — a descendant of the group host,
  below-right of it. -->
  <span
  class="mr-1.5 rounded-full bg-primary-tint px-2 py-px text-[10px] font-bold text-primary-strong"
  :data-test="`history-count-${row.variantId}`"
  >
  {{ row.count === 1 ? 'cooked once' : `cooked ${row.count} times` }}
  </span>
  <span class="font-mono-data tabular-nums">{{ formatRelative(row.lastAt) }}</span>
  <TooltipBubble :text="formatAbsolute(row.lastAt)" placement="below-right" />
  </p>
  </div>
  <button
  class="shrink-0 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs font-semibold text-brand-text hover:bg-surface-sunken"
  :aria-label="`Add ${row.meta.name} to plan`"
  :data-test="`history-add-${row.variantId}`"
  @click="addToPlan(row)"
  >
  Add to plan
  </button>
  </li>
  </ul>
  </section>
  </div>
  </section>
</template>
