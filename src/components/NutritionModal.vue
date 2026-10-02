<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import {
  ENERGY_ROW,
  formatNutritionValue,
  macroSplit,
  nutritionGroups,
  unitFor,
  type NutritionGroup,
} from '../lib/nutrition'
import type { Nutrition } from '../lib/types'

/**
 * The per-serving nutrition FACTS modal (ADR-0039).
 *
 * Everything it shows comes from the offline recipe document's
 * `nutrition` block — no fetch, no new dependency, no store slice. The
 * detail's own nutrition section stays a summary plus this trigger, so
 * the detail view does not grow a 66-row wall (its e2e position contract
 * is unchanged by construction).
 *
 * The donut is percent-of-CALORIES (4/4/9 kcal per gram), derived by
 * `macroSplit`, which can refuse: a doc whose macros do not account for
 * its stated energy shows the calorie centre and says so, rather than
 * drawing a ring that implies a split nobody published.
 */
const props = defineProps<{
  nutrition: Nutrition
  /** `meta.calories` — the same per-serving number the detail shows. */
  calories: number
}>()

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

/**
 * Focus MANAGEMENT, not just focus placement (a11y: `aria-modal="true"`
 * is a promise). Three rules, all on this component because RecipeDetail
 * mounts it `v-if`-gated so one mount == one open:
 *
 *  1. remember the trigger (`document.activeElement`) before focus moves
 *     in, and restore it on EVERY close path — unmount covers the close
 *     button, Escape, the scrim and a parent-driven close alike;
 *  2. TRAP Tab inside the panel: the modal is teleported to `body`, so
 *     without this Tab walks into the still-mounted recipe detail behind
 *     the backdrop;
 *  3. keep the panel itself focusable as the last stop, so Shift+Tab from
 *     the first control wraps to the end instead of escaping.
 */
let restoreFocusTo: HTMLElement | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  return panel.value
    ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    : []
}

function trapTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !panel.value) return
  const items = [...focusables(), panel.value]
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!active || !panel.value.contains(active)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  }
}

function close() {
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
    return
  }
  trapTab(e)
}

onMounted(() => {
  restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKey)
  void nextTick(() => panel.value?.focus())
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  const target = restoreFocusTo
  restoreFocusTo = null
  if (!target) return
  void nextTick(() => {
    if (document.contains(target)) target.focus()
    else document.body.focus?.()
  })
})

/** Per serving, never scaled (ADR-0004). */
const energy = computed(() =>
  Number.isFinite(props.nutrition.energy) && props.nutrition.energy > 0
    ? props.nutrition.energy
    : props.calories,
)
const kcal = computed(() => Math.round(energy.value))

const split = computed(() => macroSplit(props.nutrition))

/**
 * Donut geometry: a 100-unit path with `pathLength="100"`, so each arc is
 * a plain percentage of the circumference and the three offsets are just
 * the running sum. No chart runtime for one ring (ADR-0039 alternatives).
 */
const RADIUS = 15.915 // 2πr = 100 at this r, kept explicit for the reader
const arcs = computed(() => {
  const s = split.value
  if (!s) return []
  const parts = [
    {
      id: 'fat',
      pct: s.fatPct * 100,
      className: 'text-nutrition-fat',
      dotClass: 'bg-nutrition-fat',
      label: 'Fats',
    },
    {
      id: 'carbs',
      pct: s.carbPct * 100,
      className: 'text-nutrition-carbs',
      dotClass: 'bg-nutrition-carbs',
      label: 'Carbs',
    },
    {
      id: 'protein',
      pct: s.proteinPct * 100,
      className: 'text-nutrition-protein',
      dotClass: 'bg-nutrition-protein',
      label: 'Protein',
    },
  ]
  let offset = 0
  return parts.map((p) => {
    const arc = { ...p, offset, dash: `${p.pct} ${100 - p.pct}` }
    offset += p.pct
    return arc
  })
})

/** Whole-percent legend labels, the e2e-visible contract. */
const legend = computed(() =>
  arcs.value.map((a) => ({
    id: a.id,
    label: a.label,
    className: a.className,
    dotClass: a.dotClass,
    pct: Math.round(a.pct),
  })),
)

const groups = computed<NutritionGroup[]>(() => nutritionGroups(props.nutrition))

/** Disclosures, keyed by group id; seeded from the layout's own default. */
const open = ref<Record<string, boolean>>({})
function isOpen(group: NutritionGroup): boolean {
  return open.value[group.id] ?? !group.collapsedByDefault
}
function toggle(group: NutritionGroup) {
  open.value = { ...open.value, [group.id]: !isOpen(group) }
}

const energyDisplay = computed(() =>
  formatNutritionValue(energy.value, unitFor(ENERGY_ROW.key)),
)
</script>

<template>
  <div
  class="fixed inset-0 z-50 flex items-end justify-center bg-surface-dark/50 sm:items-center"
  @click.self="close"
  >
  <div
  ref="panel"
  tabindex="-1"
  class="max-h-[85vh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-surface-raised p-4 shadow-xl outline-none sm:rounded-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Nutrition facts"
  data-test="nutrition-modal"
  >
  <div class="flex items-start justify-between gap-3">
  <div>
  <h3 class="text-body-sm font-bold tracking-tight">Nutrition facts</h3>
  <p class="text-label-md text-text-muted">per serving</p>
  </div>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-sunken"
  aria-label="Close nutrition facts"
  data-test="nutrition-modal-close"
  @click="close"
  >
  <X :size="18" aria-hidden="true" />
  </button>
  </div>

  <!-- Percent-of-calories donut. The three macro hues are token
  identities for the arcs and the legend only (ADR-0039 §4): the legend
  WORD carries the name, so colour is never the only signal. -->
  <div class="mt-3 flex items-center gap-4" data-test="nutrition-donut">
  <div class="relative size-28 shrink-0">
  <svg viewBox="0 0 42 42" class="size-full" role="presentation" aria-hidden="true">
  <circle
  cx="21"
  cy="21"
  :r="RADIUS"
  pathLength="100"
  fill="none"
  stroke="currentColor"
  stroke-width="6"
  class="text-border"
  />
  <circle
  v-for="arc in arcs"
  :key="arc.id"
  cx="21"
  cy="21"
  :r="RADIUS"
  pathLength="100"
  fill="none"
  stroke-width="6"
  stroke-linecap="butt"
  :stroke-dasharray="arc.dash"
  :stroke-dashoffset="-arc.offset"
  :class="arc.className"
  stroke="currentColor"
  transform="rotate(-90 21 21)"
  />
  </svg>
  <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
  <span class="text-lg leading-tight font-bold tabular-nums" data-test="nutrition-donut-calories">
  {{ kcal }}
  </span>
  <span class="text-[10px] text-text-muted">kcal</span>
  </div>
  </div>
  <ul v-if="legend.length" class="min-w-0 flex-1 space-y-1">
  <li
  v-for="item in legend"
  :key="item.id"
  class="flex items-center gap-2 text-body-sm"
  :data-test="`nutrition-legend-${item.id}`"
  >
  <!-- The dot is PAINTED (bg-*) and the word carries the name, so the
  legend reads in monochrome too; the `text-*` twin is what the SVG arcs
  above use via `stroke="currentColor"`. -->
  <span class="size-2.5 shrink-0 rounded-full" :class="item.dotClass" aria-hidden="true"></span>
  <span class="min-w-0 flex-1">{{ item.label }}</span>
  <span class="font-semibold tabular-nums">{{ item.pct }}%</span>
  </li>
  </ul>
  <p v-else class="min-w-0 flex-1 text-body-sm text-text-muted" data-test="nutrition-split-unavailable">
  This recipe's macro calories don't add up to its stated energy, so no
  split is shown.
  </p>
  </div>

  <!-- Energy is the headline fact, above the derived split that claims to
  account for it. -->
  <p class="mt-3 border-b border-border pb-2 text-body-sm font-semibold">
  {{ ENERGY_ROW.label }}
  <span class="tabular-nums">{{ energyDisplay }} {{ unitFor(ENERGY_ROW.key) }}</span>
  </p>

  <div v-for="group in groups" :key="group.id" class="mt-3" :data-test="`nutrition-group-${group.id}`">
  <button
  class="flex min-h-11 w-full items-center gap-1 text-left text-label-md font-semibold"
  :aria-expanded="isOpen(group)"
  :data-test="`nutrition-group-toggle-${group.id}`"
  @click="toggle(group)"
  >
  <ChevronDown v-if="isOpen(group)" :size="16" aria-hidden="true" />
  <ChevronRight v-else :size="16" aria-hidden="true" />
  {{ group.title }}
  <span class="font-normal text-text-muted">({{ group.rows.length }})</span>
  </button>
  <ul v-if="isOpen(group)" class="ml-6 space-y-0.5">
  <li
  v-for="row in group.rows"
  :key="row.key"
  class="flex items-baseline gap-2 text-body-sm"
  data-test="nutrition-row"
  :data-key="row.key"
  >
  <span class="min-w-0 flex-1">{{ row.label }}</span>
  <span class="font-semibold tabular-nums">{{ formatNutritionValue(row.value, row.unit) }}</span>
  <span class="w-8 shrink-0 text-right text-label-md text-text-muted tabular-nums">{{ row.unit }}</span>
  </li>
  </ul>
  </div>

  <p class="mt-4 text-[11px] text-text-muted">
  Per serving. Totals for the number of servings you cook scale; the facts
  above do not.
  </p>
  </div>
  </div>
</template>
