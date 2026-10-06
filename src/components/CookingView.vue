<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Check,
  ChevronDown,
  Clock,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  List,
  PartyPopper,
  Pause,
  Play,
  X,
} from 'lucide-vue-next'
import { catalog, getRecipe } from '../lib/catalog'
import { restrictedDocView } from '../lib/restrictions'
import { useRestrictions } from '../composables/useRestrictions'
import { measuredChipsForLines, type MeasuredChip } from '../lib/measuredAmounts'
import { scaleSteps, type ScaledStep } from '../lib/recipe'
import { localizeSteps } from '../lib/units'
import {
  MAX_TIMER_SECONDS,
  MAX_TIMER_LABEL,
  TIMER_PRESETS_MIN,
  announceCountdown,
  formatCountdown,
  remainingSeconds,
  sameTimerType,
  type CookTimer,
} from '../lib/stepTimer'
import { getTimerHints, hintForStep, suggestionFromHint, type TimerSuggestion } from '../lib/timerSuggest'
import type { RecipeDoc } from '../lib/types'
import { usePlanStore, type CookedEntry, type PlanEntry, type PlanIdentity } from '../stores/plan'
import { useUiStore } from '../stores/ui'

const plan = usePlanStore()
const ui = useUiStore()
const router = useRouter()

/** Recipe variant id, passed as a route prop from /cooking/:id. */
const props = defineProps<{ id: number }>()

const loadedDoc = ref<RecipeDoc | null>(null)
// The restricted doc view (the restriction ADR): upstream's own substituted
// line items and step prose display when a dietary restriction is active.
// Display only — keys never come from this view.
const restrictionPrefs = useRestrictions()
const doc = computed<RecipeDoc | null>(() => {
  const base = loadedDoc.value
  if (!base) return null
  return restrictedDocView(base, restrictionPrefs.overlayFor(base.recipe_id))
})

const meta = computed(() => catalog.value?.byId.get(props.id) ?? null)

/**
 * Servings source: the plan entry's servings when the recipe is planned,
 * otherwise the remembered default (ADR-0037). No stepper here — change
 * servings from the detail sheet.
 *
 * There is deliberately NO `meta.serving_count` fallback in this computed.
 * The default starts at 6, the authored count of every catalog recipe, so
 * the two coincide on a fresh install — but naming the recipe value here
 * would be a second, silently-divergent source for the same arithmetic, and
 * the detail sheet that owns the stepper already resolves plan-entry →
 * default. `RecipeDetail` uses the same two-source order, which is what
 * keeps the number on screen and the number being cooked identical.
 *
 * Frozen at the first successful resolution (ADR-0034). It USED to be a
 * live computed over the plan, which quietly corrupted the cook: marking
 * "as cooked" mid-recipe drops the meal from the plan, the computed fell
 * back to the base `serving_count`, and every remaining step silently
 * RESCALED under the user mid-cook (a 4-serving cook became 6). The
 * session's servings are decided when it opens, like everything else about
 * it, and a mark cannot change the arithmetic of a recipe in progress.
 */
let frozenServings: number | null = null
const servings = computed(() => {
  const id = meta.value?.id
  if (id === undefined) return 1
  if (frozenServings === null) {
    const entry = plan.plan.find((e) => e.variantId === id)
    frozenServings = entry?.servings ?? ui.defaultServings
  }
  return frozenServings
})

const factor = computed(() => (doc.value ? servings.value / doc.value.serving_count : 1))
/**
 * Steps for display: scaled, then localized for the device's unit system
 * (ADR-0047). The SAME `localizeSteps` helper the recipe sheet uses, so a
 * step cannot read `220°C` in the sheet and `425°F` in the cook. The
 * session's servings stay frozen; only the display transform follows the
 * setting.
 */
const steps = computed<ScaledStep[]>(() =>
  doc.value ? localizeSteps(scaleSteps(doc.value, factor.value), ui.unitSystem) : [],
)

/* ---------- Step views: single steps + "Meanwhile" pairs (ADR-0010) ----------
 *
 * A step whose text opens with "Meanwhile" runs concurrently with the
 * PREVIOUS step, so it is rendered together with it as one view. Views
 * are keyed by their leader (the non-concurrent step); navigation moves
 * whole views, so a pair advances the cursor by two raw steps.
 */
interface StepView {
  leader: number
  partner: number | null
}

const views = computed<StepView[]>(() => {
  const list: StepView[] = []
  for (let i = 0; i < steps.value.length; i++) {
  const prev = list[list.length - 1]
  if (steps.value[i].concurrent && prev && prev.partner === null) prev.partner = i
  else list.push({ leader: i, partner: null })
  }
  return list
})

const stepIndex = computed(() => (meta.value ? ui.cookingStep(meta.value.id) : 0))
const total = computed(() => steps.value.length)

/** The view showing the stored step; a stored partner index coerces to its pair. */
const currentView = computed<StepView | null>(() => {
  const list = views.value
  if (!list.length) return null
  const raw = Math.min(Math.max(stepIndex.value, 0), total.value - 1)
  return list.find((v) => raw >= v.leader && raw <= (v.partner ?? v.leader)) ?? list[0]
})
const viewIndex = computed(() => (currentView.value ? views.value.indexOf(currentView.value) : -1))
const isFirst = computed(() => viewIndex.value <= 0)
const isLast = computed(() => viewIndex.value >= views.value.length - 1)

/** One or two steps currently on screen (leader first, then the partner). */
const visibleSteps = computed(() => {
  const v = currentView.value
  if (!v) return []
  const out = [{ step: steps.value[v.leader], partner: false }]
  if (v.partner !== null) out.push({ step: steps.value[v.partner], partner: true })
  return out
})

/** "Step 3 / 12", or "Steps 3–4 / 12" for a Meanwhile pair. */
const counterLabel = computed(() => {
  const v = currentView.value
  if (!v) return ''
  return v.partner !== null
  ? `Steps ${v.leader + 1}–${v.partner + 1} / ${total.value}`
  : `Step ${v.leader + 1} / ${total.value}`
})

function next() {
  if (meta.value && viewIndex.value < views.value.length - 1) {
  ui.setCookingStep(meta.value.id, views.value[viewIndex.value + 1].leader)
  }
}
function prev() {
  if (meta.value && viewIndex.value > 0) {
  ui.setCookingStep(meta.value.id, views.value[viewIndex.value - 1].leader)
  }
}
function close() {
  if (window.history.state?.back) router.back()
  else void router.replace('/plan')
}

/* ---------- Measured amounts under the step text (ADR-0022) ----------
 *
 * Step text is authored prose: when its own quantity cannot be parsed
 * ("juice of ¾ lemon"), the MEASURED quantity lives in `line_items` and
 * is surfaced as a subdued, collapsed-by-default chip — never invented.
 * Chips are per detail line, in step order, scaled by the current factor
 * with the SAME container/linear split the grocery list uses.
 */
const measuredOpen = ref(false)

const visibleMeasured = computed(() =>
  visibleSteps.value.map((vs) => ({
  partner: vs.partner,
  chips: doc.value
    ? measuredChipsForLines(doc.value, vs.step.details, factor.value, ui.unitSystem)
    : [],
  })),
)

function toggleMeasured() {
  measuredOpen.value = !measuredOpen.value
}

function chipKey(index: number, chip: MeasuredChip) {
  return `${index}:${chip.lineIndex}:${chip.label}`
}

/* ---------- Global timer strip (ADR-0041) ----------
 *
 * ONE strip docked above the footer and visible from EVERY step view, with
 * one chip per armed timer: a cook juggling an oven and a pot of rice
 * needs both countdowns live at once, and needs them reachable without
 * walking back to the step that started them. This reverses ADR-0038's
 * per-step placement — the countdown ENGINE never changed, only where its
 * controls live and how many can run at once.
 *
 * State lives in the ui store keyed by TIMER ID, so it survives a reload
 * honestly: a running timer keeps counting from `startedAt`, it is never
 * re-armed. No toast is fired by the countdown — the wake lock already
 * keeps the screen on and the polite live region announces minute ticks
 * only.
 */

const viewKey = computed(() => currentView.value?.leader ?? 0)

/** Ticking clock (500 ms keeps the countdown honest without work). */
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | undefined

/** Every armed timer of THIS recipe, oldest first. */
const timers = computed<CookTimer[]>(() => (meta.value ? ui.timers(meta.value.id) : []))

/** Per-chip derived seconds — never the persisted `running` flag alone. */
function remainingOf(t: CookTimer): number {
  return remainingSeconds(t, now.value)
}

/**
 * Derived, not trusted from the persisted `running` flag (qodo
 * 4128519641): a timer whose countdown has reached zero is finished, no
 * matter what the flag claims — its button offers Restart, not Pause.
 */
function isRunning(t: CookTimer): boolean {
  return remainingSeconds(t, now.value) > 0 && t.running
}

/**
 * The draft fields are step-scoped, not timer state (ADR-0042): the add
 * row is always on screen, so there is no disclosure to close — arriving
 * at a new step just clears the half-typed fields, and a draft (or a
 * suggestion) belonging to the previous step never follows the cook.
 * Watching `viewKey` also covers the Meanwhile pair swap, where the leader
 * index changes under the same step.
 *
 * Registered BEFORE the §4 watcher below on purpose: the clear runs first,
 * so a suggestion for the step we just arrived at is pre-filled into the
 * now-empty fields instead of being refused as "the user is typing".
 */
watch(viewKey, () => {
  pendingArm.value = null
  nameInput.value = ''
  minutesInput.value = ''
})

/** The recipe's own total cooking time, offered on the FIRST view only. */
const recipeTotalSuggestion = computed(() => {
  if (viewKey.value !== 0) return null
  const minutes = meta.value?.cooking_minutes ?? doc.value?.cooking_minutes ?? 0
  return minutes > 0 ? minutes : null
})

/* ---------- Recipe-detected suggestions (ADR-0041 §3) ---------- */

/**
 * The build-time hints of THIS recipe, loaded on demand from the sidecar
 * next to the recipe doc (`<variantId>.timer.json`) and cached per
 * session. `null` until loaded — a recipe with no sidecar resolves to an
 * empty list, which is a fact about the catalog (no authored durations),
 * not an error.
 */
const hints = ref<Awaited<ReturnType<typeof getTimerHints>> | null>(null)

watch(
  () => meta.value?.id,
  (id) => {
    hints.value = null
    if (id === undefined) return
    void getTimerHints(id).then((loaded) => {
      // A stale fetch (the cook navigated to another recipe) never wins.
      if (meta.value?.id === id) hints.value = loaded
    })
  },
  { immediate: true },
)

/**
 * The duration THIS step view's authored text carries, from the artifact
 * — never re-parsed at runtime, and a miss invents nothing (ADR-0022).
 * The leader index is tried first, then the paired step, because a
 * Meanwhile pair is ONE view (ADR-0010).
 */
const suggestion = computed<TimerSuggestion | null>(() => {
  if (!hints.value) return null
  const indices = [viewKey.value]
  if (visibleSteps.value[1]?.partner) indices.push(viewKey.value + 1)
  const hint = hintForStep(hints.value, indices)
  return hint ? suggestionFromHint(hint) : null
})

const nameInput = ref('')
const minutesInput = ref('')
/**
 * A 5th timer asks which chip to give up rather than widening the strip.
 * The refused value is HELD here (seconds + the label the user typed), so
 * the replacement arms exactly what the tap asked for instead of making
 * the user re-enter it.
 */
const pendingArm = ref<{ label: string; seconds: number } | null>(null)

/** Minutes the confirm button would arm right now (0 = nothing to arm). */
const pendingMinutes = computed(() => {
  const raw = Number(minutesInput.value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, MAX_TIMER_SECONDS / 60)
})

/**
 * Pre-fill the fields from the recipe's own sentence. This is a
 * PROPOSAL, not an arm: §4 — nothing a parser found ever starts
 * counting down on its own.
 */
function applySuggestion(s: TimerSuggestion) {
  nameInput.value = s.label
  minutesInput.value = String(s.minutes)
}

/**
 * ADR-0041 §4 — the row AUTO-FILLS itself when the step view on screen
 * carries an authored duration and nothing of that TYPE is counting down
 * for this recipe yet. ADR-0042 reshapes the SURFACE only: there is no
 * panel to open any more (the fields and presets are always docked above
 * the footer), so what §4 does now is write the recipe's own sentence into
 * them. The CONFIRM is still the user's, so nothing a parser found ever
 * starts counting on its own. The concurrent cap (§2) applies on top — the
 * pre-fill is a proposal either way.
 *
 * Declared after `suggestion` on purpose: a watcher reading it above
 * would be a TS2448 "used before declaration" landmine.
 *
 * Two refusals, both of them the user's intent winning:
 *  - a RUNNING timer of the SAME TYPE reads as a chip in the strip, never
 *    as a surprise pre-fill — but a live "Oven" says nothing about a "Rice"
 *    suggestion, so the gate is per-TYPE (`sameTimerType`), never
 *    per-recipe;
 *  - a half-typed draft is never clobbered: a dirty field beats an
 *    auto-fill, which is what makes a LATE sidecar resolve safe.
 *
 * A refused suggestion is not lost: `suggestionOffered` keeps it on screen
 * as a chip the cook can tap — a second pot of rice is a legitimate ask.
 */
watch(suggestion, (s) => {
  if (!s) return
  if (timers.value.some((t) => isRunning(t) && sameTimerType(t.label, s.label))) return
  if (nameInput.value.trim() !== '' || minutesInput.value.trim() !== '') return
  applySuggestion(s)
})

/**
 * Is the step's authored duration still worth OFFERING as a chip? Only
 * while a field is still empty: once the pre-fill (or the cook's own
 * typing) has filled them the row already says it, and a second
 * affordance would just duplicate what is on screen.
 */
const suggestionOffered = computed(
  () => suggestion.value !== null && (nameInput.value.trim() === '' || minutesInput.value.trim() === ''),
)

/**
 * Manage sheet (ADR-0042 §5): the armed timers, listed. The chips keep
 * their own inline buttons — this is DISCOVERABILITY (a cook who armed
 * four timers can see the whole set at a glance) and an escape hatch for
 * a crowded strip, never a second, competing control surface.
 */
const manageOpen = ref(false)

/**
 * The presets are a SCROLL row, always — never a wrapping block. The wrap
 * branch looked tidy on a wide desktop, but on a phone the row is narrow:
 * the wrapped presets stacked into a ~380px column (measured on 4868 at
 * 412px), the strip outgrew the window, and the flex container shoved the
 * footer — Mark as cooked with it — off the bottom. A scroll row is the
 * same pattern the chips row above already uses (ADR-0041's shrink rule),
 * and when the row fits there is no scrollbar: the wide-screen look is
 * unchanged.
 */
function arm(seconds: number, replacingId?: number): boolean {
  if (!meta.value) return false
  const label = nameInput.value.trim() || suggestion.value?.label || ''
  if (replacingId !== undefined) ui.replaceTimer(meta.value.id, replacingId, label, seconds)
  else if (ui.addTimer(meta.value.id, label, seconds) === null) {
    pendingArm.value = { label, seconds }
    return false
  }
  pendingArm.value = null
  nameInput.value = ''
  minutesInput.value = ''
  return true
}

/**
 * X on the add row: drop the draft and the refused arm, keep every armed
 * timer running. It is a draft reset, not a disclosure close — there is
 * nothing to hide, the row IS the surface.
 */
function cancelDraft() {
  pendingArm.value = null
  nameInput.value = ''
  minutesInput.value = ''
}

/** The ladder's one-tap presets: a full timer without the confirm. */
function armPreset(minutes: number) {
  arm(minutes * 60)
}

/** The explicit confirm — custom minutes, or an accepted suggestion. */
function confirmArm() {
  const minutes = pendingMinutes.value
  if (minutes > 0) arm(minutes * 60)
}

/** One tap pause / resume (or restart once the countdown hit zero). */
function toggle(t: CookTimer) {
  if (!meta.value) return
  if (isRunning(t)) ui.pauseTimer(meta.value.id, t.id, remainingOf(t))
  else ui.startTimer(meta.value.id, t.id, remainingOf(t))
}

/** Spoken form for one chip's polite live region (minute ticks only). */
function announce(t: CookTimer): string {
  return announceCountdown(remainingOf(t))
}

function clear(t: CookTimer) {
  if (!meta.value) return
  ui.clearTimer(meta.value.id, t.id)
}

/** Which chip the user gave up from the at-cap prompt. */
function replaceWith(id: number) {
  const held = pendingArm.value
  if (!held) return
  arm(held.seconds, id)
}

/**
 * Leaving the cook session must not silently kill a running timer: the
 * user is asked once (Cancel keeps the timer running). EVERY timer of this
 * recipe is checked, not just the ones whose step is on screen, and a
 * timer is "running" only while its derived countdown is above zero (qodo
 * 4128519620 / 4128519641) — expired chips leave silently. The question
 * names the labels: with several countdowns running, "a timer" is
 * ambiguous, and the user has to know WHICH work they are abandoning.
 */
function confirmTimerBeforeLeaving(): boolean {
  const live = timers.value.filter((t) => isRunning(t))
  if (live.length === 0) return true
  if (live.length === 1) {
    const only = live[0]
    return window.confirm(
      `The ${only.label} timer is still running (${formatCountdown(remainingOf(only))} left). Leave anyway?`,
    )
  }
  return window.confirm(
    `${live.length} timers are still running (${live.map((t) => t.label).join(', ')}). Leave anyway?`,
  )
}

/**
 * Plan provenance of THIS cook session (ADR-0034), captured WHEN THE
 * SESSION OPENS — not on the first press. A peer can change the plan while
 * the dialog is open (someone cooks the meal on the other phone, or adds
 * it), and the answer to "which plan was this cook made under" is the plan
 * the cook STARTED under. Lazy capture would answer with whatever the plan
 * happened to be at press time, which flips a household cook into an ad-hoc
 * one for no reason. The identity is the real plan's when the recipe is
 * planned, else a freshly minted ad-hoc one-recipe plan (owner rule); it is
 * never stored as the store's own plan id.
 */
const sessionPlan: PlanIdentity = plan.cookPlanIdentity(props.id)

/** The cook event THIS session has already recorded, if any. */
const sessionCooked = ref<CookedEntry | null>(null)
const sessionRecorded = computed(() => sessionCooked.value !== null)

/**
 * Record this cook, with an undo that restores the exact prior state
 * (ADR-0034). The snapshot is taken at press time, before markCooked
 * drops the meal from the plan and forgets its cleared ingredients —
 * afterwards neither is knowable.
 *
 * A session records at most ONE cook: marking mid-way and then pressing
 * Finish is one cook, not two, and the button is disabled after the mark so
 * the user is never asked to choose. Finish after a mid-cook mark therefore
 * just closes — the cook is already recorded and the plan already updated.
 */
function recordCook(opts: { message: string; close: boolean }): boolean {
  if (sessionCooked.value) {
  if (opts.close) close()
  return true
  }
  if (!confirmTimerBeforeLeaving()) return false
  const id = props.id
  const entry = plan.plan.find((e) => e.variantId === id)
  const cleared = plan.clearedIngredients[id]
  const prior: { entry: PlanEntry | null; cleared: string[] | null } = {
  entry: entry ? { ...entry } : null,
  cleared: cleared ? [...cleared] : null,
  }
  const event: CookedEntry = plan.markCooked(id, sessionPlan)
  sessionCooked.value = event
  ui.showToast(opts.message, {
  actions: [
  {
  label: 'Undo',
  // Undo hands the session back its un-recorded state, so a Finish
  // after it records the cook properly instead of being swallowed by
  // the "already marked" guard.
  run: () => {
  plan.undoMarkCooked(event, prior)
  sessionCooked.value = null
  },
  testId: 'cook-undo',
  },
  ],
  duration: 6000,
  })
  if (opts.close) close()
  return true
}

/** Mid-cook mark: record the event and KEEP COOKING (ADR-0034). */
function markCookedEarly() {
  recordCook({ message: 'Marked as cooked', close: false })
}

/**
 * Finish on the last step is ONE action: record the cook event AND take
 * the meal off the plan (markCooked already does both — the change is in
 * the buttons, not the store), then close (ADR-0034).
 */
function finishCooked() {
  recordCook({ message: 'Enjoy! Marked as cooked', close: true })
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') {
  e.preventDefault()
  next()
  } else if (e.key === 'ArrowLeft') {
  e.preventDefault()
  prev()
  } else if (e.key === 'Escape') {
  // The manage sheet owns Escape while it is open, exactly as the facts
  // modal does in RecipeDetail (ADR-0039): one Escape closes the NEAREST
  // thing, and closing the cook session under an open sheet would throw
  // away a running timer behind a stray keypress.
  if (manageOpen.value) {
  e.preventDefault()
  manageOpen.value = false
  return
  }
  e.preventDefault()
  if (confirmTimerBeforeLeaving()) close()
  }
}

/* ---------- Screen wake lock (best effort) ---------- */

type WakeLockSentinel = { release(): Promise<void> }
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> }
}
let wakeLock: WakeLockSentinel | null = null

async function acquireWakeLock() {
  try {
  wakeLock = (await (navigator as WakeLockNavigator).wakeLock?.request('screen')) ?? null
  } catch {
  // Denied or unsupported — cooking still works, screen may dim.
  wakeLock = null
  }
}
async function releaseWakeLock() {
  try {
  await wakeLock?.release()
  } catch {
  // Already released.
  }
  wakeLock = null
}
function onVisibility() {
  if (document.visibilityState === 'visible' && meta.value) void acquireWakeLock()
}

async function loadDoc() {
  if (!meta.value) return
  loadedDoc.value = null
  try {
  loadedDoc.value = await getRecipe(meta.value)
  } catch {
  loadedDoc.value = null
  }
}

/**
 * A cooking link to an id the catalog does not have is a dead end: the
 * route is ungated for real recipes (ADR-0034), not for ids that do not
 * exist, and cooking mode hides the app's navigation — so hand it to the
 * detail view, which owns the not-found state. Waits for the catalog to be
 * loaded first, so a slow boot is never mistaken for a missing recipe.
 */
watch(
  () => Boolean(catalog.value) && !meta.value,
  (missing) => {
  if (missing) void router.replace({ name: 'recipe', params: { id: String(props.id) } })
  },
  { immediate: true },
)

onMounted(() => {
  void loadDoc()
  void acquireWakeLock()
  // Warm the restriction artifacts so substituted steps are ready (no-op
  // when no restriction is active).
  void restrictionPrefs.ensureLoaded()
  tickHandle = setInterval(() => {
  now.value = Date.now()
  }, 500)
  window.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  if (tickHandle) clearInterval(tickHandle)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('visibilitychange', onVisibility)
  void releaseWakeLock()
})

/* ---------- Swipe left/right on the step body (bonus) ---------- */
let touchStartX: number | null = null
function onTouchStart(e: TouchEvent) {
  touchStartX = e.changedTouches[0].clientX
}
function onTouchEnd(e: TouchEvent) {
  if (touchStartX === null) return
  const dx = e.changedTouches[0].clientX - touchStartX
  touchStartX = null
  if (Math.abs(dx) < 48) return
  if (dx < 0) next()
  else prev()
}
</script>

<template>
  <div
  v-if="meta"
  class="fixed inset-0 z-40 flex flex-col"
  role="dialog"
  aria-modal="true"
  :aria-label="`Cooking ${meta.name}`"
  >
  <!-- Header: name, servings, progress + thin progress bar -->
  <header class="border-b">
  <div class="mx-auto flex max-w-reading items-center justify-between gap-2 px-4 py-3">
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-full text-lg"
  aria-label="Close cooking mode"
  @click="confirmTimerBeforeLeaving() && close()"
  >
  <X :size="20" aria-hidden="true" />
  </button>
  <div class="min-w-0 flex-1 text-center">
  <p class="truncate text-sm font-bold tracking-tight">{{ meta.name }}</p>
  <p class="text-xs" aria-live="polite" data-test="cook-serves">
  serves {{ servings }} ·
  <span class="font-semibold" data-test="step-counter">{{ counterLabel }}</span>
  </p>
  </div>
  <span class="size-11 shrink-0" aria-hidden="true"></span>
  </div>
  <div class="mx-auto mb-2 h-1 max-w-reading overflow-hidden rounded-full">
  <div
  class="h-full rounded-full bg-brand transition-all"
  :style="{
  width: currentView
  ? `${(((currentView.partner ?? currentView.leader) + 1) / total) * 100}%`
  : '0%',
  }"
  />
  </div>
  </header>

  <!-- Step body -->
  <!-- Step body. `min-h-0` is not decoration: without it the flex
  minimum-size rule (min-height: auto) lets a tall step GROW this body
  instead of scrolling it, shoving the pinned timer strip and footer off
  the bottom of a short window (the owner cooked on a ~500px-tall window
  and the Start confirm + Mark as cooked vanished). The body is the thing
  that scrolls; the chrome below it never moves. -->
  <div
  class="min-h-0 flex-1 overflow-y-auto px-4 py-6"
  @touchstart.passive="onTouchStart"
  @touchend.passive="onTouchEnd"
  >
  <div v-if="!doc" class="mx-auto max-w-reading space-y-3" aria-busy="true">
  <div class="h-10 w-3/4 animate-pulse rounded bg-surface-sunken" />
  <div class="h-6 w-1/2 animate-pulse rounded bg-surface-sunken" />
  </div>

  <div
  v-else-if="visibleSteps.length"
  class="mx-auto max-w-reading space-y-6"
  :data-test="visibleSteps.length > 1 ? 'step-pair' : 'step-single'"
  >
  <template v-for="(vs, i) in visibleSteps" :key="i">
  <div
  v-if="vs.partner"
  class="flex items-center gap-3 text-sm font-semibold text-brand-text"
  role="separator"
  aria-label="Meanwhile — do this at the same time"
  data-test="meanwhile-divider"
  >
  <span class="h-px flex-1" aria-hidden="true"></span>
  <span>Meanwhile</span>
  <span class="h-px flex-1" aria-hidden="true"></span>
  </div>
  <p
  class="text-xl leading-relaxed font-medium sm:text-2xl sm:leading-relaxed"
  :data-test="vs.partner ? 'step-partner-text' : 'step-text'"
  >
  {{ vs.step.primary }}
  </p>
  <ul v-if="vs.step.details.length" class="space-y-2">
  <li
  v-for="(d, j) in vs.step.details"
  :key="j"
  class="flex items-start gap-3 rounded-xl p-3 text-sm ring-1"
  >
  <span
  class="mt-0.5 size-5 shrink-0 rounded border-2"
  aria-hidden="true"
  ></span>
  <span class="leading-relaxed">{{ d }}</span>
  </li>
  </ul>
  <!-- Measured amounts (ADR-0022): only when an imprecise step line
  names an ingredient whose measured quantity is known. -->
  <div
  v-if="visibleMeasured[i]?.chips.length"
  class="mt-2 space-y-1 text-xs"
  data-test="measured-amounts"
  >
  <button
  class="flex items-center gap-1 rounded-lg px-2 py-1 font-medium"
  data-test="measured-toggle"
  :aria-expanded="measuredOpen"
  :aria-label="`${measuredOpen ? 'Hide' : 'Show'} measured ingredient amounts`"
  @click="toggleMeasured"
  >
  <ChevronDown v-if="measuredOpen" :size="16" aria-hidden="true" />
  <ChevronRight v-else :size="16" aria-hidden="true" />
  Ingredient amounts ({{ visibleMeasured[i]?.chips.length ?? 0 }})
  </button>
  <ul v-if="measuredOpen" class="space-y-1 pl-3">
  <li
  v-for="chip in visibleMeasured[i]?.chips ?? []"
  :key="chipKey(i, chip)"
  class="rounded-lg px-2 py-1 text-text-muted"
  data-test="measured-chip"
  >
  {{ chip.label }}
  </li>
  </ul>
  </div>
  </template>
  </div>
  </div>

  <!-- Global timer strip (ADR-0041): ONE strip docked above the
  footer and visible from EVERY step view, one chip per armed timer.
  The controls are global again (this reverses ADR-0038's per-step
  placement) because a cook juggling an oven and a pot of rice needs
  both countdowns live at once and reachable without walking back to
  the step that started them. Only the current view is mounted, so a
  suggestion belongs to the step on screen and the ladder closes on
  navigation. -->
  <div
  v-if="doc"
  class="bg-surface-raised px-4 py-2"
  data-test="timer-strip"
  >
  <div class="mx-auto max-w-reading space-y-2">
  <!-- Armed timers: one chip each, countdowns independent. The row
  scrolls when four chips cannot fit (ADR-0041's shrink rule) rather
  than truncating a countdown. The manage button sits OUTSIDE the
  scroller so it never scrolls away with the chips. -->
  <div v-if="timers.length" class="flex items-center gap-2">
  <div class="flex min-w-0 flex-1 gap-2 overflow-x-auto" data-test="timer-chips">
  <div
  v-for="t in timers"
  :key="t.id"
  class="flex shrink-0 items-center gap-1 rounded-xl border px-2 py-1"
  :data-test="`timer-chip-${t.id}`"
  >
  <span
  class="max-w-28 truncate text-xs font-semibold"
  data-test="chip-name"
  >{{ t.label }}</span
  >
  <button
  class="flex h-11 min-w-20 shrink-0 items-center justify-center gap-1 px-1 font-mono text-base font-semibold tabular-nums"
  :class="isRunning(t) ? 'text-brand-text' : ''"
  data-test="step-timer"
  aria-live="polite"
  :aria-label="
  isRunning(t)
  ? `Pause ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  : `Start ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  "
  @click="toggle(t)"
  >
  <Pause v-if="isRunning(t)" :size="16" aria-hidden="true" />
  <Play v-else :size="16" aria-hidden="true" />
  <span>{{ formatCountdown(remainingOf(t)) }}</span>
  <span class="sr-only">{{ announce(t) }}</span>
  </button>
  <button
  class="flex size-11 shrink-0 items-center justify-center"
  data-test="timer-clear"
  :aria-label="`Delete the ${t.label} timer`"
  @click="clear(t)"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </div>
  </div>
  </div>

  <!-- Manage button (ADR-0042 §5): the ONE affordance the baseline row
  did not have. The chips stay usable inline; this is how a cook SEES
  the whole set at a glance once four of them are running. -->
  <button
  v-if="timers.length"
  class="flex size-11 shrink-0 items-center justify-center rounded-full border"
  data-test="timer-fab"
  aria-label="Manage timers"
  @click="manageOpen = true"
  >
  <List :size="18" aria-hidden="true" />
  </button>

  <!-- The add ROW (ADR-0042): name · minutes · presets · Start · X, in
  one horizontal line, always on screen. There is no disclosure left —
  a timer can be armed from any step, and one that the recipe itself
  timed is already PROPOSED in the fields (ADR-0041 §3/§4). Arming is
  still the user's: nothing here starts counting on its own. -->
  <div class="flex items-center gap-2" data-test="timer-add-row">
  <label class="sr-only" for="timer-name-input">Timer name</label>
  <input
  id="timer-name-input"
  v-model="nameInput"
  type="text"
  :maxlength="MAX_TIMER_LABEL"
  placeholder="Name (e.g. Rice)"
  class="h-11 min-w-0 flex-1 rounded-xl border px-2 text-sm"
  data-test="timer-name"
  />
  <label class="sr-only" for="timer-minutes-input">Timer minutes</label>
  <input
  id="timer-minutes-input"
  v-model="minutesInput"
  type="number"
  inputmode="numeric"
  min="1"
  :max="MAX_TIMER_SECONDS / 60"
  placeholder="Min"
  class="h-11 w-16 shrink-0 rounded-xl border px-2 text-sm"
  data-test="timer-minutes"
  />
  <!-- The one-tap presets, and the explicit confirm every custom
  minute count passes through (ADR-0041 §4). -->
  <!-- The one-tap presets: always a horizontal scroll row (never a
  wrapping block — see the arm() comment above). -->
  <div
  class="flex min-w-0 flex-1 gap-1 overflow-x-auto"
  data-test="timer-presets"
  >
  <button
  v-for="m in TIMER_PRESETS_MIN"
  :key="m"
  class="h-11 shrink-0 rounded-lg border px-2 text-xs font-medium"
  :data-test="`timer-preset-${m}`"
  :aria-label="`Start a ${m} minute timer`"
  @click="armPreset(m)"
  >
  {{ m }}m
  </button>
  <button
  v-if="recipeTotalSuggestion"
  class="h-11 shrink-0 rounded-lg border border-dashed px-2 text-xs font-medium"
  data-test="timer-preset-recipe"
  :aria-label="`Start a timer for the recipe total cooking time of ${recipeTotalSuggestion} minutes`"
  @click="armPreset(recipeTotalSuggestion)"
  >
  <Ellipsis :size="14" aria-hidden="true" class="mr-0.5 inline align-[-2px]" />
  {{ recipeTotalSuggestion }}m total
  </button>
  </div>
  <button
  class="h-11 shrink-0 rounded-lg px-2 text-xs font-semibold text-brand-text"
  :class="pendingMinutes > 0 ? '' : 'opacity-50'"
  :disabled="pendingMinutes <= 0"
  data-test="timer-confirm"
  :aria-label="`Start the ${nameInput || 'step'} timer for ${pendingMinutes} minutes`"
  @click="confirmArm"
  >
  <Check :size="14" aria-hidden="true" class="mr-0.5 inline align-[-2px]" />
  Start
  </button>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-lg border"
  data-test="timer-cancel"
  aria-label="Clear the timer fields"
  @click="cancelDraft"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </div>

  <!-- A step's authored duration, OFFERED as a chip (ADR-0042): shown
  only while a field is still empty — the §4 pre-fill has normally
  written it into the row already, and a refused one (a timer of the
  same type is live) is a legitimate second ask. -->
  <div v-if="suggestionOffered && suggestion" class="flex items-center gap-2" data-test="timer-suggest-row">
  <button
  class="flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-dashed px-2 text-left text-xs font-medium"
  data-test="timer-suggest"
  :aria-label="`Use the ${suggestion.minutes} minute ${suggestion.label} timer this step suggests`"
  @click="applySuggestion(suggestion)"
  >
  <Clock :size="16" aria-hidden="true" class="shrink-0" />
  <span class="min-w-0 truncate">
  {{ suggestion.label }} · {{ suggestion.minutes }} min
  </span>
  </button>
  </div>

  <!-- At the concurrent cap (ADR-0041 §2): the row asks which chip to
  give up rather than widening the strip. INLINE "Replace N?" chips —
  no panel, one tap still swaps, and the refused label/seconds are held
  in `pendingArm` so the replacement arms exactly what was asked for.
  No timer is ever dropped without an explicit choice. -->
  <div
  v-if="pendingArm"
  class="flex flex-wrap items-center gap-2 rounded-xl border px-2 py-1 text-xs"
  data-test="timer-replace-prompt"
  >
  <span>Four timers is the limit. Replace which one?</span>
  <button
  v-for="t in timers"
  :key="t.id"
  class="h-11 rounded-lg border px-2 font-medium"
  :data-test="`timer-replace-${t.id}`"
  :aria-label="`Replace the ${t.label} timer`"
  @click="replaceWith(t.id)"
  >
  {{ t.label }}
  </button>
  </div>
  </div>
  </div>

  <!-- Manage sheet (ADR-0042 §5): the armed timers listed, each with
  the same Pause/Restart/Clear verbs its chip carries. Teleported to the
  body so it is not clipped by the dialog's own overflow; scrim and
  Escape both close it, and a running timer is never touched by simply
  opening or dismissing it. -->
  <Teleport to="body">
  <div
  v-if="manageOpen"
  class="fixed inset-0 z-40 flex items-end justify-center bg-surface-dark/50"
  data-test="timer-manage-scrim"
  @click.self="manageOpen = false"
  >
  <div
  class="w-full max-w-app space-y-3 rounded-t-2xl bg-surface-raised p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
  role="dialog"
  aria-label="Manage timers"
  data-test="timer-manage-sheet"
  >
  <div class="flex items-center justify-between">
  <h3 class="text-sm font-bold tracking-tight">Timers</h3>
  <button
  class="flex size-11 items-center justify-center rounded-full hover:bg-surface-sunken"
  data-test="timer-manage-close"
  aria-label="Close the timer list"
  @click="manageOpen = false"
  >
  <X :size="18" aria-hidden="true" />
  </button>
  </div>
  <ul class="space-y-2">
  <li
  v-for="t in timers"
  :key="t.id"
  class="flex items-center gap-2 rounded-xl border px-2 py-1"
  data-test="timer-manage-row"
  >
  <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ t.label }}</span>
  <button
  class="flex h-11 min-w-20 shrink-0 items-center justify-center gap-1 px-1 font-mono text-base font-semibold tabular-nums"
  :class="isRunning(t) ? 'text-brand-text' : ''"
  :data-test="`timer-manage-toggle-${t.id}`"
  :aria-label="
  isRunning(t)
  ? `Pause ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  : `Start ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  "
  @click="toggle(t)"
  >
  <Pause v-if="isRunning(t)" :size="16" aria-hidden="true" />
  <Play v-else :size="16" aria-hidden="true" />
  <span>{{ formatCountdown(remainingOf(t)) }}</span>
  </button>
  <button
  class="flex size-11 shrink-0 items-center justify-center"
  :data-test="`timer-manage-clear-${t.id}`"
  :aria-label="`Delete the ${t.label} timer`"
  @click="clear(t)"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </li>
  </ul>
  </div>
  </div>
  </Teleport>

  <!-- Big navigation buttons -->
  <footer class="border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
  <div class="mx-auto flex max-w-reading flex-col gap-2">
  <div class="flex gap-3">
  <button
  class="h-14 min-w-28 flex-1 rounded-xl border text-base font-semibold transition-opacity disabled:opacity-40"
  :disabled="isFirst"
  @click="prev"
  >
  <ChevronLeft :size="18" aria-hidden="true" class="mr-1 inline" />
  Previous
  </button>
  <button
  v-if="!isLast"
  class="h-14 flex-[2] rounded-xl bg-brand text-base font-semibold text-on-brand shadow-sm active:bg-brand-strong"
  @click="next"
  >
  Next
  <ChevronRight :size="18" aria-hidden="true" class="ml-1 inline" />
  </button>
  <button
  v-else
  class="h-14 flex-[2] rounded-xl bg-brand text-base font-semibold text-on-brand shadow-sm active:bg-brand-strong"
  data-test="finish"
  aria-label="Finish cooking and mark as cooked"
  @click="finishCooked"
  >
  Finish
  <PartyPopper :size="18" aria-hidden="true" class="ml-1 inline" />
  </button>
  </div>
  <!-- Mark as cooked is reachable from ANY step; on the last step
  Finish above IS the mark, so there is never a second button
  offering the same action (ADR-0034). A session records ONE
  cook: after the mid-cook mark the button reports that and
  stops inviting a second one. -->
  <button
  v-if="!isLast"
  class="h-12 rounded-xl border text-sm font-semibold text-brand-text active:bg-surface-sunken disabled:opacity-60"
  data-test="mark-cooked"
  aria-label="Mark as cooked and keep cooking"
  :disabled="sessionRecorded"
  @click="markCookedEarly"
  >
  <Check v-if="!sessionRecorded" :size="16" aria-hidden="true" class="mr-1 inline" />
  {{ sessionRecorded ? 'Marked as cooked' : 'Mark as cooked' }}
  </button>
  </div>
  </footer>
  </div>
</template>
