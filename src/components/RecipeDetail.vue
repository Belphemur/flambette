<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { catalog, getRecipe } from '../lib/catalog'
import TooltipBubble from './TooltipBubble.vue'
import { eventsDocView, restrictedDocView } from '../lib/restrictions'
import { useRestrictions } from '../composables/useRestrictions'
import { imageSrc, onImgError } from '../lib/images'
import { measuredQuantity } from '../lib/measuredAmounts'
import {
  localizeQuantity,
  localizeSteps,
  UNIT_SYSTEMS,
  UNIT_SYSTEM_LABEL,
  type UnitSystem,
} from '../lib/units'
import { MAX_SERVINGS } from '../lib/servings'
import { scaleSteps, type ScaledStep } from '../lib/recipe'
import {
  getTimerHints,
  hintForStep,
  suggestionFromHint,
  type TimerHint,
  type TimerSuggestion,
} from '../lib/timerSuggest'
import { formatCountdown, remainingSeconds } from '../lib/stepTimer'
import type { RecipeDoc, VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'
import { useFavouritesStore } from '../stores/favourites'
import RatingStars from './RatingStars.vue'
import NutritionModal from './NutritionModal.vue'
import { formatAbsolute, formatRelative, useCookHistory } from '../lib/history'
import { ICON_ROLES, ingredientRole, mealRole } from '../lib/palette'
import { recipeSeoHead } from '../lib/seo'
import HueIcon from './HueIcon.vue'
import { onMounted, onUnmounted } from 'vue'
import { useHead } from '@unhead/vue'
import {
  ArrowLeft,
  BookOpen,
  ChefHat,
  ChevronDown,
  Clock,
  Heart,
  Minus,
  NotebookPen,
  Plus,
  Timer,
  Utensils,
  X,
} from 'lucide-vue-next'
import { isUserRecipeId } from '../lib/userRecipes'

const plan = usePlanStore()
const favourites = useFavouritesStore()
const router = useRouter()

/** Recipe variant id, passed as a route prop from /recipe/:id. */
const props = defineProps<{ id: number }>()

const loadedDoc = ref<RecipeDoc | null>(null)
// The restricted doc view (the restriction ADR): when a dietary restriction
// is active and upstream reworked this recipe, line_items/instructions come
// from upstream's own restricted rendering, wholesale. Keys are never read
// off this view — only display.
const badgeBubble = ref<InstanceType<typeof TooltipBubble> | null>(null)
const restrictionPrefs = useRestrictions()
const doc = computed<RecipeDoc | null>(() => {
  const base = loadedDoc.value
  if (!base) return null
  // The per-recipe events map wins when upstream has an exact rework for
  // this (restriction, recipe) — the dictionary's global swap/drop union is
  // only the fallback (it wrongly hides e.g. garlic in GF recipes whose own
  // rework keeps it).
  return (
    eventsDocView(base, restrictionPrefs.index.value, restrictionPrefs.activeIds.value) ??
    restrictedDocView(base, restrictionPrefs.index.value, restrictionPrefs.activeIds.value)
  )
})
const loading = ref(false)
const loadError = ref<string | null>(null)
const ui = useUiStore()

/** The full per-serving facts live in a modal (ADR-0039), not inline. */
const nutritionOpen = ref(false)

/**
 * Servings shown for THIS recipe: the plan entry's count when the recipe
 * IS planned, else the remembered default (ADR-0037), else the authored
 * `serving_count`.
 *
 * The catalog's 6 is a recipe fact — "this is how the author wrote it" —
 * and using it as the starting point on every open meant a household of
 * four re-dialled the same six-to-four correction on every recipe, every
 * time. The remembered default is that correction, made once.
 *
 * A PLANNED recipe leads with its plan entry, not the default. The sheet's
 * stepper and **Start cooking** must agree: `CookingView` freezes the
 * session's servings from the plan entry, so a sheet seeded from the
 * default would display one number and cook another. The default applies
 * to recipes with no plan entry — the ones the user is choosing now.
 */
const servings = ref(1)

/**
 * Change the servings for this recipe AND remember it as the new default
 * (ADR-0037), so the next recipe, pack and re-plan start here.
 *
 * One function for both writes, deliberately: a stepper that adjusted the
 * sheet but not the memory would look like it worked and quietly revert to
 * 6 on the next recipe, which is exactly the complaint this replaces.
 *
 * BOTH values are clamped to `MAX_SERVINGS`, and the LOCAL ref is set from
 * the same normalization the store applied. Letting the sheet show 100
 * while the memory holds 99 would be worse than either value alone: the
 * displayed quantities and the remembered default would silently disagree,
 * and Start cooking would then cook a different number from the one on
 * screen. One bound, applied once, to both.
 */
function setServings(next: number) {
  const count = Math.min(MAX_SERVINGS, Math.max(1, next))
  servings.value = count
  ui.setDefaultServings(count)
}

/** The `+` is disabled at the cap, so the user never hits a dead press. */
const canMoreServings = computed(() => servings.value < MAX_SERVINGS)

const meta = computed<VariantMeta | null>(
  () => catalog.value?.byId.get(props.id) ?? null,
)

/**
 * True when THIS recipe is household-authored (ADR-0054): the artifact's
 * id set is the only answer, and the marker below is its only face on the
 * detail sheet — permanent authorship, unlike the card's 30-day NEW badge.
 */
const isHouseholdRecipe = computed(() =>
  isUserRecipeId(props.id, catalog.value?.userRecipeIds ?? new Set()),
)

/**
 * This recipe's SEO head (ADR-0048) — the SAME payload the build-time
 * prerenderer baked into `dist/recipe/<id>/index.html`, so a crawler and
 * this browser describe the page identically.
 *
 * It is `computed` on purpose: navigating between two recipes (or a
 * `?room=` link) re-derives the head from the new `meta` alone, never
 * carrying the previous recipe's title or JSON-LD. While the async doc
 * fetch is in flight the payload degrades to the meta-derived fields and
 * upgrades itself the moment `doc` lands — see `recipeSeoHead(doc | null)`.
 * An unknown id renders NO head at all: there is nothing truthful to say.
 */
useHead(
  computed(() => {
    const m = meta.value
    if (!m) return null
    // Only the CURRENT recipe's doc may enter the head: the id check makes
    // the invariant local, so a late fetch resolving after a route change
    // can never pair this recipe's name/URL with another one's ingredients.
    return recipeSeoHead(doc.value?.id === m.id ? doc.value : null, m)
  }),
)

/** Categorical ingredient-TYPE hue beside the category name (ADR-0035). */
const typeRole = computed(() =>
  ingredientRole(catalog.value?.dataById.get(props.id)?.category_name),
)

/**
 * Meal OCCASION (ADR-0043), shown beside the type for the same reason the
 * tile shows it: "what is it" and "when is it eaten" are two different
 * questions, so they carry two different hue families. Null rulesets
 * (today only `cpg`) simply print nothing.
 */
const mealTypeRole = computed(() => mealRole(meta.value?.ruleset))

/** Scale factor for ingredients/instructions vs. the recipe's base servings. */
const factor = computed(() => (doc.value ? servings.value / doc.value.serving_count : 1))

/**
 * Display unit system (ADR-0047). Device-local, and applied HERE — at the
 * render edge — so the doc, the plan and every persisted number stay
 * canonical metric. Both this sheet and the cooking view run the same
 * `localizeSteps` helper, so the two surfaces cannot drift.
 */
const unitSystem = computed<UnitSystem>(() => ui.unitSystem)

/* The three labels come from `UNIT_SYSTEM_LABEL` in lib/units — the same
 * registry the Settings card reads, so the two surfaces cannot drift apart
 * again (they briefly did: this toggle once read `°C/°F`, `°C / g`,
 * `°F / oz`, which are not three options a reader can choose between). */

function setUnitSystem(system: UnitSystem) {
  ui.setUnitSystem(system)
}

const scaledIngredients = computed(() => {
  const current = doc.value
  if (!current) return []
  return current.line_items.map((item) => ({
  ...item,
  // Scale first, then convert: the authored quantity is metric, so this is
  // the only place the number in front of the user ever changes system.
  quantity: localizeQuantity(measuredQuantity(item, factor.value, current.serving_count) ?? item.quantity, unitSystem.value),
  }))
})

const scaledSteps = computed<ScaledStep[]>(() =>
  doc.value ? localizeSteps(scaleSteps(doc.value, factor.value), unitSystem.value) : [],
)

const macroBars = computed(() => {
  const m = meta.value?.macros
  if (!m) return []
  return [
  // Macro bars stay on the BRAND ramp only: a green "protein" bar would
  // collide with the vegetarian food hue, which means "this is a
  // vegetarian dish", and energy/sodium hues are reserved for the facts
  // that already wear them.
  { label: 'Protein', value: m.protein, color: 'bg-brand' },
  { label: 'Carbs', value: m.carbs, color: 'bg-brand-soft' },
  { label: 'Fat', value: m.fats, color: 'bg-brand/40' },
  ]
})

const inPlan = computed(() => (meta.value ? plan.planContains(meta.value.id) : false))

/* ---------- Ephemeral prep checklist (ADR-0073) ---------- */

/**
 * Checked ingredient ids for THIS sheet only. Ephemeral by construction:
 * a plain component ref, never persisted and never carried in the room
 * payload (prep state is personal and short-lived — the SHOP list is the
 * household's checklist). Switching recipe clears it, so one sheet's
 * ticks can never read as another dish's.
 */
const readyIngredients = ref(new Set<number>())
const allReady = computed(
  () =>
    scaledIngredients.value.length > 0 &&
    scaledIngredients.value.every((item) => readyIngredients.value.has(item.id)),
)

function toggleReady(id: number): void {
  const next = new Set(readyIngredients.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  readyIngredients.value = next
}

/** "Mark all ready" toggles every row, not just the open ones. */
function toggleAllReady(): void {
  if (allReady.value) {
    readyIngredients.value = new Set()
    return
  }
  readyIngredients.value = new Set(scaledIngredients.value.map((item) => item.id))
}

/* ---------- Inline step-timer affordances (ADR-0073 / ADR-0020) ---------- */

/**
 * The recipe's build-time timer hints, loaded on demand from the sidecar
 * and cached per session — the same artifact and the same lazy pattern
 * the cooking view uses, so the two surfaces cannot disagree about what
 * a step's duration is. A recipe with no sidecar resolves to no hints,
 * which is a fact about the catalog (ADR-0041).
 */
const hints = ref<TimerHint[] | null>(null)

watch(
  () => meta.value?.id,
  (id) => {
    hints.value = null
    readyIngredients.value = new Set()
    if (id === undefined) return
    void getTimerHints(id).then((loaded) => {
      // A stale fetch (the reader moved to another recipe) never wins.
      if (meta.value?.id === id) hints.value = loaded
    })
  },
  { immediate: true },
)

/** The hint for one step index, if the authored text carries a duration. */
function hintAt(index: number): TimerHint | null {
  if (!hints.value) return null
  return hintForStep(hints.value, [index])
}

/**
 * step index -> the timer id this sheet armed for it. Ephemeral like the
 * checklist: the ARMED timer itself lives in the ui store (the ADR-0020
 * contract, the same store cooking mode uses), so a countdown keeps
 * running if the reader leaves the sheet; only this sheet's mapping of
 * which step to which timer is view state.
 */
const armedByStep = ref(new Map<number, number>())

/** A 1s tick, alive only while a timer this sheet armed is counting. */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
function syncTick(): void {
  const live = [...armedByStep.value.values()].some((id) => {
    const t = ui.stepTimers[meta.value?.id ?? -1]?.[id]
    return t !== undefined && remainingSeconds(t, now.value) > 0 && t.running
  })
  if (live && tick === null) {
    tick = setInterval(() => {
      now.value = Date.now()
    }, 1000)
  } else if (!live && tick !== null) {
    clearInterval(tick)
    tick = null
  }
}
watch([armedByStep, () => ui.stepTimers], syncTick, { deep: true, immediate: true })
onUnmounted(() => {
  if (tick !== null) clearInterval(tick)
})

/** Seconds left on the timer armed for one step, or null when none. */
function stepCountdown(index: number): string | null {
  const id = armedByStep.value.get(index)
  if (id === undefined || !meta.value) return null
  const timer = ui.stepTimers[meta.value.id]?.[id]
  if (!timer) return null
  const left = remainingSeconds(timer, now.value)
  if (left <= 0) {
    armedByStep.value.delete(index)
    return null
  }
  return formatCountdown(left)
}

/**
 * Arm the step's authored duration. A user press arms it — the same
 * confirm-the-parser's-finding rule the cooking view keeps (ADR-0041 §4),
 * so nothing a sidecar reported ever starts counting on its own.
 */
function startStepTimer(index: number): void {
  const hint = hintAt(index)
  if (!hint || !meta.value) return
  // ONE live timer per step from this sheet: a second press must never
  // stack a duplicate countdown (the affordance disables while armed —
  // this guard is the store-level backstop, e.g. via a rapid double-tap
  // that lands before the re-render).
  if (armedByStep.value.has(index)) return
  const suggestion: TimerSuggestion = suggestionFromHint(hint)
  const id = ui.addTimer(meta.value.id, suggestion.label, suggestion.seconds)
  if (id === null) return
  armedByStep.value = new Map(armedByStep.value).set(index, id)
}

/**
 * Dismiss the timer armed for one step: drop it from the SHARED store
 * (so the countdown also stops ticking in cooking mode's strip — the
 * ADR-0020 contract makes the store the single source of armed timers)
 * AND from this sheet's mapping. Expiry cleans its own mapping in
 * `stepCountdown`; only a USER dismissal has to cancel a timer that is
 * still counting.
 */
function dismissStepTimer(index: number): void {
  const id = armedByStep.value.get(index)
  if (id === undefined || !meta.value) return
  ui.clearTimer(meta.value.id, id)
  const next = new Map(armedByStep.value)
  next.delete(index)
  armedByStep.value = next
}

/** Personal cooked history (this device only, ADR-0011). */
const cooked = useCookHistory()
const cookCount = computed(() => (meta.value ? cooked.count(meta.value.id) : 0))
/**
 * Every cook EVENT of this recipe, newest first (ADR-0034). The count line
 * above answers "how often"; the spoiler below answers "when exactly",
 * which the per-variant aggregate has already thrown away. Collapsed by
 * default: it is a detail, not a headline.
 */
const cookEvents = computed(() => (meta.value ? cooked.events(meta.value.id) : []))
const cookSpoilerOpen = ref(false)
const cookLine = computed(() => {
  if (cookCount.value === 0) return null
  const times = cookCount.value === 1 ? '1 time' : `${cookCount.value} times`
  const last = meta.value ? cooked.last(meta.value.id) : null
  return last ? `Cooked ${times} · last ${formatRelative(last)}` : `Cooked ${times}`
})
const cookLastTitle = computed(() => {
  const last = meta.value ? cooked.last(meta.value.id) : null
  return last ? `Last cooked ${formatAbsolute(last)}` : undefined
})

async function loadDoc() {
  const m = meta.value
  if (!m) return
  loading.value = true
  loadError.value = null
  loadedDoc.value = null
  // Every load starts with the facts modal CLOSED. `nutritionOpen` used to
  // survive a recipe-id change, and since the modal is `v-if`-gated on
  // `doc`, clearing the doc only unmounted it briefly — the new document
  // remounted it for the next recipe (ADR-0039).
  nutritionOpen.value = false
  // A PLANNED recipe shows its plan entry (that is what CookingView will
  // cook); an unplanned one starts at the remembered default
  // (ADR-0037). Only the latter was the authored-6 complaint. Re-read per
  // load so a recipe opened after the user changed the default elsewhere
  // starts at the current one.
  const entry = plan.plan.find((e) => e.variantId === m.id)
  // ONE seeding rule for every recipe, household-authored or not: the
  // owner's saved default defines the servings (a settings decision, not a
  // per-recipe one). The fractional-noise problem that scaling creates is
  // handled where it belongs - the DISPLAY rounding (humanizeScaledQuantity).
  servings.value = entry?.servings ?? ui.defaultServings
  try {
    const loaded = await getRecipe(m)
    // Race guard: navigating to another recipe while this fetch is in
    // flight must not let the STALE document land — it would pair the new
    // recipe's name with the old one's ingredients and instructions, in the
    // view AND in the SEO head (ADR-0048). The newer loadDoc already cleared
    // `doc`, so dropping this result simply leaves the newer one in charge.
    if (meta.value?.id === m.id) loadedDoc.value = loaded
  } catch (e) {
    // Same guard for the error: a failure belonging to a recipe we have
    // already left must not raise an error banner over the new one.
    if (meta.value?.id !== m.id) return
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (meta.value?.id === m.id) loading.value = false
  }
}

watch(
  meta,
  (m) => {
  if (m) void loadDoc()
  },
  { immediate: true },
)

/** Back to wherever the user came from; deep links fall back to `/`. */
function close() {
  if (window.history.state?.back) router.back()
  else router.replace('/')
}

function onKey(e: KeyboardEvent) {
  // The facts modal owns Escape while it is open (ADR-0039): this view
  // must not navigate away underneath it.
  if (nutritionOpen.value) return
  if (e.key === 'Escape') close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // Warm the restriction artifacts (control plane + overlay) so a swapped
  // ingredient list is ready; no-op when no restriction is active.
  void restrictionPrefs.ensureLoaded()
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

function addToPlan() {
  if (!meta.value) return
  plan.addToPlan(meta.value, servings.value)
}

/** Cooking is plan-driven: head to the gated /cooking/:id route. */
function startCooking() {
  if (!meta.value) return
  void router.push({ name: 'cooking', params: { id: String(meta.value.id) } })
}
</script>

<template>
  <div
  v-if="meta"
  class="min-h-full"
  role="dialog"
  :aria-label="meta.name"
  tabindex="-1"
  @keydown="onKey"
  >
  <div class="mx-auto max-w-app px-4 pt-4 pb-24">
  <!-- Desktop composes the photograph BESIDE the introduction and the
  action panel (DESIGN.md Layout); the photograph stops being a
  shallow screen-wide ribbon. On phones the same cells simply
  stack in the order photo -> intro -> actions -> sections. -->
  <div
  class="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start"
  data-test="detail-hero"
  >
  <figure class="relative -mx-4 lg:mx-0">
  <img
  :src="imageSrc(meta.presentation_image_url)"
  :alt="meta.name"
  loading="lazy"
  @error="onImgError"
  class="aspect-[4/3] w-full object-cover lg:rounded-xl"
  />
  <!-- Solid espresso discs over the photo (DESIGN.md photo-control):
  roasted espresso, white glyph; the contrast never depends on the
  photograph's brightness — and NO shadow (ADR-0068: the disc's own
  darkness is the separation). -->
  <button
  class="absolute top-3 left-3 flex size-11 items-center justify-center rounded-full bg-espresso text-on-brand"
  aria-label="Back"
  data-test="detail-back"
  @click="close"
  >
  <ArrowLeft :size="20" aria-hidden="true" />
  </button>
  <button
  class="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full bg-espresso text-on-brand"
  :aria-label="favourites.isFavourite(meta.id) ? 'Remove from favourites' : 'Add to favourites'"
  :aria-pressed="favourites.isFavourite(meta.id)"
  @click="favourites.toggleFavourite(meta.id)"
  >
  <Heart
  :size="22"
  aria-hidden="true"
  :fill="favourites.isFavourite(meta.id) ? 'currentColor' : 'none'"
  :class="favourites.isFavourite(meta.id) ? 'text-favourite-soft' : ''"
  />
  </button>
  </figure>

  <div class="space-y-4">
  <header class="space-y-3">
  <div class="flex flex-wrap items-center gap-2 text-label-md text-text-muted">
  <span
  v-if="meta.is_pro"
  class="rounded bg-espresso px-1.5 py-0.5 font-bold text-warning-soft"
  >PRO</span
  >
  <!-- Type icon only: no redundant category word beside an
  already informative icon (DESIGN.md Components). The
  icon is role="img" with the category as its name, and
  the text survives only when NEITHER icon applies, so
  an unrecognised type is never silently dropped — and a
  household recipe (no ingredient-TYPE category, ADR-0054)
  keeps the SAME icon-only design as an imported one
  instead of growing a text label the catalog never shows. -->
  <HueIcon
  v-if="typeRole"
  :role="typeRole"
  :size="18"
  :label="ICON_ROLES[typeRole].label"
  tap-reveal
  test-id="detail-type-icon"
  />
  <span v-else-if="!mealTypeRole" class="capitalize">{{
  catalog?.dataById.get(meta.id)?.category_name ?? meta.ruleset
  }}</span>
  <!-- The occasion wears its OWN hue (ADR-0043): never a protein hue,
  which means "contains X" two rows down the same screen. -->
  <HueIcon
  v-if="mealTypeRole"
  :role="mealTypeRole"
  :size="18"
  :label="ICON_ROLES[mealTypeRole].label"
  tap-reveal
  />
  <!-- ADR-0054: the PERMANENT authorship marker, styled like the two
  icons above — an icon in the SAME row, carrying its meaning in the
  tooltip + accessible name (the grocery provenance pill's pattern:
  cursor-help + title). The card's NEW badge is the 30-day recency
  face; this one never expires. Household status colour (DESIGN.md);
  a label, never an IconRole — a recipe is not "the plum one". -->
  <!-- ADR-0054 → ADR-0055: the PERMANENT authorship marker. The OS
  `title` becomes the one bubble, engaged with tap-reveal — this is the
  detail view, the owner's tap-reveal scope; the bubble reveals on
  hover/focus-within AND for 3 s after a tap. The wrapper carries the
  click (the badge glyph itself stays a plain labelled icon; the
  aria-label keeps being the meaning-carrier, the bubble aria-hidden). -->
  <span
  v-if="isHouseholdRecipe"
  class="group relative inline-flex hovercap:cursor-help"
  data-test="user-recipe-badge"
  @click="badgeBubble?.tap()"
  >
  <NotebookPen
  :size="18"
  role="img"
  class="text-household"
  :aria-label="'Household recipe: authored by this household, not part of the imported catalog'"
  />
  <!-- ADR-0055 decision log (owner refinement, 2026-10-06): the
  detail-view badge's bubble text is just "New" — the full meaning stays
  in the aria-label, which is the single carrier (ADR-0049's rule
  inherited); the bubble is its short visual dual. -->
  <TooltipBubble
  ref="badgeBubble"
  text="New"
  placement="above-center"
  tap-reveal
  />
  </span>
  </div>
  <h2 class="text-headline-md sm:text-headline-lg" data-test="detail-title">
  {{ meta.name }}
  </h2>
  <div class="flex flex-wrap items-center gap-3" data-test="recipe-detail-rating">
  <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="20" />
  <span class="text-label-md text-text-muted">rate it for your household</span>
  <span class="flex items-center gap-1 text-label-md text-text-muted" data-test="serves-label">
  <Utensils :size="16" aria-hidden="true" />serves {{ servings }}
  </span>
  </div>
  <!-- Metadata strip (ADR-0073): REAL catalog facts only — total time,
  calories per serving (never scaled), sodium. Macro splits, difficulty,
  test counts and SKUs do not exist in the catalog and are rejected
  fictions, so they are not here. The strip is data voice: mono,
  tabular, with the ADR-0036 semantic hues on the two nutrition facts. -->
  <dl
  class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-data text-label-md tabular-nums text-text-muted"
  data-test="detail-metadata-strip"
  >
  <div class="flex items-center gap-1.5">
  <Clock :size="16" aria-hidden="true" />
  <dt class="sr-only">Total time</dt>
  <dd>{{ meta.cooking_minutes }} min</dd>
  </div>
  <div class="flex items-center gap-1.5">
  <HueIcon role="energy" :size="16" />
  <dt class="sr-only">Calories per serving</dt>
  <dd data-test="detail-metadata-calories">{{ Math.round(meta.calories) }} kcal / serving</dd>
  </div>
  <div v-if="meta.sodium_mg" class="flex items-center gap-1.5">
  <HueIcon role="sodium" :size="16" />
  <dt class="sr-only">Sodium per serving</dt>
  <dd>{{ Math.round(meta.sodium_mg) }} mg</dd>
  </div>
  </dl>
  <p
  v-if="cookLine"
  class="group relative text-sm font-medium text-brand-text"
  data-test="cook-history"
  >
  <ChefHat :size="16" aria-hidden="true" class="mr-1 inline align-[-2px]" />{{ cookLine }}
  <!-- ADR-0055: the absolute date becomes the one bubble (hover only;
  the p is not focusable — native-title parity). DESCENDANT of the
  group host; toContainText assertions on cook-history tolerate it. -->
  <TooltipBubble v-if="cookLastTitle" :text="cookLastTitle" placement="below-right" />
  </p>
  <!-- Per-cook spoiler: one row per cook EVENT, relative AND absolute
  date, so "cooked twice" can be told apart into "last night" and
  "the Sunday before" (ADR-0034). -->
  <div v-if="cookEvents.length" data-test="cook-history-spoiler">
  <button
  class="flex items-center gap-1 text-label-md font-medium text-text-muted"
  :aria-expanded="cookSpoilerOpen"
  aria-controls="cook-history-events"
  data-test="cook-history-toggle"
  @click="cookSpoilerOpen = !cookSpoilerOpen"
  >
  <ChevronDown
  :size="16"
  aria-hidden="true"
  class="transition-transform"
  :class="cookSpoilerOpen ? '' : '-rotate-90'"
  />
  {{ cookSpoilerOpen ? 'Hide' : 'Show' }} cook history
  </button>
  <ul
  v-if="cookSpoilerOpen"
  id="cook-history-events"
  class="mt-1 space-y-0.5"
  data-test="cook-history-events"
  >
  <li
  v-for="(at, i) in cookEvents"
  :key="`${at}-${i}`"
  class="text-label-md text-text-muted"
  data-test="cook-history-event"
  >
  {{ formatRelative(at) }} · {{ formatAbsolute(at) }}
  </li>
  </ul>
  </div>
  </header>

  <!-- Action panel (DESIGN.md Selection and actions): ONE filled
  primary CTA, 48px tall, white label, with the dark-theme
  keyline. Add/Update in plan is a real outlined secondary
  action. Not sticky: a sticky bar here would sit under the
  app header and cover the content it is meant to serve. -->
  <div
  class="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  data-test="detail-actions"
  >
  <div class="flex items-center justify-between gap-3">
  <span class="text-sm font-medium">Servings</span>
  <div class="flex items-center rounded-lg ring-1 ring-border-strong">
  <button
  class="flex size-11 items-center justify-center text-lg"
  :disabled="servings <= 1"
  aria-label="Fewer servings"
  @click="setServings(servings - 1)"
  >
  <Minus :size="18" aria-hidden="true" />
  </button>
  <span class="w-8 text-center text-sm font-semibold font-mono-data tabular-nums">{{
  servings
  }}</span>
  <button
  class="flex size-11 items-center justify-center text-lg"
  :disabled="!canMoreServings"
  :aria-label="`More servings`"
  @click="setServings(servings + 1)"
  >
  <Plus :size="18" aria-hidden="true" />
  </button>
  </div>
  </div>
  <!-- Unit system (ADR-0047): a compact three-option segmented control in
  the ACTIONS panel, so a reader who shops in oz/lb does not have to leave
  the recipe to fix it. It writes the SAME ui member as the Settings card,
  so the two surfaces are one setting by construction. -->
  <div
  class="flex items-center justify-between gap-3"
  data-test="detail-unit-toggle"
  role="group"
  aria-label="Unit system"
  >
  <span class="text-sm font-medium">Units</span>
  <div class="flex shrink-0 items-center rounded-lg ring-1 ring-border-strong">
  <button
  v-for="system in UNIT_SYSTEMS"
  :key="system"
  class="px-3 py-2 text-xs font-semibold capitalize"
  :class="
  unitSystem === system
  ? 'rounded-lg bg-primary-tint text-primary-strong'
  : 'text-text-muted'
  "
  :aria-pressed="unitSystem === system"
  :aria-label="`${UNIT_SYSTEM_LABEL[system]} units`"
  :data-test="`detail-unit-${system}`"
  @click="setUnitSystem(system)"
  >
  {{ UNIT_SYSTEM_LABEL[system] }}
  </button>
  </div>
  </div>
  <button
  class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 text-base font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong dark:ring-1 dark:ring-brand-soft"
  data-test="start-cooking"
  @click="startCooking"
  >
  <ChefHat :size="18" aria-hidden="true" />Start cooking
  </button>
  <button
  class="flex h-11 w-full items-center justify-center rounded-lg bg-surface-raised px-4 text-sm font-semibold text-brand-text ring-1 ring-border-strong active:bg-surface-sunken"
  data-test="add-to-plan"
  @click="addToPlan"
  >
  {{ inPlan ? 'Update in plan' : 'Add to plan' }}
  </button>
  </div>
  </div>
  </div>

  <!-- Nutrition comes AFTER the actions, never ahead of them
  (DESIGN.md Recipe detail). Units and the supplied sodium are
  kept: only the compact browse cards drop sodium. -->
  <section class="mt-6" data-test="nutrition">
  <h3 class="mb-2 text-body-sm font-semibold">Nutrition</h3>
  <div class="rounded-xl bg-surface-sunken p-4">
  <p class="flex flex-wrap gap-4 font-mono-data text-body-sm tabular-nums">
  <span class="flex items-center gap-1.5">
  <HueIcon role="energy" :size="18" />
  <span>{{ Math.round(meta.calories) }} kcal / serving</span>
  </span>
  <span class="flex items-center gap-1.5">
  <Clock :size="18" aria-hidden="true" />
  <span>{{ meta.cooking_minutes }} min</span>
  </span>
  <span v-if="meta.sodium_mg" class="flex items-center gap-1.5" data-test="nutrition-sodium">
  <HueIcon role="sodium" :size="18" />
  <span>{{ Math.round(meta.sodium_mg) }} mg sodium</span>
  </span>
  </p>
  <div class="mt-3 space-y-1.5">
  <div v-for="bar in macroBars" :key="bar.label" class="flex items-center gap-2">
  <span class="w-16 text-label-md">{{ bar.label }}</span>
  <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
  <div
  class="h-full rounded-full"
  :class="bar.color"
  :style="{ width: `${Math.round(bar.value * 100)}%` }"
  />
  </div>
  <span class="w-10 shrink-0 text-right text-label-md font-medium font-mono-data tabular-nums">{{
  Math.round(bar.value * 100)
  }}%</span>
  </div>
  </div>
  <!-- The 66-row facts block would turn the detail into a wall, so the
  summary above stays and the rest opens on demand (ADR-0039). The
  trigger sits INSIDE the section: the section's position contract is
  unchanged. -->
  <button
  v-if="doc"
  class="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-surface-raised px-4 text-sm font-semibold text-brand-text ring-1 ring-border-strong active:bg-surface-sunken sm:w-auto sm:px-3"
  aria-label="Full nutrition facts"
  aria-haspopup="dialog"
  data-test="nutrition-open"
  @click="nutritionOpen = true"
  >
  <BookOpen :size="16" aria-hidden="true" />Full nutrition facts
  </button>
  </div>
  </section>

  <Teleport to="body">
  <NutritionModal
  v-if="nutritionOpen && doc"
  :nutrition="doc.nutrition"
  :calories="meta.calories"
  @close="nutritionOpen = false"
  />
  </Teleport>

  <template v-if="loading">
  <div class="mt-6 space-y-3">
  <div v-for="i in 3" :key="i" class="h-6 w-2/3 animate-pulse rounded bg-surface-sunken" />
  </div>
  </template>

  <div
  v-else-if="loadError"
  class="mt-6 rounded-xl bg-surface p-4 text-center text-sm"
  data-test="detail-error"
  >
  <p class="font-medium text-danger">Couldn't load recipe details</p>
  <p class="mt-1 text-xs text-text-muted">{{ loadError }}</p>
  <button
  class="mt-2 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand"
  @click="loadDoc"
  >
  Retry
  </button>
  </div>

  <template v-else-if="doc">
  <!-- Cookwares -->
  <section v-if="doc.cookwares.length" class="mt-6">
  <h3 class="mb-2 text-body-sm font-semibold">Cookware</h3>
  <ul class="flex flex-wrap gap-2">
  <li
  v-for="cw in doc.cookwares"
  :key="cw.id"
  class="rounded-full bg-surface-sunken px-3 py-1 text-label-md"
  >
  {{ cw.name }}
  </li>
  </ul>
  </section>

  <!-- Ingredients + Instructions (DESIGN.md Layout): the ingredient
  list is a reference beside the prose at roughly 1:1.5, instead
  of one 1100px ribbon. Below `lg` it is the phone layout. -->
  <div
  class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:items-start"
  data-test="detail-columns"
  >
  <!-- Ingredient checklist card (ADR-0073): name left, quantity right in
  the mono data voice, each row checkable with the ADR-0072 success
  state. The checks are EPHEMERAL view state — never persisted, never
  room-synced; the household's checklist is the grocery list. Sticky on
  desktop so a long step list never scrolls the mise en place away. -->
  <section class="lg:sticky lg:top-24">
  <div class="mb-2 flex items-center justify-between gap-2">
  <h3 class="text-body-sm font-semibold">
  Ingredients ({{ servings }} servings)
  </h3>
  <button
  class="flex h-11 items-center rounded-lg px-2 text-label-md font-semibold text-brand-text hover:bg-surface-sunken"
  :aria-pressed="allReady"
  data-test="mark-all-ready"
  @click="toggleAllReady"
  >
  {{ allReady ? 'All ready' : 'Mark all ready' }}
  </button>
  </div>
  <ul
  class="divide-y divide-border rounded-xl bg-surface-raised ring-1 ring-border"
  data-test="detail-ingredients"
  >
  <li
  v-for="item in scaledIngredients"
  :key="item.id"
  class="flex items-center gap-3 px-3 py-2.5"
  data-test="detail-ingredient-row"
  >
  <label class="flex min-w-0 flex-1 hovercap:cursor-pointer items-center gap-3">
  <input
  type="checkbox"
  class="check-box done"
  :checked="readyIngredients.has(item.id)"
  @change="toggleReady(item.id)"
  />
  <span
  class="min-w-0 flex-1 text-body-sm"
  :class="readyIngredients.has(item.id) ? 'text-text-muted line-through' : 'text-text'"
  >{{ item.ingredient_name }}</span>
  </label>
  <span
  class="shrink-0 rounded-md bg-surface-sunken px-2 py-1 font-mono-data text-label-sm tabular-nums"
  :class="readyIngredients.has(item.id) ? 'text-text-muted' : 'text-text'"
  data-test="detail-ingredient-qty"
  >{{ item.quantity || '—' }}</span>
  </li>
  </ul>
  </section>

  <section>
  <h3 class="mb-2 text-body-sm font-semibold">Instructions</h3>
  <ol class="space-y-3">
  <li
  v-for="(step, i) in scaledSteps"
  :key="i"
  class="rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  data-test="detail-step"
  >
  <div class="flex gap-3">
  <span
  class="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand font-mono-data text-xs font-bold text-on-brand"
  >
  {{ i + 1 }}
  </span>
  <p class="text-body-md">{{ step.primary }}</p>
  </div>
  <!-- Inline timer affordance (ADR-0073): ONLY where the recipe's own
  sidecar reports a duration for this step — never a guessed one
  (ADR-0022). The press ARMS the duration in the shared timer store,
  so cooking mode picks it up; nothing auto-starts (ADR-0041 §4). -->
  <div v-if="hintAt(i)" class="mt-2 ml-9 flex items-center gap-2">
  <button
  class="flex h-11 items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 text-label-md font-medium text-text hover:bg-surface disabled:opacity-50 disabled:hover:bg-surface-sunken"
  :aria-label="`Start a ${suggestionFromHint(hintAt(i)!).minutes} minute timer for step ${i + 1}`"
  :disabled="armedByStep.has(i)"
  data-test="detail-step-timer"
  @click="startStepTimer(i)"
  >
  <Timer :size="16" aria-hidden="true" />
  {{ suggestionFromHint(hintAt(i)!).label }} ·
  {{ suggestionFromHint(hintAt(i)!).minutes }} min
  </button>
  <span
  v-if="stepCountdown(i)"
  class="font-mono-data text-label-md tabular-nums text-brand-text"
  data-test="detail-step-countdown"
  >{{ stepCountdown(i) }}</span>
  <!-- Dismiss (owner ask): an armed countdown is cancellable from the
  sheet — clearTimer drops it from the SHARED store, so cooking mode's
  strip stops with it. Hidden while nothing is armed; expiry unhides
  both this and the disabled start button. -->
  <button
  v-if="armedByStep.has(i)"
  class="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
  :aria-label="`Dismiss the timer for step ${i + 1}`"
  data-test="detail-step-timer-dismiss"
  @click="dismissStepTimer(i)"
  >
  <X :size="14" aria-hidden="true" />
  </button>
  </div>
  <ul
  v-if="step.details.length"
  class="mt-2 ml-9 space-y-0.5 border-l-2 border-border pl-3 text-body-sm text-text-muted"
  >
  <li v-for="(d, j) in step.details" :key="j">{{ d }}</li>
  </ul>
  </li>
  </ol>
  </section>
  </div>
  </template>
  </div>
  </div>
</template>
