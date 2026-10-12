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
  Plus,
  X,
} from 'lucide-vue-next'
import { catalog, getRecipe } from '../lib/catalog'
import { eventsDocView, restrictedDocView } from '../lib/restrictions'
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
  isCounting,
  remainingSeconds,
  type CookTimer,
} from '../lib/stepTimer'
import { hintForStep, suggestionFromHint, type TimerSuggestion } from '../lib/timerSuggest'
import { useTimerHints } from '../composables/useTimerHints'
import {
  ensureTimerAlertPolling,
  unlockTimerAlertAudio,
} from '../lib/timerAlertHost'
import type { RecipeDoc } from '../lib/types'
import { usePlanStore, type CookedEntry, type PlanEntry, type PlanIdentity } from '../stores/plan'
import { planServingsFor } from '../composables/usePlanServings'
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
  // Same precedence as the detail sheet (the two surfaces must read ONE
  // view): the per-recipe events map wins when upstream has an exact
  // rework, the dictionary view is the fallback.
  return (
    eventsDocView(base, restrictionPrefs.index.value, restrictionPrefs.activeIds.value) ??
    restrictedDocView(base, restrictionPrefs.index.value, restrictionPrefs.activeIds.value)
  )
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
    // ADR-0037's chain (plan entry ?? remembered default), ONE helper.
    frozenServings = planServingsFor(id)
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
const visibleMeasured = computed(() =>
  visibleSteps.value.map((vs) => ({
  partner: vs.partner,
  chips: doc.value
    ? measuredChipsForLines(doc.value, vs.step.details, factor.value, ui.unitSystem)
    : [],
  })),
)

/**
 * The checklist card's rows (ADR-0081): every measured amount of the
 * WHOLE view — a Meanwhile pair is one view (ADR-0010) — flattened in
 * step order, each with a stable ephemeral key.
 */
const checklistRows = computed(() =>
  visibleMeasured.value.flatMap((vm, i) =>
  vm.chips.map((chip) => ({ key: chipKey(i, chip), chip })),
  ),
)

/**
 * Checked state is EPHEMERAL per-step view state (ADR-0081): the chips
 * were never persisted and the checklist is a "did I add this yet" aid,
 * not household state. Cleared on every step-view change by the §timer
 * `viewKey` watcher below.
 */
const checkedIngredients = ref<Set<string>>(new Set())

function isChecked(key: string): boolean {
  return checkedIngredients.value.has(key)
}

function toggleChecked(key: string) {
  const next = new Set(checkedIngredients.value)
  if (!next.delete(key)) next.add(key)
  checkedIngredients.value = next
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

/** Slim progress-bar width for a card timer row: the FRACTION still
 * remaining over the duration the timer was ARMED with (`total`, not the
 * mutable segment base `remaining` — pause/start overwrite that). Derived
 * through the same honest countdown arithmetic as the number beside it. */
function timerProgress(t: CookTimer): string {
  const total = t.total || t.remaining
  if (!Number.isFinite(total) || total <= 0) return '0%'
  const pct = Math.min(100, Math.max(0, (remainingOf(t) / total) * 100))
  return `${pct.toFixed(1)}%`
}

/**
 * Derived, not trusted from the persisted `running` flag (qodo
 * 4128519641): a timer whose countdown has reached zero is finished, no
 * matter what the flag claims — its button offers Restart, not Pause.
 */
function isRunning(t: CookTimer): boolean {
  return isCounting(t, now.value)
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
  // The timer card's creation form is step-scoped too (ADR-0081 states
  // amendment): a fresh view starts COLLAPSED, never carrying the
  // previous step's open form.
  timerFormOpen.value = false
  // The checklist is per-step ephemeral (ADR-0081) — a new view starts
  // with every row unchecked.
  checkedIngredients.value = new Set()
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
 * empty list (a fact about the catalog, no authored durations), while a
 * FAILED fetch/parse also resolves to `null` (the truth is "unknown"):
 * `hintsLoaded` then stays false and the honest banner is WITHHELD — the
 * card never claims "no cook time mentioned" on a guess (ADR-0081 §4).
 */
const { hints } = useTimerHints(() => meta.value?.id)

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

/**
 * The sidecar has RESOLVED — the gate for the honest no-hint banner
 * (ADR-0081). While a fetch is in flight the card shows neither the
 * suggestion nor the banner: flashing "no cook time mentioned" before
 * the artifact lands would be exactly the dishonesty the banner exists
 * to prevent.
 */
const hintsLoaded = computed(() => hints.value !== null)

/**
 * THE one derivation of "does this step have a timer" (ADR-0081 states
 * correction — DRY, coding-philosophy priority 1): a RUNNING timer or a
 * DETECTED hint, never two code paths answering the same question. It
 * alone drives the card state, the collapsed hint line's wording, and
 * where the banner may render:
 *
 * - `running` → the card auto-expands on the running timers (countdown /
 *   progress / Pause / Cancel), the creation form collapsed behind
 *   "Set another timer";
 * - `detected` → the card opens DIRECTLY on the suggestion view (banner
 *   + one-tap add front and center, quick-start below) — the first
 *   implementation keyed this on running timers only and left a hinted
 *   step collapsed while its form said "Detected: 10 min" (preview bug);
 * - `none` → the collapsed "Set a Timer" row, whose hint line now means
 *   what it says: NOTHING is known or running for this step.
 */
const timerPresence = computed<'running' | 'detected' | 'none'>(() => {
  if (timers.value.length > 0) return 'running'
  if (suggestion.value) return 'detected'
  return 'none'
})

/**
 * The creation form is visible when the cook explicitly opened it OR the
 * predicate auto-opened it on a detected hint (states correction rule 2:
 * auto-expand on detection — the one sanctioned non-explicit opening).
 */
const timerFormVisible = computed(
  () => timerFormOpen.value || timerPresence.value === 'detected',
)

/**
 * One-tap add of the step's detected duration (ADR-0081): the TAP is
 * the confirm — nothing a parser found ever starts counting on its own
 * (ADR-0041 §4). At the concurrent cap the ask is held in `pendingArm`
 * for the replace prompt, the same as every other arm.
 */
function armSuggestion() {
  const s = suggestion.value
  if (!s || !meta.value) return
  unlockTimerAlertAudio()
  if (ui.addTimer(meta.value.id, s.label, s.minutes * 60) === null) {
    pendingArm.value = { label: s.label, seconds: s.minutes * 60 }
    return
  }
  // AFTER the store mutation: the host's scan must SEE the armed timer to
  // keep the 1 s completion loop alive (an arm-time call before addTimer
  // scans an empty map and never starts the interval).
  ensureTimerAlertPolling()
  pendingArm.value = null
  nameInput.value = ''
  minutesInput.value = ''
  // A timer now exists: the card auto-expands to the RUNNING view and
  // the creation form collapses back behind "Set another timer"
  // (ADR-0081 states amendment).
  timerFormOpen.value = false
}

const nameInput = ref('')
const minutesInput = ref('')
/**
 * A 5th timer asks which chip to give up rather than widening the strip.
 * The refused value is HELD here (seconds + the label the user typed), so
 * the replacement arms exactly what the tap asked for instead of making
 * the user re-enter it.
 */
const pendingArm = ref<{ label: string; seconds: number } | null>(null)

/**
 * The timer card's creation-form disclosure (ADR-0081 states amendment):
 * COLLAPSED by default in BOTH card states — expanding it is ALWAYS an
 * explicit tap ("Set a Timer" when the step has none, "Set another timer"
 * once one runs); the card never opens the form unprompted. Step-scoped
 * like the draft fields, so a form never follows the cook between steps.
 */
const timerFormOpen = ref(false)

/** Minutes the confirm button would arm right now (0 = nothing to arm). */
const pendingMinutes = computed(() => {
  const raw = Number(minutesInput.value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, MAX_TIMER_SECONDS / 60)
})


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
function arm(seconds: number, replacingId?: number, labelOverride?: string): boolean {
  if (!meta.value) return false
  // The arm is the user gesture: create/resume the AudioContext here so
  // the completion chime is allowed to play later (ADR-0081 amendment).
  unlockTimerAlertAudio()
  // Precedence is explicit: an override (replace flows) wins; otherwise the
  // typed name, then the suggestion's label (an accepted suggestion arms
  // with its own name), never an invented one.
  const label =
    labelOverride ?? (nameInput.value.trim() || suggestion.value?.label || '')
  if (replacingId !== undefined) ui.replaceTimer(meta.value.id, replacingId, label, seconds)
  else if (ui.addTimer(meta.value.id, label, seconds) === null) {
    pendingArm.value = { label, seconds }
    return false
  }
  // AFTER the store mutation (see armSuggestion): the host's scan must SEE
  // the armed timer to keep the 1 s completion loop alive.
  ensureTimerAlertPolling()
  pendingArm.value = null
  nameInput.value = ''
  minutesInput.value = ''
  // Same states-amendment rule as armSuggestion: armed = running view,
  // form collapsed.
  timerFormOpen.value = false
  return true
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

/**
 * Completion detection moved to the DEVICE-LEVEL host
 * (`src/lib/timerAlertHost.ts`): a timer that reaches zero alerts per the
 * settings even when the cook has left this route, keyed per recipe+timer
 * so ids cannot collide across recipes, and a timer already expired when
 * the app opened never re-alerts. The gesture unlocks (arm / suggestion /
 * restart, above) are what allow the chime channel.
 */

/** One tap pause / resume (or restart once the countdown hit zero). */
function toggle(t: CookTimer) {
  if (!meta.value) return
  if (isRunning(t)) ui.pauseTimer(meta.value.id, t.id, remainingOf(t))
  else {
    // Restarting is ALSO a user gesture: unlock the audio here so a
    // restarted timer's completion can chime (qodo round 1). The store
    // resumes from the timer's own frozen value (no seconds override),
    // which preserves the ARM's total for the progress bar. The host is
    // re-engaged AFTER startTimer for the same ordering reason as arm().
    unlockTimerAlertAudio()
    ui.startTimer(meta.value.id, t.id)
    ensureTimerAlertPolling()
  }
}

/** Spoken form for one chip's polite live region (minute ticks only). */
function announce(t: CookTimer): string {
  return announceCountdown(remainingOf(t))
}

function clear(t: CookTimer) {
  if (!meta.value) return
  ui.clearTimer(meta.value.id, t.id)
}

/** Which chip the user gave up from the at-cap prompt. The HELD label
 * replaces the chip — never the (possibly retyped) field draft. */
function replaceWith(id: number) {
  const held = pendingArm.value
  if (!held) return
  arm(held.seconds, id, held.label)
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
  <!-- Slim header (ADR-0081): title truncate + mono progress line on the
  left, close on the right, thin tomato progress bar under both. -->
  <header class="border-b border-border">
  <div class="mx-auto flex max-w-reading items-center justify-between gap-3 px-4 pt-3 pb-2">
  <div class="min-w-0 flex-1">
  <p class="truncate text-sm font-bold tracking-tight">{{ meta.name }}</p>
  <p
  class="mt-0.5 font-mono-data text-xs tabular-nums text-text-muted"
  aria-live="polite"
  data-test="cook-serves"
  >
  serves {{ servings }} ·
  <span class="font-semibold text-text" data-test="step-counter">{{ counterLabel }}</span>
  </p>
  </div>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
  data-test="cook-close"
  aria-label="Close cooking mode"
  @click="confirmTimerBeforeLeaving() && close()"
  >
  <X :size="20" aria-hidden="true" />
  </button>
  </div>
  <!-- The thin tomato bar: progress is a LINE, not a meter. -->
  <div class="mx-auto h-[3px] max-w-reading bg-border/60" data-test="cook-progress">
  <div
  class="h-full bg-brand transition-all"
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
  class="text-cooking-step lg:text-cooking-step-lg"
  :data-test="vs.partner ? 'step-partner-text' : 'step-text'"
  >
  {{ vs.step.primary }}
  </p>
  <ul v-if="vs.step.details.length" class="space-y-2">
  <li
  v-for="(d, j) in vs.step.details"
  :key="j"
  class="flex items-start gap-3 rounded-xl p-3 text-sm ring-1 ring-border"
  >
  <span
  class="mt-0.5 size-5 shrink-0 rounded border-2"
  aria-hidden="true"
  ></span>
  <span class="leading-relaxed">{{ d }}</span>
  </li>
  </ul>
  </template>

  <!-- The card row: the checklist and (ADR-0081) the step's timer card
  side by side at desktop, stacked on a phone — inside the 672px
  measure, never wider than it (ADR-0073). -->
  <div class="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
  <!-- "This step uses" (ADR-0081): the ADR-0022 measured amounts as an
  interactive checklist. The DERIVATION is unchanged — same
  `measuredAmounts.ts` source, same nameKey matching, same
  no-invented-quantity rule — only the presentation moved from the
  collapsed chip to a full-row checkbox. Checked state is EPHEMERAL
  per-step view state: the chips were never persisted. -->
  <section
  v-if="checklistRows.length"
  class="rounded-xl border border-border bg-surface-raised p-4"
  data-test="measured-amounts"
  aria-label="This step uses"
  >
  <div class="flex items-center justify-between pb-1">
  <h2 class="text-[13px] font-bold tracking-wider text-text uppercase">This step uses</h2>
  <span class="font-mono-data text-[11px] text-text-muted" data-test="measured-count">
  {{ checklistRows.length }} {{ checklistRows.length === 1 ? 'ingredient' : 'ingredients' }}
  </span>
  </div>
  <ul class="overflow-hidden rounded-lg border border-border bg-surface">
  <li
  v-for="(row, idx) in checklistRows"
  :key="row.key"
  :class="idx > 0 ? 'border-t border-border/80' : ''"
  data-test="measured-chip"
  >
  <label class="flex min-h-14 cursor-pointer items-center gap-3 px-3.5 py-2 select-none">
  <input
  type="checkbox"
  class="sr-only"
  :checked="isChecked(row.key)"
  :aria-label="`Mark ${row.chip.ingredient} as used`"
  data-test="measured-check"
  @change="toggleChecked(row.key)"
  />
  <!-- 20px rounded checkbox; checked = the SUCCESS family
  (ADR-0072: completion is never a food hue on a checkbox). -->
  <span
  class="flex size-5 shrink-0 items-center justify-center rounded-[5px] border transition-colors"
  :class="
  isChecked(row.key)
  ? 'border-success bg-success'
  : 'border-border-strong bg-surface-raised'
  "
  aria-hidden="true"
  >
  <Check v-if="isChecked(row.key)" :size="14" aria-hidden="true" class="text-on-success" />
  </span>
  <!-- Bold mono amount beside the name; checked strikes BOTH
  through and mutes them. -->
  <span
  class="font-mono-data text-[15px] font-bold tabular-nums"
  :class="isChecked(row.key) ? 'text-text-muted line-through' : 'text-text'"
  >{{ row.chip.quantity }}</span
  >
  <span
  class="min-w-0 flex-1 text-[15px] leading-snug"
  :class="isChecked(row.key) ? 'text-text-muted line-through' : 'text-text'"
  >{{ row.chip.ingredient }}</span
  >
  </label>
  </li>
  </ul>
  </section>

  <!-- "Timers for this step" (ADR-0081 + states amendment): a TWO-STATE
  disclosure. ADR-0020's state semantics are untouched — one
  timer per step VIEW, `{remaining, running, startedAt}`, countdown
  derived from `startedAt`, polite live region, never the toast. The
  SUGGESTION row is honest (ADR-0081 decision 4): a detected duration
  is offered with a one-tap add; its absence is SAID, never faked with
  presets dressed up as detections. -->
  <section
  class="rounded-xl border border-border bg-surface-raised p-4"
  data-test="timer-card"
  aria-label="Timers for this step"
  >
  <!-- RUNNING state (ADR-0081 states amendment, via the ONE presence
  predicate): when a timer runs the card auto-expands and the running
  timers are the dominant content — large mono tomato countdown, name,
  slim progress bar, Pause (tonal) + Cancel (outlined). Timers are
  recipe-scoped named chips (ADR-0041), so the card shows the same armed
  set the global strip carries, in the richer per-step presentation. -->
  <template v-if="timerPresence === 'running'">
  <h2 class="text-[13px] font-bold tracking-wider text-text uppercase">Timers for this step</h2>
  <ul class="flex flex-col gap-2 pt-3" data-test="card-timers">
  <li
  v-for="t in timers"
  :key="t.id"
  class="rounded-xl border border-border bg-surface p-3"
  :data-test="`card-timer-${t.id}`"
  >
  <div class="flex items-center justify-between gap-3">
  <span class="min-w-0 truncate text-sm font-semibold" data-test="card-timer-name">{{ t.label }}</span>
  <span
  class="shrink-0 font-mono-data text-2xl font-bold tabular-nums text-brand"
  data-test="card-timer-count"
  :aria-label="`${t.label} timer, ${formatCountdown(remainingOf(t))} left`"
  >{{ formatCountdown(remainingOf(t)) }}</span
  >
  </div>
  <div class="mt-2 h-1 overflow-hidden rounded-full bg-border/60">
  <div
  class="h-full rounded-full bg-brand transition-[width] duration-500"
  :style="{ width: timerProgress(t) }"
  ></div>
  </div>
  <div class="mt-2.5 flex items-center gap-2">
  <button
  class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface-sunken text-sm font-semibold text-text transition-colors hover:bg-border/40"
  :data-test="`card-timer-toggle-${t.id}`"
  :aria-label="
  isRunning(t)
  ? `Pause the ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  : `Start the ${t.label} timer, ${formatCountdown(remainingOf(t))} left`
  "
  @click="toggle(t)"
  >
  <Pause v-if="isRunning(t)" :size="15" aria-hidden="true" />
  <Play v-else :size="15" aria-hidden="true" />
  {{ isRunning(t) ? 'Pause' : remainingOf(t) > 0 ? 'Resume' : 'Restart' }}
  </button>
  <button
  class="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-surface-raised text-sm font-semibold text-text transition-colors hover:bg-surface-sunken"
  :data-test="`card-timer-cancel-${t.id}`"
  :aria-label="`Cancel the ${t.label} timer`"
  @click="clear(t)"
  >
  <X :size="15" aria-hidden="true" />
  Cancel
  </button>
  </div>
  </li>
  </ul>
  </template>

  <!-- The disclosure row — rendered only when NOTHING is known or
  running (collapsed "Set a Timer") or a timer runs ("Set another
  timer"). A DETECTED hint renders neither: the correction opens the
  card directly on the suggestion view instead — a row above the banner
  would re-introduce the collapsed-vs-detected contradiction. -->
  <button
  v-if="timerPresence !== 'detected'"
  type="button"
  class="flex min-h-[56px] w-full items-center justify-between gap-3 text-left"
  :class="timers.length ? 'mt-3 border-t border-border pt-3' : ''"
  data-test="timer-disclose"
  :aria-expanded="timerFormOpen"
  aria-controls="timer-create-form"
  @click="timerFormOpen = !timerFormOpen"
  >
  <span class="flex min-w-0 flex-col">
  <span class="text-[16px] font-semibold text-text">{{
  timers.length ? 'Set another timer' : 'Set a Timer'
  }}</span>
  <span v-if="!timers.length" class="mt-0.5 text-[12px] text-text-muted">
  No timer running for this step.
  </span>
  </span>
  <span class="flex shrink-0 items-center gap-1 text-text-muted">
  <Plus :size="20" aria-hidden="true" />
  <ChevronDown
  :size="20"
  aria-hidden="true"
  class="transition-transform"
  :class="timerFormOpen ? 'rotate-180' : ''"
  />
  </span>
  </button>

  <!-- The creation form — visible when the cook explicitly opened it
  ("Set a Timer" / "Set another timer") OR the presence predicate
  auto-opened it on a DETECTED hint (states correction rule 2). The
  suggestion banner's honesty rule (ADR-0081 decision 4) applies while
  the form is visible; the saffron rows never render over a running
  timer's auto-expanded view. -->
  <div
  v-if="timerFormVisible"
  id="timer-create-form"
  class="flex flex-col gap-3 pt-3"
  :class="timerPresence !== 'detected' ? 'border-t border-border' : ''"
  data-test="timer-create-form"
  >
  <!-- The honest suggestion row: saffron tint (the timers/heat/tips
  family, ADR-0067), copy in ink — saffron is a graphic colour, never
  13px prose. -->
  <div
  v-if="suggestion"
  class="flex items-center justify-between gap-3 rounded-lg border border-saffron/30 bg-saffron/8 p-3"
  data-test="timer-suggest-row"
  >
  <div class="flex min-w-0 items-start gap-2.5">
  <Clock :size="16" aria-hidden="true" class="mt-0.5 shrink-0 text-saffron" />
  <p class="text-[13px] leading-snug text-text" data-test="timer-suggest-copy">
  Detected: {{ suggestion.minutes }} min — {{ suggestion.label }}
  </p>
  </div>
  <button
  class="shrink-0 rounded-md border border-saffron/40 bg-popover/70 px-2.5 py-1.5 text-[12px] font-semibold text-brand-text transition-colors hover:bg-popover"
  data-test="timer-suggest"
  :aria-label="`Start the ${suggestion.minutes} minute ${suggestion.label} timer this step suggests`"
  @click="armSuggestion"
  >
  Add timer
  </button>
  </div>
  <!-- No hint for this step: SAY so. Shown only once the sidecar has
  resolved, so a slow fetch never flashes a false "none detected". -->
  <div
  v-else-if="hintsLoaded"
  class="flex items-start gap-2.5 rounded-lg border border-saffron/30 bg-saffron/8 p-3"
  data-test="timer-no-hint"
  >
  <Clock :size="16" aria-hidden="true" class="mt-0.5 shrink-0 text-saffron" />
  <p class="text-[13px] leading-snug text-text">
  No cook time mentioned in this step — set one if needed.
  </p>
  </div>

  <!-- Quick-start presets (44px+ pills, mono digits). Labelled a
  quick-start affordance, never a detection — a preset is the cook's
  own choice (ADR-0081 decision 4). -->
  <div class="flex flex-col gap-2">
  <span class="text-[12px] font-medium text-text-muted" id="timer-quick-start-label">Quick start</span>
  <div
  class="grid grid-cols-3 gap-2"
  data-test="timer-presets"
  role="group"
  aria-labelledby="timer-quick-start-label"
  >
  <button
  v-for="m in TIMER_PRESETS_MIN"
  :key="m"
  class="flex h-11 items-center justify-center rounded-full border border-border bg-surface font-mono-data text-[13px] font-semibold tabular-nums transition-colors hover:border-border-strong"
  :data-test="`timer-preset-${m}`"
  :aria-label="`Quick-start a ${m} minute timer`"
  @click="armPreset(m)"
  >
  + {{ m }} min
  </button>
  <!-- The recipe's own total cooking time, offered on the FIRST view
  only, labelled as the RECIPE TOTAL — never as this step's time. -->
  <button
  v-if="recipeTotalSuggestion"
  class="flex h-11 items-center justify-center gap-1 rounded-full border border-dashed border-border-strong bg-surface font-mono-data text-[13px] font-semibold tabular-nums transition-colors"
  data-test="timer-preset-recipe"
  :aria-label="`Start a timer for the recipe total cooking time of ${recipeTotalSuggestion} minutes`"
  @click="armPreset(recipeTotalSuggestion)"
  >
  <Ellipsis :size="14" aria-hidden="true" />
  {{ recipeTotalSuggestion }} min total
  </button>
  </div>
  </div>

  <!-- Full-width name field on its own row — never truncated again
  (ADR-0081 decision 3c). -->
  <div class="flex flex-col gap-1">
  <label class="text-[12px] font-medium text-text-muted" for="timer-name-input">
  Timer label (optional)
  </label>
  <input
  id="timer-name-input"
  v-model="nameInput"
  type="text"
  :maxlength="MAX_TIMER_LABEL"
  placeholder="Name (e.g. Rice)"
  class="field h-11 w-full px-3.5"
  data-test="timer-name"
  />
  </div>

  <!-- Minutes input + the filled-tomato Start timer on one row. -->
  <div class="flex items-center gap-2">
  <label class="sr-only" for="timer-minutes-input">Timer minutes</label>
  <div class="relative w-28 shrink-0">
  <input
  id="timer-minutes-input"
  v-model="minutesInput"
  type="number"
  inputmode="numeric"
  min="1"
  :max="MAX_TIMER_SECONDS / 60"
  placeholder="00"
  class="field h-11 w-full px-3.5 pr-10 text-center font-mono-data tabular-nums"
  data-test="timer-minutes"
  />
  <span
  class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono-data text-[12px] text-text-muted"
  >min</span
  >
  </div>
  <button
  class="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong disabled:opacity-50"
  :disabled="pendingMinutes <= 0"
  data-test="timer-confirm"
  :aria-label="`Start the ${nameInput || 'step'} timer for ${pendingMinutes} minutes`"
  @click="confirmArm"
  >
  <Play :size="16" aria-hidden="true" />
  Start timer
  </button>
  </div>

  <!-- At the concurrent cap (ADR-0041 §2): the card asks which chip to
  give up rather than widening the strip. INLINE "Replace N?" chips —
  no panel, one tap still swaps, and the refused label/seconds are held
  in `pendingArm` so the replacement arms exactly what was asked for.
  No timer is ever dropped without an explicit choice. -->
  <div
  v-if="pendingArm"
  class="flex flex-wrap items-center gap-2 rounded-xl border border-border-strong px-2 py-1 text-xs"
  data-test="timer-replace-prompt"
  >
  <span>Four timers is the limit. Replace which one?</span>
  <button
  v-for="t in timers"
  :key="t.id"
  class="h-11 rounded-lg border border-border-strong px-2 font-mono-data text-xs font-medium"
  :data-test="`timer-replace-${t.id}`"
  :aria-label="`Replace the ${t.label} timer`"
  @click="replaceWith(t.id)"
  >
  {{ t.label }}
  </button>
  </div>
  </div>
  </section>
  </div>
  </div>
  </div>

  <!-- Global timer strip (ADR-0041), reduced by ADR-0081 to its
  RUNNING-timers role: one chip per armed timer, visible from EVERY
  step view. The per-step ADD affordance moved into the step's timer
  card — the countdown ENGINE never changed (ADR-0020), and a cook
  juggling an oven and a pot of rice still sees both countdowns at
  once. The strip exists only while something is armed. -->
  <div
  v-if="doc && timers.length"
  class="border-t border-border bg-surface px-4 py-2"
  data-test="timer-strip"
  >
  <div class="mx-auto flex max-w-reading items-center gap-2">
  <!-- Armed timers: one chip each, countdowns independent. The row
  scrolls when four chips cannot fit (ADR-0041's shrink rule) rather
  than truncating a countdown. The manage button sits OUTSIDE the
  scroller so it never scrolls away with the chips. -->
  <div class="flex min-w-0 flex-1 gap-2 overflow-x-auto" data-test="timer-chips">
  <div
  v-for="t in timers"
  :key="t.id"
  class="flex shrink-0 items-center gap-1 rounded-xl border border-border-strong px-2 py-1"
  :data-test="`timer-chip-${t.id}`"
  >
  <span
  class="max-w-28 truncate text-xs font-semibold"
  data-test="chip-name"
  >{{ t.label }}</span
  >
  <button
  class="flex h-11 min-w-24 shrink-0 items-center justify-center gap-1 px-1 font-mono-data text-xl font-semibold tabular-nums text-saffron"
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

  <!-- Manage button (ADR-0042 §5): the ONE affordance the baseline row
  did not have. The chips stay usable inline; this is how a cook SEES
  the whole set at a glance once four of them are running. -->
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong"
  data-test="timer-fab"
  aria-label="Manage timers"
  @click="manageOpen = true"
  >
  <List :size="18" aria-hidden="true" />
  </button>
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
  class="fixed inset-0 z-40 flex items-end justify-center modal-scrim"
  data-test="timer-manage-scrim"
  @click.self="manageOpen = false"
  >
  <div
  class="w-full max-w-app space-y-3 rounded-t-2xl bg-surface-raised p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
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
  class="flex items-center gap-2 rounded-xl border border-border-strong px-2 py-1"
  data-test="timer-manage-row"
  >
  <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ t.label }}</span>
  <button
  class="flex h-11 min-w-24 shrink-0 items-center justify-center gap-1 px-1 font-mono-data text-xl font-semibold tabular-nums text-text"
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

  <!-- Action deck (ADR-0081): outlined Previous + filled-tomato Next on
  one row, the tonal success "Mark as cooked" below. TOMATO = begin,
  SUCCESS = complete (ADR-0072) — the split the owner explicitly praised
  in the render. -->
  <footer class="border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
  <div class="mx-auto flex max-w-reading flex-col gap-2.5">
  <div class="flex items-center gap-2.5">
  <button
  class="flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-border-strong bg-surface-raised px-4 text-sm font-semibold transition-colors hover:bg-surface-sunken disabled:opacity-40"
  data-test="cook-previous"
  :disabled="isFirst"
  @click="prev"
  >
  <ChevronLeft :size="18" aria-hidden="true" />
  Previous
  </button>
  <button
  v-if="!isLast"
  class="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-[15px] font-bold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong"
  data-test="cook-next"
  @click="next"
  >
  Next step
  <ChevronRight :size="18" aria-hidden="true" />
  </button>
  <!-- Finish cooking is a COMPLETION, not a start intent: it fills the
  `success` family while every start intent on this surface (Start
  cooking, Next) stays tomato — ADR-0072's colour split, one filled
  intent per surface with the colours doing the distinguishing. -->
  <button
  v-else
  class="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-success px-5 text-[15px] font-semibold text-on-success transition-[background-color,transform,filter] hover:brightness-95 active:scale-[0.98]"
  data-test="finish"
  aria-label="Finish cooking and mark as cooked"
  @click="finishCooked"
  >
  Finish
  <PartyPopper :size="18" aria-hidden="true" />
  </button>
  </div>
  <!-- Mark as cooked is reachable from ANY step; on the last step
  Finish above IS the mark, so there is never a second button
  offering the same action (ADR-0034). A session records ONE
  cook: after the mid-cook mark the button reports that and
  stops inviting a second one. -->
  <button
  v-if="!isLast"
  class="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-success/25 bg-success/8 text-sm font-semibold text-success transition-colors hover:bg-success/12 disabled:opacity-60"
  data-test="mark-cooked"
  aria-label="Mark as cooked and keep cooking"
  :disabled="sessionRecorded"
  @click="markCookedEarly"
  >
  <Check :size="16" aria-hidden="true" />
  {{ sessionRecorded ? 'Marked as cooked' : 'Mark as cooked' }}
  </button>
  </div>
  </footer>
  </div>
</template>
