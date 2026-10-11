<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Minus, Plus, Sparkles, X } from 'lucide-vue-next'
import { catalog } from '../lib/catalog'
import { imageSrc, onImgError } from '../lib/images'
import { MAX_MEALS, MIN_MEALS, type PackProposal } from '../lib/packPlanner'
import { runAutoPlanProposals } from '../composables/useAutoPlan'
import { OFFERED_MEAL_TYPES } from '../lib/mealTypeFilter'
import { mealRole, proteinRole } from '../lib/palette'
import { usePlanStore } from '../stores/plan'
import { useFavouritesStore } from '../stores/favourites'
import { useUiStore, type AutoPlanRuleset } from '../stores/ui'
import FilterDropdown from './FilterDropdown.vue'
import TooltipBubble from './TooltipBubble.vue'
import type { FilterDropdownOption } from './FilterDropdown.vue'

/**
 * The Auto-Plan dialog as its OWN component (ADR-0046 §2.1). It used to be
 * a ~350-line inline block inside `PlanTab.vue` — one behaviour with one
 * state machine (preview-invalidation watch, ADR-0033 generation rules,
 * confirm/undo) living inside a component whose main job is the plan list.
 * This is a PURE MOVE: every handler, guard and data-test hook moved
 * verbatim, with the two exceptions the ADR orders —
 *
 *  - the two native `<select>`s are now `FilterDropdown`s (ADR-0045's
 *    component, consumed a fourth and fifth time), and
 *  - the meal-type options come from `mealTypeFilter`'s exports instead of
 *    a second hard-coded copy of the taxonomy — the local list was the
 *    copy that had already drifted (Lunch/Snack unreachable).
 *
 * The Mode segmented control STAYS a radio group: a 2-choice toggle is not
 * a dropdown (forcing it into FilterDropdown would be KISS loss, not DRY
 * gain — ADR-0046 §2.2).
 *
 * Planner arithmetic is UNTOUCHED (ADR-0046 Part 1: the algorithm review
 * is closed; K1-K3 are documented as kept). ADR-0080 layers the PROPOSAL
 * preview on top: the dialog now renders one card per proposal (waste-
 * ranked, cheapest pre-selected) and applies only the selected one. The
 * e2e dinner pins (re-pinned under ADR-0080) remain the regression gate
 * for the arithmetic itself.
 */

const plan = usePlanStore()
const ui = useUiStore()
/** ADR-0031: the favourites set is a ranking signal, so the preview says
 *  how many of them are in play. */
const favourites = useFavouritesStore()
const favouritesCount = computed(() => favourites.ids.size)

const autoPlanOpen = ref(false)
const autoPlanCount = ref(4)
const autoPlanCategory = ref<'' | 'meat' | 'fish' | 'vegetarian'>('')
const autoPlanBusy = ref(false)
// Ruleset + mode live in the UI STORE (persisted, ADR-0027); the dialog
// binds them through the store refs.
/** After Generate: the pending PROPOSALS awaiting the confirm step (ADR-0080). */
const pendingProposals = ref<{ proposals: PackProposal[]; eligibleCount: number } | null>(null)

/**
 * Which proposal card is selected — EPHEMERAL view state (ADR-0080
 * Decision 5, like the search query): never persisted, never room-synced,
 * no STORE_SLICES change. Reset to the CHEAPEST proposal whenever a new
 * set arrives.
 */
const selectedProposal = ref(0)

/**
 * ADR-0080 Decision 1 made visible: the CHEAPEST proposal is pre-selected.
 * Ties resolve to the first card in the ranked array — the lib already
 * orders the rated proposals packagesBought-ASC → rating-DESC → id-ASC,
 * and the continuity proposal (pinned #1) wins an exact tie.
 */
function preselectedProposalIndex(proposals: PackProposal[]): number {
  let best = 0
  for (let i = 1; i < proposals.length; i++) {
    if (proposals[i].packagesBought < proposals[best].packagesBought) best = i
  }
  return best
}

/** PlanTab's trigger buttons open the dialog; everything else is internal. */
function openAutoPlan() {
  pendingProposals.value = null
  selectedProposal.value = 0
  autoPlanOpen.value = true
}

function closeAutoPlan() {
  autoPlanOpen.value = false
  pendingProposals.value = null
}

defineExpose({ open: openAutoPlan })

// Changed choices invalidate the confirmable pack: the visible result
// must always belong to the settings on screen (qodo thread 4).
watch(
  [
  autoPlanCount,
  autoPlanCategory,
  () => ui.autoPlanMode,
  () => ui.autoPlanRuleset,
  ],
  () => {
  pendingProposals.value = null
  },
)

async function generateAutoPlan() {
  if (autoPlanBusy.value) return
  autoPlanBusy.value = true
  // A REGENERATE press must roll the seed: re-running the stored
  // generation would rebuild the IDENTICAL pack, which makes the button a
  // dead affordance (ADR-0033) — the user's mental model is "this rolls a
  // new plan". The first press of a dialog still reads "Generate" and has
  // no earlier pack to differ from, so it keeps the stored generation
  // (fresh state → generation 0 → the pinned default pack).
  //
  // The advance is SYNCHRONOUS, before the planner runs, so the generation
  // captured below is already the fresh one and the staleness re-check
  // after the await still works: every press bumps the counter exactly
  // once, and a failed or raced rebuild only costs a skipped seed value
  // (the seed is `generation mod ROTATION_K`, so a gap changes which pack
  // comes next, never the integrity of one that did resolve).
  if (pendingProposals.value) ui.advanceAutoPlanGeneration()
  // Pin the choices this run was made with; a result coming back after
  // the user changed any control is stale and must not apply.
  const wanted = {
  count: autoPlanCount.value,
  category: autoPlanCategory.value,
  ruleset: ui.autoPlanRuleset,
  mode: ui.autoPlanMode,
  generation: ui.nextAutoPlanGeneration(),
  }
  try {
  const result = await runAutoPlanProposals({
  count: wanted.count,
  category: wanted.category || undefined,
  ruleset: wanted.ruleset,
  mode: wanted.mode,
  seedGeneration: wanted.generation,
  })
  if (
  wanted.count !== autoPlanCount.value ||
  wanted.category !== autoPlanCategory.value ||
  wanted.ruleset !== ui.autoPlanRuleset ||
  wanted.mode !== ui.autoPlanMode ||
  wanted.generation !== ui.nextAutoPlanGeneration()
  ) {
  return
  }
  pendingProposals.value = result
  selectedProposal.value = preselectedProposalIndex(result.proposals)
  } catch {
  ui.showToast("Couldn't load the planner — try again")
  } finally {
  autoPlanBusy.value = false
  }
}

/** ADR-0080: each proposal's meals resolved to title + image (same
 * catalog + image helpers as before — offline, no new fetches). Index
 * aligns with `pendingProposals.proposals`. */
const proposalMeals = computed(() => {
  const c = catalog.value
  if (!c) return []
  return (pendingProposals.value?.proposals ?? []).map((p) =>
  p.variantIds.flatMap((id) => {
  const meta = c.byId.get(id)
  return meta ? [{ id, name: meta.name, image: meta.thumbnail_image_url, minutes: meta.cooking_minutes }] : []
  }),
  )
})

/** The proposal the confirm step will apply (ADR-0080 Decision 5). */
const selectedPack = computed(
  () => pendingProposals.value?.proposals[selectedProposal.value] ?? null,
)

/**
 * A preview tile is missing for a variant the catalog cannot resolve.
 * Confirming would then replace the plan with a meal the user never saw,
 * so the confirm button stays disabled until the preview is complete
 * (the counts line still reports the planner's own number).
 *
 * A REGENERATION in flight also blocks it (ADR-0033, qodo PR #14 thread
 * 1): the press already advanced the seed, so the pack on screen is the
 * one the user just asked to replace. Confirming it would advance the
 * counter a SECOND time (once for the press, once for the apply) and
 * land a pack that is stale by two generations. The old preview returns
 * to being confirmable on its own if the rebuild fails, because the busy
 * flag clears in the `finally`.
 */
const previewComplete = computed(
  () =>
  !!selectedPack.value &&
  !autoPlanBusy.value &&
  // An EMPTY pack (pool exhausted under the active filters) must never
  // be confirmable: in replace mode it would erase the plan (qodo
  // round 1, thread 2).
  selectedPack.value.variantIds.length > 0 &&
  (proposalMeals.value[selectedProposal.value]?.length ?? 0) ===
    selectedPack.value.variantIds.length,
)

/**
 * Radio-group keyboard support (qodo round 1): arrow keys move the
 * selection cyclically and move focus with it (roving tabindex below).
 */
async function onProposalsKeydown(event: KeyboardEvent) {
  const key = event.key
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') return
  const count = pendingProposals.value?.proposals.length ?? 0
  if (count < 2) return
  const delta = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1
  selectedProposal.value = (selectedProposal.value + delta + count) % count
  event.preventDefault()
  await nextTick()
  ;(document.querySelector('[data-test="auto-plan-proposal-selected"]') as HTMLElement | null)?.focus()
}

/** Confirm/apply step: add mode APPENDS to the current plan (no
 * destructive confirm needed); replace mode REPLACES it after the
 * preview (confirm-before-destroy, unchanged from phase 19). */
function confirmAutoPlan() {
  // The SELECTED proposal is what applies (ADR-0080 Decision 5).
  const result = selectedPack.value
  if (!result) return
  // Belt-and-braces with the `previewComplete` gate: a regeneration in
  // flight means the pack on screen is already superseded, and applying
  // it would double-advance the seed (ADR-0033).
  if (autoPlanBusy.value) return
  // An EMPTY pack (pool exhausted under the active filters) must never
  // apply: in replace mode replacePlan([]) would ERASE the user's plan
  // (qodo round 1, thread 2); in add mode it would be a no-op anyway.
  if (result.variantIds.length === 0) {
  ui.showToast('No eligible recipes for this plan')
  closeAutoPlan()
  return
  }
  // Snapshot the plan AT CONFIRM TIME, not at dialog-open: a room update
  // may have changed the plan while generation was pending, and building
  // the entries from the stale open-time copy would discard it (qodo
  // round 1, thread 1). Undo restores this exact state.
  const atConfirm = plan.plan.map((e) => ({ ...e }))
  const clearedAtConfirm = { ...plan.clearedIngredients }
  const replacing = ui.autoPlanMode === 'replace'
  // Fresh planning = fresh ingredients: re-planning a meal must forget
  // any cleared-ingredient snapshot (same rule as addToPlan, ADR v0.4
  // clear semantics) or re-planned groceries stay hidden (qodo thread 2).
  for (const variantId of result.variantIds) plan.restoreIngredients(variantId)
  // ADD mode completes the current plan: base entries stay, additions
  // land exactly like hand-added ones (authored servings; ADR-0027).
  // Dedupe against the confirm-time plan: a room peer may have planned a
  // meal while generation was pending, and the pack (built from the
  // older pool) could re-pick it (CodeRabbit round 2).
  const plannedNow = new Set(atConfirm.map((e) => e.variantId))
  const additions = result.variantIds.filter((id) => !plannedNow.has(id))
  if (additions.length === 0) {
  ui.showToast('No new meals to add — your plan already covers this pack')
  closeAutoPlan()
  return
  }
  // Every added meal lands at the remembered default (ADR-0037) instead
  // of a hardcoded authored 6, so a generated plan is already scaled for
  // this household. On an install that never set a default this is 6 —
  // bit-for-bit the previous behaviour, which is what keeps the pinned
  // e2e pack's servings assertion valid.
  const generatedServings = ui.defaultServings
  const entries = replacing
  ? additions.map((variantId) => ({ variantId, servings: generatedServings }))
  : [...atConfirm, ...additions.map((variantId) => ({ variantId, servings: generatedServings }))]
  plan.replacePlan(entries, plan.customItems)
  // The generation counter advances AFTER a successful apply so the NEXT
  // run rotates the seed (ADR-0027, kept in ADR-0033). This is the
  // generation the preview was BUILT with that gets applied — the counter
  // is never re-read here, so a pack shown at generation N lands as
  // shown and simply leaves the counter at N+1 for the next dialog.
  ui.advanceAutoPlanGeneration()
  // Undo restores the EXACT pre-apply state (ids + servings + the
  // cleared-ingredient map) from copies taken at confirm time — not from
  // the mutable dialog refs a later dialog open would overwrite
  // (qodo thread 3). Same semantics in BOTH modes.
  const undo = () => {
  plan.replacePlan(atConfirm, plan.customItems)
  plan.setClearedIngredients(clearedAtConfirm)
  }
  const warning = result.warnings?.[0]
  ui.showToast(
  warning
  ? `Plan generated — ${warning}`
  : replacing
  ? `Plan generated: ${result.variantIds.length} meals`
  : `${result.variantIds.length} meals added to your plan`,
  {
  actions: atConfirm.length > 0 || !replacing ? [{ label: 'Undo', run: undo, testId: 'auto-plan-undo' }] : undefined,
  duration: 6000,
  kind: 'autoplan-toast',
  },
  )
  closeAutoPlan()
}

/* ---------- The two dropdowns (ADR-0046 §2.2) ---------- */

/**
 * Meal type: options straight from `mealTypeFilter` — the taxonomy lives
 * ONCE (the old local RULESETS list is the copy that had drifted, leaving
 * Lunch and Snack unreachable from Auto-Plan). Option ids are the
 * catalog's own ruleset values: `simple` stays `simple` under the hood
 * and is SURFACED as Lunch by the artifact's label (ADR-0043 addendum).
 */
const mealOptions: FilterDropdownOption[] = [
  { value: 'any', label: 'Any' },
  ...OFFERED_MEAL_TYPES.map((option) => ({
    value: option.ruleset,
    label: option.label,
    ariaLabel: `${option.label}, ${option.count} recipes`,
    count: option.count,
    iconRole: mealRole(option.ruleset),
  })),
]

const mealSelectedIndex = computed(() => {
  const at = mealOptions.findIndex((o) => o.value === ui.autoPlanRuleset)
  return Math.max(0, at)
})

function setRuleset(value: string) {
  ui.autoPlanRuleset = value as AutoPlanRuleset
}

/**
 * Protein: the same values the old select held ('' = Any), with icons
 * through the protein ROLES so the dialog speaks the same colour language
 * as the Recipes protein chips (ADR-0036). "Any protein" is not a food,
 * so it borrows the neutral Sparkles glyph — the same rule the Recipes
 * "Any" rows follow.
 */
const proteinOptions: FilterDropdownOption[] = [
  { value: '', label: 'Any protein', icon: Sparkles },
  { value: 'meat', label: 'Meat', iconRole: proteinRole('meat') },
  { value: 'fish', label: 'Fish', iconRole: proteinRole('fish') },
  { value: 'vegetarian', label: 'Vegetarian', iconRole: proteinRole('vegetarian') },
]

const proteinSelectedIndex = computed(() => {
  const at = proteinOptions.findIndex((o) => o.value === autoPlanCategory.value)
  return Math.max(0, at)
})

function setCategory(value: string) {
  autoPlanCategory.value = value as '' | 'meat' | 'fish' | 'vegetarian'
}
</script>

<template>
  <!-- Auto-Plan dialog (ADR-0024): popover with count + category, then an
  explicit confirm step before REPLACING the (possibly hand-curated)
  plan. Undo restores the exact previous entries. -->
  <Teleport to="body">
  <div
  v-if="autoPlanOpen"
  class="fixed inset-0 z-40 flex items-end justify-center modal-scrim"
  @click.self="closeAutoPlan"
  >
  <!-- The panel is BOTTOM-anchored (`items-end` on the scrim), so when
  the preview grid grows past the window the panel overflows UPWARD and
  the header + close button clip off the TOP. The `max-h-[85vh]
  overflow-y-auto` pair is NutritionModal's sheet pattern reused: the
  panel clamps and scrolls its own content, keeping BOTH ends reachable
  on a short window. -->
  <div
  class="max-h-[85vh] w-full max-w-app space-y-4 overflow-y-auto rounded-t-2xl bg-surface-raised p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
  role="dialog"
  aria-label="Generate an auto-plan"
  data-test="auto-plan-dialog"
  >
  <div class="flex items-center justify-between">
  <h3 class="text-headline-sm">Auto-Plan</h3>
  <button
  class="flex size-11 items-center justify-center rounded-full hover:bg-surface-sunken"
  aria-label="Close auto-plan"
  @click="closeAutoPlan"
  >
  <X :size="18" aria-hidden="true" />
  </button>
  </div>
  <p class="text-xs">
  Picks meals that share whole packages so you throw less away.
  Add mode completes your current plan and shares its groceries;
  replace swaps it — undo works right after either way.
  </p>

  <div class="flex items-center justify-between gap-3">
  <span class="text-sm font-medium" id="auto-plan-mode-label">Mode</span>
  <!-- Selection is a TINT, never a fill (ADR-0036/0069): this sheet's
  ONE filled tomato belongs to Generate (and Confirm), not to the mode
  radio. -->
  <div
  class="flex rounded-lg border border-border-strong"
  role="radiogroup"
  aria-labelledby="auto-plan-mode-label"
  data-test="auto-plan-mode"
  >
  <button
  v-for="m in [
  { value: 'add', label: 'Add meals' },
  { value: 'replace', label: 'Replace plan' },
  ]"
  :key="m.value"
  class="px-3 py-2 text-xs font-semibold first:rounded-l-lg last:rounded-r-lg"
  :class="ui.autoPlanMode === m.value ? 'bg-brand-tint text-brand-text' : 'text-text-muted'"
  role="radio"
  :aria-checked="ui.autoPlanMode === m.value"
  :data-test="`auto-plan-mode-${m.value}`"
  @click="ui.autoPlanMode = m.value as 'add' | 'replace'"
  >
  {{ m.label }}
  </button>
  </div>
  </div>

  <!-- ADR-0045's dropdown, consumed here too: same trigger + popup shell
  as the Recipes filters. `full-width=false` keeps the trigger compact in
  this sheet's `justify-between` row; the trigger's aria-label carries
  the row's meaning (a button is not a `<label for>` target). -->
  <div class="flex items-center justify-between gap-3">
  <span class="text-sm font-medium">Meal type</span>
  <FilterDropdown
  :options="mealOptions"
  :selected-index="mealSelectedIndex"
  label="Meal type"
  trigger-test="auto-plan-ruleset"
  menu-test="auto-plan-ruleset-menu"
  :option-test="(o) => `auto-plan-option-${o.value}`"
  menu-width="w-56"
  :full-width="false"
  @select="setRuleset"
  />
  </div>

  <div class="flex items-center justify-between gap-3">
  <label class="text-sm font-medium" for="auto-plan-count">Meals</label>
  <div class="flex items-center rounded-lg border border-border-strong">
  <button
  class="flex size-11 items-center justify-center disabled:opacity-40"
  :disabled="autoPlanCount <= MIN_MEALS"
  aria-label="Fewer meals"
  data-test="auto-plan-count-minus"
  @click="autoPlanCount = Math.max(MIN_MEALS, autoPlanCount - 1)"
  >
  <Minus :size="18" aria-hidden="true" />
  </button>
  <input
  id="auto-plan-count"
  data-test="auto-plan-count"
  class="w-10 bg-transparent text-center font-mono-data text-sm font-semibold tabular-nums focus:outline-none"
  type="number"
  min="1"
  max="10"
  :value="autoPlanCount"
  aria-label="Number of meals"
  @change="autoPlanCount = Math.min(MAX_MEALS, Math.max(MIN_MEALS, Number(($event.target as HTMLInputElement).value) || MIN_MEALS))"
  />
  <button
  class="flex size-11 items-center justify-center disabled:opacity-40"
  :disabled="autoPlanCount >= MAX_MEALS"
  aria-label="More meals"
  data-test="auto-plan-count-plus"
  @click="autoPlanCount = Math.min(MAX_MEALS, autoPlanCount + 1)"
  >
  <Plus :size="18" aria-hidden="true" />
  </button>
  </div>
  </div>

  <div class="flex items-center justify-between gap-3">
  <span class="text-sm font-medium">Protein</span>
  <FilterDropdown
  :options="proteinOptions"
  :selected-index="proteinSelectedIndex"
  label="Protein"
  trigger-test="auto-plan-category"
  menu-test="auto-plan-category-menu"
  :option-test="(o) => (o.value === '' ? 'auto-plan-option-any-protein' : `auto-plan-option-${o.value}`)"
  :full-width="false"
  @select="setCategory"
  />
  </div>

  <button
  class="h-11 w-full rounded-xl bg-brand text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
  data-test="auto-plan-generate"
  :disabled="autoPlanBusy"
  @click="generateAutoPlan"
  >
  {{ autoPlanBusy ? 'Generating…' : pendingProposals ? 'Regenerate' : 'Generate' }}
  </button>

  <div v-if="pendingProposals" class="ring-1 ring-border rounded-xl p-3 space-y-2" data-test="auto-plan-preview">
  <p class="text-xs">
  <template v-if="ui.autoPlanMode === 'add'">
  Adds {{ selectedPack?.variantIds.length ?? 0 }} new
  {{ (selectedPack?.variantIds.length ?? 0) === 1 ? 'meal' : 'meals' }} to your plan —
  </template>
  <template v-else>
  Found a {{ selectedPack?.variantIds.length ?? 0 }}-meal pack —
  </template>
  the full plan buys {{ selectedPack?.packagesBought ?? 0 }}
  {{ (selectedPack?.packagesBought ?? 0) === 1 ? 'package' : 'packages' }}
  ({{ pendingProposals.eligibleCount }} eligible recipes).
  <template v-if="ui.autoPlanMode === 'replace'">
  Replaces your current plan
  <template v-if="plan.plan.length > 0">({{ plan.plan.length }} meals)</template>.
  </template>
  </p>
  <p v-if="pendingProposals.proposals.length === 0" class="text-xs text-warning">
  No eligible recipes for this plan — widen the filters or lower the meal count.
  </p>
  <p v-else-if="!previewComplete" class="text-xs text-warning">
  Showing {{ proposalMeals[selectedProposal]?.length ?? 0 }} of {{ selectedPack?.variantIds.length ?? 0 }} meals — the rest are still
  loading, so this plan cannot be confirmed yet.
  </p>
  <!-- ADR-0031: household stars and favourites nudge the ranking
  (see useAutoPlan) — say so, or the ranking looks arbitrary. -->
  <p class="text-xs text-text-muted" data-test="auto-plan-household-note">
  Ranked with your household’s ratings
  <template v-if="favouritesCount > 0"> and {{ favouritesCount }} favourite{{ favouritesCount === 1 ? '' : 's' }}</template>.
  </p>
  <!-- ADR-0080 Decision 5: one card per proposal, the CHEAPEST
  pre-selected (waste-first made visible). Selecting a card switches
  the preview; Confirm applies ONLY the selected proposal. The cards
  are a radio group; the selection is TINT + border emphasis (ADR-0036)
  — the Confirm button stays this sheet's one filled intent. Card
  content is phrasing-only (spans) because a <button> cannot contain
  a <ul>; the tile GRAMMAR (image, clamped name, bubble, minutes) is
  unchanged. -->
  <div role="radiogroup" aria-label="Plan proposals" data-test="auto-plan-proposals" class="space-y-2" @keydown="onProposalsKeydown">
  <button
  v-for="(proposal, pi) in pendingProposals.proposals"
  :key="proposal.seedId"
  type="button"
  role="radio"
  :tabindex="selectedProposal === pi ? 0 : -1"
  class="block w-full rounded-xl p-2 text-left ring-1 transition-colors"
  :class="selectedProposal === pi ? 'bg-brand-tint ring-border-strong' : 'bg-surface ring-border hover:bg-surface-sunken'"
  :aria-checked="selectedProposal === pi"
  :aria-label="`Proposal ${pi + 1}: ${proposal.variantIds.length} ${proposal.variantIds.length === 1 ? 'meal' : 'meals'}, buys ${proposal.packagesBought} ${proposal.packagesBought === 1 ? 'package' : 'packages'}`"
  :data-test="selectedProposal === pi ? 'auto-plan-proposal-selected' : 'auto-plan-proposal'"
  @click="selectedProposal = pi"
  >
  <span class="flex items-center justify-between gap-2">
  <span class="text-xs font-semibold">
  Option {{ pi + 1 }}<template v-if="proposal.kind === 'continuity'"> · extends your plan</template>
  </span>
  <span class="shrink-0 font-mono-data text-[10px] tabular-nums" data-test="auto-plan-proposal-packages">buys {{ proposal.packagesBought }} {{ proposal.packagesBought === 1 ? 'package' : 'packages' }}</span>
  </span>
  <span class="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
  <span
  v-for="meal in proposalMeals[pi] ?? []"
  :key="meal.id"
  class="group relative rounded-lg bg-surface ring-1 ring-border"
  :data-test="`auto-plan-meal-${meal.id}`"
  >
  <img
  :src="imageSrc(meal.image)"
  :alt="meal.name"
  loading="lazy"
  @error="onImgError"
  class="aspect-[4/3] w-full rounded-t-lg object-cover"
  />
  <!-- ADR-0055: the OS title on the line-clamped name becomes the one
  bubble (hover only). above-center: below would clip against the
  dialog's vertical scroll. The GROUP HOST is the tile (not the name
  span): group-hover is a descendant selector, so the bubble must hang
  under the hovered element. The tile's overflow clipping lives on the
  image (rounded top corners), or the absolutely-positioned bubble
  would be clipped by its own tile. -->
  <span class="block line-clamp-2 px-1.5 py-1 text-[11px] leading-tight font-medium">
  {{ meal.name }}
  </span>
  <TooltipBubble :text="meal.name" />
  <span class="block px-1.5 pb-1 font-mono-data text-[10px] tabular-nums">{{ meal.minutes }} min</span>
  </span>
  </span>
  </button>
  </div>
  <div class="flex gap-2">
  <button
  class="group relative h-11 flex-1 rounded-xl bg-brand text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong"
  data-test="auto-plan-confirm"
  :disabled="!previewComplete"
  @click="confirmAutoPlan"
  >
  {{ ui.autoPlanMode === 'add' ? 'Add these meals' : 'Use this plan' }}
  <!-- ADR-0055: conditional "Waiting…" bubble; empty once the preview
  is complete ⇒ nothing rendered (the conditional title's parity).
  The bubble is a CHILD of the button — the button IS the group host —
  and `aria-hidden` keeps it out of the button's accessible name; the
  button's textContent is not read by any spec, and the accessible
  name is what role-based locators match. -->
  <TooltipBubble
  :text="previewComplete ? '' : autoPlanBusy ? 'Waiting for the new plan…' : 'Waiting for the preview to load'"
  />
  </button>
  <button
  class="h-11 flex-1 rounded-xl border border-border-strong bg-surface-raised text-sm font-medium text-text active:bg-surface-sunken"
  data-test="auto-plan-cancel"
  @click="pendingProposals = null"
  >
  Keep editing
  </button>
  </div>
  </div>
  </div>
  </div>
  </Teleport>
</template>