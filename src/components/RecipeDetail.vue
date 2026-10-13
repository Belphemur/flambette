<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { catalog, getRecipe } from '../lib/catalog'
import TooltipBubble from './TooltipBubble.vue'
import { eventsDocView, restrictedDocView } from '../lib/restrictions'
import { useRestrictions } from '../composables/useRestrictions'
import { imageSrc, onImgError } from '../lib/images'
import {
  measuredChipsForLines,
  measuredQuantity,
  type MeasuredChip,
} from '../lib/measuredAmounts'
import {
  localizeQuantity,
  localizeSteps,
  UNIT_SYSTEMS,
  UNIT_SYSTEM_LABEL,
  type UnitSystem,
} from '../lib/units'
import { MAX_SERVINGS, normalizePlanServings } from '../lib/servings'
import { scaleSteps, type ScaledStep } from '../lib/recipe'
import {
  suggestionFromHint,
  type TimerHint,
  type TimerSuggestion,
} from '../lib/timerSuggest'
import { useTimerHints } from '../composables/useTimerHints'
import {
  formatCountdown,
  isCounting,
  remainingSeconds,
  MAX_CONCURRENT_TIMERS,
} from '../lib/stepTimer'
import type { RecipeDoc, VariantMeta } from '../lib/types'
import { macroGrams } from '../lib/nutrition'
import { usePlanStore, type CookedEntry, type PlanEntry } from '../stores/plan'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'
import { displayRating, ratingNoScoreCorner, useRatingStore } from '../stores/rating'
import { planServingsFor } from '../composables/usePlanServings'
import RatingStars from './RatingStars.vue'
import PostCookPrompt from './PostCookPrompt.vue'
import NutritionModal from './NutritionModal.vue'
import { formatAbsolute, formatRelative, useCookHistory } from '../lib/history'
import { useIntersectionObserver } from '@vueuse/core'
import { ICON_ROLES, ingredientRole, mealRole } from '../lib/palette'
import { recipeSeoHead } from '../lib/seo'
import HueIcon from './HueIcon.vue'
import FavouriteButton from './FavouriteButton.vue'
import { useHead } from '@unhead/vue'
import {
  ArrowLeft,
  BookOpen,
  ChefHat,
  ChevronDown,
  Clock,
  CookingPot,
  Donut,
  Minus,
  NotebookPen,
  Plus,
  Timer,
  X,
} from '@lucide/vue'
import { isUserRecipeId } from '../lib/userRecipes'

const plan = usePlanStore()
// The rate card's rating NUMBER reads the same store the stars control
// (ADR-0031/0082): one precedence, so the digits and the glyphs cannot
// drift. The strip's Rating cell retired — the card owns it now.
const ratingStore = useRatingStore()
// "Synced to household" shows ONLY while a room is live (ADR-0082):
// ratings are room-synced, and a standalone install must not be told
// it syncs.
const room = useRoomStore()
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
 * the shared entry normalization (the plan store's own paths use it too).
 * Letting the sheet show 100 while the memory holds 99 would be worse than
 * either value alone: the displayed quantities and the remembered default
 * would silently disagree, and Start cooking would then cook a different
 * number from the one on screen. One bound, applied once, to both.
 */
function setServings(next: number) {
  const count = normalizePlanServings(next)
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

/**
 * The ONE segmented nutrition bar (ADR-0077 fix pass): the render's
 * "Nutritional Split (per serving)" — a single track whose protein/carbs/
 * fat segments sit SIDE BY SIDE, each width = the macro's fraction of
 * calories (`meta.macros` sum to 1). Legend grams come from the SHARED
 * lib helper (`macroGrams`, lib/nutrition — fraction × kcal ÷ the
 * Atwater factor, the derivation the facts modal runs in reverse), never
 * an inline converter. Sodium has NO honest segment width — the macro
 * fractions already sum to 1 — so it renders in the LEGEND only
 * (data-reality beats the mock; the deviation is recorded in ADR-0077).
 * Segments stay on the BRAND ramp: a green protein segment would collide
 * with the vegetarian food hue (which means "this is a vegetarian
 * dish"), and the energy/sodium hues stay reserved for the facts that
 * already wear them (ADR-0036).
 */
const macroSegments = computed(() => {
  const m = meta.value?.macros
  if (!m) return []
  const kcal = meta.value!.calories
  return [
  { label: 'Protein', value: m.protein, grams: macroGrams(m.protein, kcal, 'protein'), color: 'bg-nutrition-protein' },
  { label: 'Carbs', value: m.carbs, grams: macroGrams(m.carbs, kcal, 'carbs'), color: 'bg-nutrition-carbs' },
  { label: 'Fat', value: m.fats, grams: macroGrams(m.fats, kcal, 'fat'), color: 'bg-nutrition-fat' },
  ]
})

/**
 * The number beside the rate card's stars (ADR-0082; the render's
 * "4.5 / 5.0"): the household's own rating when one exists, the catalog
 * Bayesian mean otherwise — the SAME precedence RatingStars displays, so
 * the number and the stars can never disagree (ADR-0074's addendum; ONE
 * computed, shared by nothing else — the strip cell that used to print
 * it retired with ADR-0082). Null when neither exists: an unrated
 * recipe with no catalog score prints nothing.
 */
const ratingDisplay = computed(() => {
  if (!meta.value) return null
  const value = displayRating(ratingStore.ratingFor(meta.value.id), meta.value.rating)
  return value > 0 ? value.toFixed(1) : null
})

/**
 * The Clear control (ADR-0082) shows only when the household has rated
 * this recipe — an unrated recipe has nothing to clear.
 */
const ratingCount = computed(() =>
  meta.value ? ratingStore.countFor(meta.value.id) : 0,
)

/**
 * The no-score corner (ADR-0082 addendum): neither the household nor the
 * catalog has a score, so the helper line invites the first rating. One
 * predicate (ratingNoScoreCorner), unit-pinned beside the store helpers.
 */
const noScoreCorner = computed(() =>
  meta.value ? ratingNoScoreCorner(ratingCount.value, meta.value.rating) : false,
)

/** Clear the household's rating (ADR-0082): immediate, one plain toast —
 * no confirm, clearing is reversible by re-rating with one tap. */
function clearRating() {
  if (!meta.value) return
  ratingStore.clearRating(meta.value.id)
  useUiStore().showToast('Rating cleared', { duration: 2000 })
}

/** The bar's accessible reading: one image role, one sentence. */
const macroAria = computed(() => {
  const segs = macroSegments.value
  if (segs.length === 0) return null
  return `Nutritional split per serving: ${segs
  .map((s) => `${s.label} ${Math.round(s.value * 100)}% of calories`)
  .join(', ')}`
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
 * step index -> the timer id this sheet armed for it. Ephemeral like the
 * checklist: the ARMED timer itself lives in the ui store (the ADR-0020
 * contract, the same store cooking mode uses), so a countdown keeps
 * running if the reader leaves the sheet; only this sheet's mapping of
 * which step to which timer is view state.
 */
const armedByStep = ref(new Map<number, number>())

/**
 * The recipe's build-time timer hints, loaded on demand from the sidecar
 * and cached per session — the ONE loader (useTimerHints owns the
 * stale-fetch guard), so the two surfaces cannot disagree about what a
 * step's duration is. A recipe with no sidecar resolves to no hints,
 * which is a fact about the catalog (ADR-0041).
 */
const { hintAt: hintAtFor } = useTimerHints(() => meta.value?.id)

/** The hint for one step index, if the authored text carries a duration. */
function hintAt(index: number): TimerHint | null {
  return hintAtFor([index])
}

watch(
  () => meta.value?.id,
  () => {
    readyIngredients.value = new Set()
    // The step->timer mapping is scoped to ONE recipe. The sheet component
    // is reused (`<component :is>` with no key), so without this reset a
    // step index armed for the PREVIOUS recipe would leave the next
    // recipe's same-indexed step disabled for good, with a dismiss button
    // whose `clearTimer(nextId, staleId)` is a silent no-op.
    armedByStep.value = new Map()
  },
  { immediate: true },
)

/**
 * Measured amounts for one step's detail lines (ADR-0022) — the SAME pure
 * helper the cooking view renders, so a step can never claim an amount on
 * one surface and a different one on the other. The chips preview here;
 * the cooking view's disclosure is the workspace. No match means no chip:
 * nothing is ever invented.
 */
const stepChips = computed<MeasuredChip[][]>(() => {
  const current = doc.value
  if (!current) return []
  return scaledSteps.value.map((step) =>
    measuredChipsForLines(current, step.details ?? [], factor.value, unitSystem.value),
  )
})


/** A 1s tick, alive only while a timer this sheet armed is counting. */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
function syncTick(): void {
  const live = [...armedByStep.value.values()].some((id) => {
    const t = ui.stepTimers[meta.value?.id ?? -1]?.[id]
    return isCounting(t, now.value)
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
/**
 * Forget mappings whose timer is gone from the shared store (expired, or
 * dismissed from cooking mode's strip). This is the pruning stepCountdown
 * used to do inline — a WRITE during render (the template calls it twice
 * per step), which can trip Vue's recursive-update warning and re-fires
 * the deep watch every render. The watch paths own it now: mapping and
 * store changes prune immediately, the 1s tick prunes expirations, and
 * the render reads.
 */
function pruneArms(): void {
  if (!meta.value) return
  const stale: number[] = []
  for (const [index, id] of armedByStep.value) {
    const t = ui.stepTimers[meta.value.id]?.[id]
    if (t === undefined || remainingSeconds(t, now.value) <= 0) stale.push(index)
  }
  if (stale.length === 0) return
  const next = new Map(armedByStep.value)
  for (const index of stale) next.delete(index)
  armedByStep.value = next
}

watch([armedByStep, () => ui.stepTimers], () => {
  syncTick()
  pruneArms()
}, { deep: true, immediate: true })
watch(now, pruneArms)
onUnmounted(() => {
  if (tick !== null) clearInterval(tick)
})

/**
 * Seconds left on the timer armed for one step, or null when none. READ-
 * ONLY — the template calls this during render, and a render that writes
 * reactive state (the arm-mapping pruning this used to do inline) is the
 * recursive-update hazard pruneArms now owns from the watch paths.
 */
function stepCountdown(index: number): string | null {
  const id = armedByStep.value.get(index)
  if (id === undefined || !meta.value) return null
  const timer = ui.stepTimers[meta.value.id]?.[id]
  if (!timer) return null
  const left = remainingSeconds(timer, now.value)
  if (left <= 0) return null
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
  // The concurrent-timer cap (MAX_CONCURRENT_TIMERS): a press that cannot
  // arm must SAY so, never silently do nothing — the detail's strip is the
  // ADR-0020 shared store, so the cook manages the crowded set from
  // cooking mode's own replace flow, which is where a swap belongs.
  if (id === null) {
    ui.showToast(
      `${MAX_CONCURRENT_TIMERS} timers are already running — drop one in cooking mode first.`,
      { duration: 4000 },
    )
    return
  }
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

/**
 * The "Cooked this?" pill (ADR-0083 addendum): a compact floating
 * affordance for marking the cook from the detail page — for the person
 * who never enters cooking mode. OWNER FINAL ruling (2026-10-13,
 * supersedes the slide-final, icon-static and slide-in-tail notes): the
 * pill is FLOATING again, exactly as Stitch designed — one fixed pill
 * that is NOT hooked to anything (content scrolls under it), with the
 * icon-only content kept from the icon-static ruling (the brand accent
 * dot + one CookingPot glyph; ChefHat stays the Start-cooking CTA — the
 * accessible name carries the words). Its trigger is a SENTINEL riding
 * the THIRD-FROM-LAST step (index length-3, 0-based): the pill appears
 * only once that step reaches the viewport, stays visible while the
 * tail scrolls under it, and hides again when the scroll moves back
 * above the zone. Hidden once the cook is recorded TODAY (the same
 * local-day rule the history prints). Design authority: Stitch
 * "Flambette — Recipe Detail End (Mobile Dark)" (Warm Culinary Paper).
 */
const pillTailIndex = computed(() => Math.max(0, scaledSteps.value.length - 3))
const tailStepEl = ref<HTMLElement | null>(null)
/** Sentinel ref: assigned ONLY at the tail index (ADR-0083 addendum). */
function setTailRef(el: HTMLElement | null, i: number) {
  if (i === pillTailIndex.value) tailStepEl.value = el
}
// A recipe (or servings) change re-renders the step list — drop the stale
// sentinel BEFORE the re-render (watch flush 'pre') so the next setTailRef
// assigns the NEW tail element, never a detached one.
watch(scaledSteps, () => {
  tailStepEl.value = null
})
const tailInView = ref(false)
useIntersectionObserver(
  tailStepEl,
  (entries) => {
    tailInView.value = entries.some((e) => e.isIntersecting)
  },
  { threshold: 0 },
)
/**
 * The cooked-today guard must observe the LOCAL DAY: a detail page left
 * open across midnight (or resumed from device sleep) would otherwise
 * read a stale guard until an unrelated state change. `dayTick` is a
 * deliberate dependency of the computed — bumped once by a timer armed
 * for the next local midnight and again whenever the page becomes
 * visible after being hidden (CodeRabbit, PR #84). No polling: one
 * timer, one event.
 */
const dayTick = ref(0)
let midnightTimer: ReturnType<typeof setTimeout> | undefined
function armMidnightTick() {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  clearTimeout(midnightTimer)
  midnightTimer = setTimeout(bumpDayTick, next.getTime() - now.getTime() + 1_000)
}
function bumpDayTick() {
  dayTick.value++
  armMidnightTick()
}
function onDayVisibility() {
  if (document.visibilityState === 'visible') dayTick.value++
}
onMounted(() => {
  armMidnightTick()
  document.addEventListener('visibilitychange', onDayVisibility)
})
onUnmounted(() => {
  clearTimeout(midnightTimer)
  document.removeEventListener('visibilitychange', onDayVisibility)
})
const cookedAlreadyToday = computed(() => {
  void dayTick.value
  return meta.value ? cooked.cookedToday(meta.value.id) : false
})
const cookedPillVisible = computed(
  () => tailInView.value && !cookedAlreadyToday.value && !pillPromptOpen.value,
)

/**
 * The pill's trigger context (ADR-0083 addendum): the detail page owns
 * what Undo restores — the exact prior state the pill's tap displaced,
 * captured at press time (the same snapshot discipline the cooking
 * session runs: plan entry + cleared-ingredient row, taken BEFORE
 * markCooked drops the meal from the plan). The prompt component is
 * reused AS-IS — triggers own only their context, the prompt owns the
 * experience.
 */
const pillPromptOpen = ref(false)
const pillEvent = ref<CookedEntry | null>(null)
const pillPrior = ref<{ entry: PlanEntry | null; cleared: string[] | null } | null>(null)

/**
 * Pill tap = record + the SAME prompt, no separate flow: the ONE
 * plan.markCooked path the cooking session uses (plan-aware — a planned
 * meal leaves the plan, an unplanned cook still records, ADR-0032).
 */
function cookFromPill() {
  if (!meta.value || pillEvent.value) return
  const id = meta.value.id
  const entry = plan.plan.find((e) => e.variantId === id)
  const cleared = plan.clearedIngredients[id]
  const prior = {
    entry: entry ? { ...entry } : null,
    cleared: cleared ? [...cleared] : null,
  }
  pillEvent.value = plan.markCooked(id)
  pillPrior.value = prior
  pillPromptOpen.value = true
}

/**
 * Done (or scrim/Escape): History, where the cooked entry just landed
 * (ADR-0083) — same close semantics the cooking session runs.
 */
function onPillPromptDone() {
  pillPromptOpen.value = false
  void router.push('/history')
}

/**
 * Undo: the record is removed and the user STAYS on the detail page
 * (there is no session to resume). cookedAlreadyToday recomputes, so the
 * pill offers itself again.
 */
function onPillPromptUndo() {
  pillPromptOpen.value = false
  const event = pillEvent.value
  const prior = pillPrior.value
  if (!event || !prior) return
  plan.undoMarkCooked(event, prior)
  pillEvent.value = null
  pillPrior.value = null
}

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
  // ONE seeding rule for every recipe, household-authored or not: the
  // plan entry ?? the owner's saved default (ADR-0037's chain, ONE helper).
  // The fractional-noise problem that scaling creates is handled where it
  // belongs - the DISPLAY rounding.
  servings.value = planServingsFor(m.id)
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

/** Back to wherever the user came from; deep links fall back to the
 *  catalog (ADR-0078: `/` is the marketing hero — a reader who followed
 *  a recipe link closes back into the list, never the hero). */
function close() {
  if (window.history.state?.back) router.back()
  else router.replace('/recipes')
}

function onKey(e: KeyboardEvent) {
  // The facts modal owns Escape while it is open (ADR-0039): this view
  // must not navigate away underneath it.
  if (nutritionOpen.value) return
  // The post-cook prompt owns Escape while IT is open (ADR-0083) — the
  // same registration-order rule the cooking session honours: this
  // window handler fires BEFORE AppModal's, so it must yield.
  if (pillPromptOpen.value) return
  if (e.key === 'Escape') close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // Warm the restriction artifacts (control plane + overlay) so a swapped
  // ingredient list is ready; no-op when no restriction is active.
  void restrictionPrefs.ensureLoaded()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
})

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
  class="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start"
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
  <FavouriteButton :variant-id="meta.id" :glyph="22" class="absolute top-3 right-3" />
  </figure>

  <!-- The render's meta CARD (the intro's right column): tags, title,
  facts band, actions and the nutrition split are ONE card on the paper —
  the owner's review found the pass had left them as loosely-stacked
  blocks with air between. ADR-0077 fix pass: one card, the render's
  internal rhythm (gap-3), the actions row and the nutrition split
  keeping their data-test hooks for the geometry specs. -->
  <div class="flex flex-col gap-3 rounded-xl bg-surface-raised p-4 ring-1 ring-border md:p-5">
  <header class="space-y-2.5">
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
  <!-- Metadata strip (ADR-0073, banded by ADR-0077): the render's KEY
       METADATA ROW — FOUR columns, one band, divide-x between the cells:
  Total Time / Calories (kcal/srv, never scaled) / Rating (value +
  stars) / Servings Scaler. Sodium is NOT a band cell — the authoritative
  render's four columns have no sodium, and the macro fractions already
  sum to 1, so sodium reads in the nutrition LEGEND below in its own
  droplet hue (recorded in ADR-0077). The band is the RENDER'S construction
  (paste: `grid-cols-2 sm:grid-cols-4 gap py bg-paper-base rounded-lg px`):
  a lighter base band with GAPped, LEFT-ALIGNED cells — no per-cell
  backgrounds, no divide keylines (the gap-px/bg-border trick read as
  cluttered boxes, the owner's "looks bad"). Macro splits,
  difficulty, test counts and SKUs stay rejected fictions. -->
  <dl
  class="grid grid-cols-2 gap-3 rounded-lg bg-surface px-4 py-3 sm:grid-cols-3"
  data-test="detail-metadata-strip"
  >
  <div class="flex flex-col gap-1">
  <dt class="flex items-center gap-1 font-mono-data text-[11px] uppercase tracking-wider text-text-muted">
  <Clock :size="13" aria-hidden="true" />Total time
  </dt>
  <dd class="text-headline-sm font-bold text-text">{{ meta.cooking_minutes }} mins</dd>
  </div>
  <div class="flex flex-col gap-1">
  <dt class="flex items-center gap-1 font-mono-data text-[11px] uppercase tracking-wider text-text-muted">
  <HueIcon role="energy" :size="13" />Calories
  </dt>
  <dd class="flex items-baseline gap-1 whitespace-nowrap" data-test="detail-metadata-calories">
  <span class="text-headline-sm font-bold text-text">{{ Math.round(meta.calories) }}</span>
  <span class="font-mono-data text-label-sm text-text-muted">kcal/srv</span>
  </dd>
  </div>
  <!-- Servings: the stepper is the control it has always been — same ref,
       same clamp, same ADR-0037 write on every press — restyled into the
       band. The sr-only line is the accessible reading of the control
       ("serves 4"), which is what the specs and a screen reader want. -->
  <div class="flex flex-col gap-1">
  <dt class="font-mono-data text-[11px] uppercase tracking-wider text-text-muted whitespace-nowrap">Servings scaler</dt>
  <!-- The render's stepper: two ROUND raised buttons flanking the number
  (w-7 h-7 rounded-full bg-paper-elevated) — no ring container. Same
  ref, same clamp, same ADR-0037 write on every press. -->
  <dd class="flex items-center gap-1.5">
  <button
  class="flex size-11 items-center justify-center rounded-full bg-surface-raised text-sm font-bold text-text transition-[background-color,transform] hover:bg-surface-sunken active:scale-95 disabled:opacity-40 sm:size-7"
  :disabled="servings <= 1"
  aria-label="Fewer servings"
  @click="setServings(servings - 1)"
  >
  <Minus :size="13" aria-hidden="true" />
  </button>
  <span class="min-w-6 px-1 text-center text-headline-sm font-bold text-brand-text">{{ servings }}</span>
  <button
  class="flex size-11 items-center justify-center rounded-full bg-surface-raised text-sm font-bold text-text transition-[background-color,transform] hover:bg-surface-sunken active:scale-95 disabled:opacity-40 sm:size-7"
  :disabled="!canMoreServings"
  aria-label="More servings"
  @click="setServings(servings + 1)"
  >
  <Plus :size="13" aria-hidden="true" />
  </button>
  <span class="sr-only" data-test="serves-label">serves {{ servings }}</span>
  </dd>
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

  <!-- Action row (DESIGN.md Selection and actions): ONE filled primary
  CTA (the tab's single tomato) and the outlined secondary, grouped in
  ONE row the way the render's action bar does. Not sticky: a sticky bar
  here would sit under the app header and cover the content it is meant
  to serve. The unit system control (ADR-0047) stays above them: it is
  an account setting, not a recipe fact. The render's THIRD button ("To
  Grocery") is OMITTED: the grocery list is DERIVED from the plan
  (ADR-0003) and no add-to-grocery action exists on this surface — the
  deviation is recorded in ADR-0077. -->
  <div class="space-y-2" data-test="detail-actions">
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
  ? 'rounded-lg bg-brand-tint text-brand-text'
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
  <!-- The width is RESPONSIVE, never flex-1 alone: in a column flex (a
  phone) `flex-1` zeroes the flex-basis on the MAIN AXIS, which is the
  HEIGHT — the pills collapsed to their content height and rendered
  SHORTER than the tertiary facts button below them (the inverted
  hierarchy the owner screenshotted). Full-width stacked pills on a
  phone, one shared row from sm up. -->
  <div class="flex flex-col gap-2 sm:flex-row">
  <button
  class="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand px-4 text-base font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong sm:w-auto sm:flex-1 dark:ring-1 dark:ring-brand-soft"
  data-test="start-cooking"
  @click="startCooking"
  >
  <ChefHat :size="18" aria-hidden="true" />Start cooking
  </button>
  <button
  class="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-surface-raised px-4 text-sm font-semibold text-brand-text ring-1 ring-border-strong active:bg-surface-sunken sm:w-auto sm:flex-1"
  data-test="add-to-plan"
  @click="addToPlan"
  >
  {{ inPlan ? 'Update in plan' : 'Add to plan' }}
  </button>
  </div>
  </div>

  <!-- Rate card (ADR-0082): a level-1 card headed "Rate this recipe" —
  the ONE RatingStars control at 32px (phone) / 24px (desktop, via the
  component's own lgSize), the SAME displayRating value in mono beside
  the heading (the render's "4.5 / 5.0"), the helper line, and the
  room-gated sync line. The strip's Rating cell retired: the card owns
  the rating now (no SKUs, no Material Symbols, no new hex — render
  fictions rejected per the ADR). -->
  <section
  v-if="meta"
  class="rounded-xl border border-border bg-surface p-4"
  data-test="recipe-detail-rating"
  aria-labelledby="rate-card-heading"
  >
  <div class="flex items-baseline justify-between gap-2">
  <h3
  id="rate-card-heading"
  class="text-label-md font-semibold uppercase tracking-wide text-text"
  data-test="rate-card-heading"
  >
  Rate this recipe
  </h3>
  <span v-if="ratingDisplay" class="flex items-baseline gap-1">
  <span class="font-mono-data text-label-md font-semibold text-text">{{ ratingDisplay }}</span>
  <span class="font-mono-data text-label-sm text-text-muted">/ 5.0</span>
  <!-- Clear (ADR-0082): small text control, only when the household
  has rated. Immediate, no confirm — reversible in one tap. -->
  <button
  v-if="ratingCount > 0"
  type="button"
  aria-label="Clear your rating"
  class="ml-1 text-label-sm font-medium text-text-muted underline-offset-2 hover:text-text hover:underline focus-visible:underline"
  data-test="rating-clear"
  @click="clearRating"
  >
  Clear
  </button>
  </span>
  </div>
  <RatingStars
  class="mt-2"
  :variant-id="meta.id"
  :catalog-rating="meta.rating"
  :fallback-rating="meta.rating"
  :size="32"
  :lg-size="24"
  />
  <p class="mt-2 text-body-sm text-text-muted">
  <span v-if="noScoreCorner" data-test="rating-first-rate">Be the first to rate this recipe</span>
  <span v-else>Tap a star — halves supported</span>
  <span v-if="room.inRoom" data-test="rating-synced"> · Synced to household</span>
  </p>
  </section>

  <!-- Nutrition: at the bottom of the SAME card, after the actions
  (DESIGN.md Recipe detail). ADR-0077 fix pass: the render's ONE
  segmented bar — a single track, protein/carbs/fat side by side by
  their fraction of calories — with a mono LEGEND GRID beneath (grams
  via the shared lib helper, sodium in its own hue via the droplet). The
  three stacked full-width rows this replaces were not the mock's
  composition; the render's right-hand "Daily Value Reference" label is
  a PRESENTATIONAL caption — it names what the bar shows (the per-serving
  split), not computed percentages — so it rides the heading row,
  right-aligned (render fidelity; ADR-0077 fix pass 2). -->
  <section class="border-t border-border pt-3" data-test="nutrition">
  <!-- sm+ header: the render's split-bar pair. -->
  <div class="hidden items-baseline justify-between gap-2 sm:flex">
  <h3 class="text-body-sm font-semibold">Nutritional split (per serving)</h3>
  <span class="font-mono-data text-label-sm font-normal text-text-muted whitespace-nowrap">Daily Value Reference</span>
  </div>
  <!-- Mobile header + stat row: the owner's mobile render — FIVE equal
  boxes (Energy/Protein/Carbs/Fat/Sodium), coloured small label, bold
  value, unit beneath. Sodium keeps its OWN hue (`nutrition-sodium`
  indigo — owner: sodium stays separate, never a macro colour). -->
  <div class="flex items-baseline justify-between gap-2 sm:hidden">
  <h3 class="flex items-center gap-1.5 text-body-sm font-semibold">
  <Donut :size="16" aria-hidden="true" class="shrink-0 text-text-muted" />
  Nutrition Summary
  </h3>
  <span class="font-mono-data text-label-sm font-normal text-text-muted whitespace-nowrap">Per serving</span>
  </div>
  <!-- ENERGY is the responsive member of the list (owner: on a phone it
       is redundant — the per-serving context is the header's, and
  calories read on the metadata band above): hidden below sm, part of
  the list at sm+ — a responsive toggle on the list, never a hard-coded
  count. Sodium keeps its OWN hue (`nutrition-sodium` indigo — owner:
  sodium stays separate, never a macro colour). -->
  <div v-if="meta" class="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-5 sm:hidden" data-test="nutrition-stat-boxes">
  <div class="hidden flex-col items-center gap-0.5 rounded-lg bg-surface px-1 py-2 text-center sm:flex">
  <span class="text-[10px] font-semibold text-text-muted">Energy</span>
  <span class="text-headline-sm font-bold text-text">{{ Math.round(meta.calories) }}</span>
  <span class="font-mono-data text-[10px] text-text-muted">kcal</span>
  </div>
  <div class="flex flex-col items-center gap-0.5 rounded-lg bg-surface px-1 py-2 text-center">
  <span class="text-[10px] font-semibold text-nutrition-protein">Protein</span>
  <span class="text-headline-sm font-bold text-text">{{ Math.round(macroGrams(macroSegments[0]?.value ?? 0, meta.calories, 'protein')) }}</span>
  <span class="font-mono-data text-[10px] text-text-muted">g</span>
  </div>
  <div class="flex flex-col items-center gap-0.5 rounded-lg bg-surface px-1 py-2 text-center">
  <span class="text-[10px] font-semibold text-nutrition-carbs">Carbs</span>
  <span class="text-headline-sm font-bold text-text">{{ Math.round(macroGrams(macroSegments[1]?.value ?? 0, meta.calories, 'carbs')) }}</span>
  <span class="font-mono-data text-[10px] text-text-muted">g</span>
  </div>
  <div class="flex flex-col items-center gap-0.5 rounded-lg bg-surface px-1 py-2 text-center">
  <span class="text-[10px] font-semibold text-nutrition-fat">Fat</span>
  <span class="text-headline-sm font-bold text-text">{{ Math.round(macroGrams(macroSegments[2]?.value ?? 0, meta.calories, 'fat')) }}</span>
  <span class="font-mono-data text-[10px] text-text-muted">g</span>
  </div>
  <div class="flex flex-col items-center gap-0.5 rounded-lg bg-surface px-1 py-2 text-center" data-test="nutrition-sodium-box">
  <span class="text-[10px] font-semibold text-nutrition-sodium">Sodium</span>
  <span class="text-headline-sm font-bold text-text">{{ Math.round(meta.sodium_mg) }}</span>
  <span class="font-mono-data text-[10px] text-text-muted">mg</span>
  </div>
  </div>
  <!-- The ONE split bar. Segment colours are the OWNER'S OVERRIDE of this
  addendum's first draft (which used the brand ramp and produced the
  red/orange gradient the owner rejected): the render's colours ARE this
  repo's own nutrition tokens — protein purple IS `nutrition-protein`,
  carbs teal IS `nutrition-carbs`, fat olive IS `nutrition-fat` — so no
  new hex and no collision; ADR-0036's identity concern was about a GREEN
  protein (vegetarian), which purple never risks. Sodium NEVER joins the
  bar or the legend dots (owner override: it is not a calorie macro) —
  it keeps its droplet icon. One image role, one sentence. -->
  <div
  v-if="macroSegments.length"
  class="mt-2 hidden h-2.5 w-full overflow-hidden rounded-full bg-surface sm:flex"
  role="img"
  :aria-label="macroAria ?? 'Nutritional split per serving'"
  >
  <div
  v-for="seg in macroSegments"
  :key="seg.label"
  class="h-full"
  :class="seg.color"
  :style="{ width: `${Math.round(seg.value * 100)}%` }"
  />
  </div>
  <!-- The legend: dot + label: value, mono, tabular — the render's
  grid under the bar (colons after the label, values never wrap).
  Sodium stays SEPARATED with its OWN icon (owner override, fix pass 2):
  the droplet HueIcon as before — sodium is not a calorie macro, so it
  never joins the bar's segment colours nor the legend's dots. -->
  <dl
  class="mt-2 hidden grid-cols-2 gap-x-3 gap-y-1.5 font-mono-data text-label-sm tabular-nums sm:grid sm:grid-cols-4"
  >
  <div v-for="seg in macroSegments" :key="seg.label" class="flex items-center gap-1.5 whitespace-nowrap">
  <span class="size-2.5 shrink-0 rounded-full" :class="seg.color" aria-hidden="true" />
  <dt class="text-text-muted">{{ seg.label }}:</dt>
  <dd class="font-semibold text-text">{{ Math.round(seg.grams) }}g</dd>
  </div>
  <div v-if="meta.sodium_mg" class="flex items-center gap-1.5 whitespace-nowrap" data-test="nutrition-sodium">
  <HueIcon role="sodium" :size="14" />
  <dt class="text-text-muted">Sodium:</dt>
  <dd class="font-semibold text-text">{{ Math.round(meta.sodium_mg) }}mg</dd>
  </div>
  </dl>
  <!-- The 66-row facts block would turn the detail into a wall, so the
  summary above stays and the rest opens on demand (ADR-0039). The
  trigger sits INSIDE the section: the section's position contract is
  unchanged. -->
  <button
  v-if="doc"
  class="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-surface px-4 text-sm font-semibold text-brand-text ring-1 ring-border-strong active:bg-surface-sunken sm:w-auto sm:px-3"
  aria-label="Full nutrition facts"
  aria-haspopup="dialog"
  data-test="nutrition-open"
  @click="nutritionOpen = true"
  >
  <BookOpen :size="16" aria-hidden="true" />Full nutrition facts
  </button>
  </section>
  </div>
  </div>

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
  desktop so a long step list never scrolls the mise en place away.
  ADR-0077: the render's card head is an H plus a mono "Scaled for N"
  pill, and "Mark all ready" is the card's bottom affordance rather
  than a header button — the header says what the card is, the footer
  acts on the whole of it. -->
  <section class="lg:sticky lg:top-24">
  <div class="mb-2 flex items-center justify-between gap-2">
  <h3 class="text-headline-sm">Ingredients</h3>
  <span
  class="rounded-full bg-brand-tint px-2.5 py-0.5 font-mono-data text-label-sm font-semibold text-brand-text"
  data-test="ingredients-scaled-for"
  >
  Scaled for {{ servings }}
  </span>
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
  <!-- The card's whole-row action, as the render arranges it (ADR-0077):
       a dotted-underline affordance centred under the list, still a 44px
       hit target. It toggles every row. -->
  <div class="mt-1 flex justify-center">
  <button
  class="flex min-h-11 items-center px-2 text-label-md font-medium text-text-muted underline decoration-dotted underline-offset-4 hover:text-text"
  :aria-pressed="allReady"
  data-test="mark-all-ready"
  @click="toggleAllReady"
  >
  {{ allReady ? 'All ready' : 'Mark all ready' }}
  </button>
  </div>
  <!-- Cookware (ADR-0077): the render's reading column carries the
       recipe's own equipment under the checklist. This is REAL data —
       `doc.cookwares` ships with the recipe document — so the POSITION
       is adopted and nothing is invented (a specific pan size, which the
       render prints, is fiction). -->
  <section v-if="doc.cookwares.length" class="mt-6">
  <h3 class="mb-2 text-headline-sm">Cookware</h3>
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
  </section>

  <!-- Instructions. The "Cooked this?" pill does NOT watch this section
  (on desktop the column is in view on load — that lit the pill before
  any scroll): its sentinel rides the THIRD-FROM-LAST step below
  (ADR-0083 addendum refinement, 2026-10-13). -->
  <section>
  <!-- ADR-0077: the render's step-column head carries a mono total beside
       the H — the count is real (`scaledSteps.length`); the render's
       "Preparation Steps" wording is NOT adopted, because "Instructions"
       is the catalog's own word for this prose. -->
  <div class="mb-2 flex items-center justify-between gap-2">
  <h3 class="text-headline-sm">Instructions</h3>
  <span class="font-mono-data text-label-md tabular-nums text-text-muted">
  {{ scaledSteps.length }} steps total
  </span>
  </div>
  <ol class="space-y-3">
  <li
  v-for="(step, i) in scaledSteps"
  :key="i"
  :ref="(el) => setTailRef(el as HTMLElement | null, i)"
  class="rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  data-test="detail-step"
  >
  <!-- ADR-0077: the render's step header — number badge, then the
       AUTHORED duration on the right in mono. The badge is an ESPRESSO
       disc, not a brand fill: the one tomato on this sheet is Start
       cooking (ADR-0036's one-filled-intent rule), and a filled badge on
       every step would spend it once per step. The render's step TITLES
       ("Prep Station") are fiction — the catalog has no step titles — and
       stay out. -->
  <div class="flex items-center justify-between gap-2">
  <span
  class="flex size-7 shrink-0 items-center justify-center rounded-full bg-espresso font-mono-data text-label-md font-bold text-on-brand lg:size-8 lg:text-headline-sm"
  >
  {{ i + 1 }}
  </span>
  <span
  v-if="hintAt(i)"
  class="font-mono-data text-label-md tabular-nums text-text-muted"
  data-test="detail-step-duration"
  >~{{ suggestionFromHint(hintAt(i)!).minutes }} min</span
  >
  </div>
  <p class="mt-2 text-body-md lg:text-body-lg">{{ step.primary }}</p>
  <!-- Measured amounts under the step text (ADR-0022, on the detail per
  ADR-0077): the same chips the cooking view derives, INLINE here because
  this is a preview. A step whose lines are all precise renders nothing —
  never a guessed amount. The label is the lib's verbatim (`measured: N
  unit name`), the same string the cooking view prints, so the two
  surfaces cannot disagree about what a step measures. -->
  <ul
  v-if="stepChips[i]?.length"
  class="mt-2 ml-9 flex flex-wrap gap-1.5 border-t border-border pt-2"
  data-test="detail-measured-amounts"
  >
  <li
  v-for="chip in stepChips[i] ?? []"
  :key="`${i}:${chip.lineIndex}:${chip.label}`"
  class="rounded-lg bg-surface-sunken px-2 py-0.5 font-mono-data text-label-sm tabular-nums text-text-muted"
  data-test="detail-measured-chip"
  >
  {{ chip.label }}
  </li>
  </ul>
  <!-- Inline timer affordance (ADR-0073): ONLY where the recipe's own
  sidecar reports a duration for this step — never a guessed one
  (ADR-0022). The press ARMS the duration in the shared timer store,
  so cooking mode picks it up; nothing auto-starts (ADR-0041 §4). -->
  <div v-if="hintAt(i)" class="mt-2 flex items-center gap-2">
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
  class="mt-2 space-y-0.5 border-l-2 border-border pl-3 text-body-sm text-text-muted"
  >
  <li v-for="(d, j) in step.details" :key="j">{{ d }}</li>
  </ul>
  </li>
  </ol>
  </section>
  </div>
  </template>

  <!-- The "Cooked this?" pill (ADR-0083 addendum): a compact floating
  affordance for marking the cook from the detail page — for the person
  who never enters cooking mode. Owner FINAL ruling (2026-10-13): the
  pill is FLOATING again, exactly as Stitch designed — NOT hooked to
  anything; content scrolls under it while it stays put. Design
  authority: Stitch "Flambette — Recipe Detail End (Mobile Dark)"
  (Warm Culinary Paper): right edge, ~120px above the bottom
  navigation, surface-raised fill, subtle border, the ONE popover
  shadow (ADR-0068), warm accent dot. The pointer-events-none wrapper
  keeps the fixed overlay from intercepting taps outside the pill (the
  ADR-0049 hit-testing lesson), while the app-width column keeps the
  pill on the right edge of the CONTENT on desktop, not the viewport
  edge. ICON-ONLY (the icon-static ruling, kept): the accent dot + one
  CookingPot glyph — the accessible name carries the words. Hidden
  until the LAST THREE steps come into view (the sentinel on the
  third-from-last step) and once the cook is recorded today. -->
  <div
    v-if="doc && cookedPillVisible"
    class="pointer-events-none fixed inset-x-0 bottom-[calc(120px+env(safe-area-inset-bottom))] z-40 flex justify-end"
  >
    <div class="mx-auto flex w-full max-w-app justify-end px-4">
      <button
        type="button"
        class="pointer-events-auto flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface-raised py-2 pl-3 pr-4 shadow-popover transition-colors hover:bg-surface"
        aria-label="Cooked this?"
        data-test="cooked-pill"
        @click="cookFromPill"
      >
        <span class="size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
        <CookingPot :size="16" aria-hidden="true" class="text-brand-text" />
      </button>
    </div>
  </div>

  <!-- The SAME post-cook prompt, raised over the detail page (ADR-0083
  addendum): Done/scrim/Escape -> /history via onPillPromptDone; Undo
  removes the record and the user STAYS on the detail page. -->
  <PostCookPrompt
    v-if="pillPromptOpen && pillEvent"
    :variant-id="meta.id"
    @done="onPillPromptDone"
    @undo="onPillPromptUndo"
  />
  </div>
  </div>
</template>
