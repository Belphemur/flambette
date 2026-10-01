<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  PartyPopper,
  Pause,
  Play,
  X,
} from 'lucide-vue-next'
import { catalog, getRecipe } from '../lib/catalog'
import { measuredChipsForLines, type MeasuredChip } from '../lib/measuredAmounts'
import { scaleSteps, type ScaledStep } from '../lib/recipe'
import {
  TIMER_PRESETS_MIN,
  announceCountdown,
  formatCountdown,
  remainingSeconds,
} from '../lib/stepTimer'
import type { RecipeDoc } from '../lib/types'
import { usePlanStore, type CookedEntry, type PlanEntry, type PlanIdentity } from '../stores/plan'
import { useUiStore } from '../stores/ui'

const plan = usePlanStore()
const ui = useUiStore()
const router = useRouter()

/** Recipe variant id, passed as a route prop from /cooking/:id. */
const props = defineProps<{ id: number }>()

const doc = ref<RecipeDoc | null>(null)

const meta = computed(() => catalog.value?.byId.get(props.id) ?? null)

/**
 * Servings source: the plan entry's servings when the recipe is planned,
 * otherwise the recipe's base serving_count. No stepper here — change
 * servings from the detail sheet.
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
  frozenServings = entry?.servings ?? meta.value!.serving_count
  }
  return frozenServings
})

const factor = computed(() => (doc.value ? servings.value / doc.value.serving_count : 1))
const steps = computed<ScaledStep[]>(() => (doc.value ? scaleSteps(doc.value, factor.value) : []))

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
  chips: doc.value ? measuredChipsForLines(doc.value, vs.step.details, factor.value) : [],
  })),
)

function toggleMeasured() {
  measuredOpen.value = !measuredOpen.value
}

function chipKey(index: number, chip: MeasuredChip) {
  return `${index}:${chip.lineIndex}:${chip.label}`
}

/* ---------- Step timers (ADR-0020) ----------
 *
 * ONE timer per step VIEW (a "Meanwhile" pair is a single view and shares
 * one timer), keyed by the view leader's raw step index. State lives in the
 * ui store keyed by variant id, so it survives a reload honestly: a
 * running timer keeps counting from `startedAt`, it is never re-armed.
 * No toast is fired by the countdown — the wake lock already keeps the
 * screen on and the polite live region announces minute ticks only.
 */

const variantId = computed(() => meta.value?.id ?? 0)
const viewKey = computed(() => currentView.value?.leader ?? 0)

/** Ticking clock (500 ms keeps the countdown honest without work). */
const now = ref(Date.now())
let tickHandle: ReturnType<typeof setInterval> | undefined

const timer = computed(() => ui.stepTimer(variantId.value, viewKey.value))
const timerRemaining = computed(() => remainingSeconds(timer.value, now.value))
/**
 * Derived, not trusted from the persisted `running` flag (qodo
 * 4128519641): a timer whose countdown has reached zero is finished, no
 * matter what the flag claims — its button offers Restart, not Pause.
 */
const timerRunning = computed(() => remainingSeconds(timer.value, now.value) > 0 && !!timer.value?.running)
const timerLabel = computed(() => formatCountdown(timerRemaining.value))
/** Only changes on minute boundaries → the live region stays quiet. */
const timerAnnouncement = computed(() => announceCountdown(timerRemaining.value))
/** The recipe's own total cooking time, offered on the FIRST view only. */
const recipeTotalSuggestion = computed(() => {
  if (viewKey.value !== 0) return null
  const minutes = meta.value?.cooking_minutes ?? doc.value?.cooking_minutes ?? 0
  return minutes > 0 ? minutes : null
})

/** Start a preset, or restart the current countdown when re-tapped. */
function startTimer(seconds: number) {
  if (!meta.value) return
  ui.startStepTimer(meta.value.id, viewKey.value, seconds)
}

/** One tap start / stop. Stopping freezes the remaining seconds. */
function toggleTimer() {
  if (!meta.value || !timer.value) return
  if (timerRunning.value) {
  ui.pauseStepTimer(meta.value.id, viewKey.value, timerRemaining.value)
  } else {
  ui.startStepTimer(meta.value.id, viewKey.value, timerRemaining.value || 300)
  }
}

function clearTimer() {
  if (!meta.value) return
  ui.clearStepTimer(meta.value.id, viewKey.value)
}

/**
 * Leaving the cook session must not silently kill a running timer: the
 * user is asked once (Cancel keeps the timer running). EVERY step view
 * of this recipe is checked, not just the visible one (qodo
 * 4128519620), and a timer is "running" only while its derived
 * countdown is above zero (qodo 4128519641) — an expired timer leaves
 * silently.
 */
function confirmTimerBeforeLeaving(): boolean {
  const timers = ui.stepTimers[variantId.value] ?? {}
  for (const state of Object.values(timers)) {
  if (remainingSeconds(state, now.value) > 0 && state.running) {
  return window.confirm(
  `A timer is still running (${formatCountdown(remainingSeconds(state, now.value))} left). Leave anyway?`,
  )
  }
  }
  return true
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
  doc.value = null
  try {
  doc.value = await getRecipe(meta.value)
  } catch {
  doc.value = null
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
  <div
  class="flex-1 overflow-y-auto px-4 py-6"
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

  <!-- Step timers (ADR-0020): one per step view, collapsed to a strip
  above the nav buttons so the step text keeps the screen. -->
  <div
  v-if="doc"
  class="border-t px-4 py-2"
  data-test="step-timer-bar"
  >
  <div class="mx-auto flex max-w-reading items-center gap-2">
  <button
  v-if="timer"
  class="flex h-11 min-w-24 shrink-0 items-center justify-center gap-1 rounded-xl border px-3 font-mono text-base font-semibold tabular-nums"
  :class="timerRunning ? 'text-brand-text' : ''"
  data-test="step-timer"
  aria-live="polite"
  :aria-label="timerRunning ? `Pause timer, ${timerLabel} left` : `Start timer, ${timerLabel} left`"
  @click="toggleTimer"
  >
  <Pause v-if="timerRunning" :size="16" aria-hidden="true" />
  <Play v-else :size="16" aria-hidden="true" />
  <span>{{ timerLabel }}</span>
  <span class="sr-only">{{ timerAnnouncement }}</span>
  </button>
  <div v-else class="h-11 min-w-24 shrink-0"></div>

  <!-- Presets: one tap each. The recipe's own cooking time is
  offered once, on the first view, explicitly labelled as the
  RECIPE TOTAL so it is not read as this step's time. -->
  <div class="flex min-w-0 flex-1 flex-wrap gap-1">
  <button
  v-for="m in TIMER_PRESETS_MIN"
  :key="m"
  class="h-11 rounded-lg border px-2 text-xs font-medium"
  :data-test="`timer-preset-${m}`"
  :aria-label="`Set a ${m} minute timer`"
  @click="startTimer(m * 60)"
  >
  {{ m }}m
  </button>
  <button
  v-if="recipeTotalSuggestion"
  class="h-11 rounded-lg border border-dashed px-2 text-xs font-medium"
  data-test="timer-preset-recipe"
  :aria-label="`Set a timer for the recipe total cooking time of ${recipeTotalSuggestion} minutes`"
  @click="startTimer(recipeTotalSuggestion * 60)"
  >
  <Ellipsis :size="14" aria-hidden="true" class="mr-0.5 inline align-[-2px]" />
  {{ recipeTotalSuggestion }}m total
  </button>
  <button
  v-if="timer"
  class="h-11 rounded-lg border px-2 text-xs font-medium"
  data-test="timer-clear"
  aria-label="Clear this step timer"
  @click="clearTimer"
  >
  <X :size="16" aria-hidden="true" />
  </button>
  </div>
  </div>
  </div>

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
