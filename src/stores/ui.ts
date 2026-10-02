import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Component } from 'vue'
import { BookOpen, CalendarDays, History, Settings, ShoppingCart } from 'lucide-vue-next'
import {
  defaultQuickFilters,
  migrateLegacyUiFilters,
  normalizeQuickFilters,
  type QuickFilters,
} from '../lib/quickFilters'
import { isRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { clampServings, FALLBACK_SERVINGS, isServings, MIN_SERVINGS } from '../lib/servings'
import {
  MAX_CONCURRENT_TIMERS,
  clampSeconds,
  isStepTimer,
  nextTimerId,
  newCookTimer,
  normalizeTimerLabel,
  type CookTimer,
} from '../lib/stepTimer'
// The offered occasions are the ONE taxonomy (ADR-0046 §2.2/2.3): the
// runtime import feeds AUTO_PLAN_RULESETS; the type comes back from the
// composable that already derives its filter union from the same source.
import { OFFERED_MEAL_TYPES } from '../lib/mealTypeFilter'
import type { AutoPlanRulesetFilter } from '../composables/useAutoPlan'

/** Bottom-nav entries, in display order. `to` is the route path; `icon` is
 *  a Lucide component (WS5), not an emoji or a hand-rolled path — the
 *  five labels keep their measured Pixel 7 fit (ADR-0016). */
export const TABS: { id: string; label: string; icon: Component; to: string }[] = [
  { id: 'recipes', label: 'Recipes', icon: BookOpen, to: '/' },
  { id: 'plan', label: 'Plan', icon: CalendarDays, to: '/plan' },
  { id: 'grocery', label: 'Grocery', icon: ShoppingCart, to: '/grocery' },
  { id: 'history', label: 'History', icon: History, to: '/history' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/settings' },
]

/** An inline button on a toast (e.g. [Clear] [Cancel]). */
export interface ToastAction {
  label: string
  run: () => void
  /** Explicit test id (default: toast-action-primary/secondary). */
  testId?: string
}

export interface Toast {
  message: string
  /** Inline buttons rendered next to the message. */
  actions?: ToastAction[]
  /** Data-test marker discriminating confirmation kinds (e.g. "added").
   *  Rendered as data-test="added-toast" so specs can target the
   *  ingredient-added confirmation, not just any toast. */
  kind?: string
}

export interface ToastOptions {
  /** Inline buttons rendered next to the message. */
  actions?: ToastAction[]
  /** Auto-dismiss delay in ms (default 2500). */
  duration?: number
  /** Confirmation kind — emits data-test="added-toast" when set. */
  kind?: string
  /**
   * Called exactly once when the toast ends, whatever the cause:
   * timeout, replacement by a newer toast, or dismissToast().
   */
  onDismiss?: () => void
}

/** Auto-Plan ruleset choices. 'any' imposes no filter.
 *
 * ADR-0046 §2.3: the union is the shared `AutoPlanRulesetFilter` (the
 * taxonomy-derived occasion rulesets + 'any') — widened to reach
 * Lunch/Snack; the persisted value keeps its shape, and a stored
 * out-of-list string never applies (applySettings leaves the 'dinner'
 * default in place). Type-only import, so no runtime cycle with the
 * composable that imports this store.
 */
export type AutoPlanRuleset = AutoPlanRulesetFilter
export type AutoPlanMode = 'add' | 'replace'
/** Valid values for the persisted setting — the offered occasions + Any,
 *  derived from the ONE taxonomy (mealTypeFilter); backup validation
 *  (backup.ts) and applySettings both gate on this list. */
export const AUTO_PLAN_RULESETS: readonly AutoPlanRuleset[] = [
  'any',
  ...OFFERED_MEAL_TYPES.map((o) => o.ruleset),
]

/**
 * UI state not owned by the router: cooking step positions (survive tab
 * switches within a session) and transient toasts. Not persisted.
 *
 * The active tab, open recipe and cooking mode are router-driven now —
 * see src/router.ts.
 */
export const useUiStore = defineStore(
  'ui',
  () => {
    /** Cooking step index, keyed by variant id (survives tab switches). */
    const cookingStepIndex = ref<Record<number, number>>({})
    /**
     * Share cooked history with the live room. ON by default
     * (ADR-0032 supersedes ADR-0011's opt-in): a household wants ONE
     * shared cooking log. The opt-out is real and permanent — a user who
     * turns it off keeps it off. Part of backups.
     */
    const shareCookedHistory = ref(true)
    /**
     * "The history-sharing default has already been applied to this
     * install" (ADR-0032).
     *
     * `shareCookedHistory` is persisted, so an install that has been
     * running the pre-ADR-0032 build carries a `false` that is
     * INDISTINGUISHABLE from "the user never touched it" — the boolean
     * alone cannot say which. This flag is the honest fix: on the first
     * launch after the upgrade the stored value is treated as unset and
     * the new default is adopted, and the flag is written immediately.
     * From then on any toggle the user makes is an explicit choice that
     * no later default change may override.
     */
    const historyShareDefaultMigrated = ref(false)
    /** Auto-Plan settings (ADR-0027): last ruleset choice + mode, and the
     *  rotating seed generation. It advances at TWO points (ADR-0033):
     *  on every successful apply, and on every Regenerate press. All
     *  persisted + carried in backups. */
    const autoPlanRuleset = ref<AutoPlanRuleset>('dinner')
    const autoPlanMode = ref<AutoPlanMode>('add')
    const autoPlanGeneration = ref(0)
    /** Generation a run should use (the stored counter). PEEKS: this
     *  must not advance, or a stale-check that re-reads it after an
     *  await would compare a run against its own seed. */
    function nextAutoPlanGeneration(): number {
      return autoPlanGeneration.value
    }
    /** Bump so the next run rotates the seed: after a successful apply,
     *  and synchronously at the start of a Regenerate press. */
    function advanceAutoPlanGeneration(): void {
      autoPlanGeneration.value += 1
    }
    /**
     * The unified quick-filter selection (ADR-0027): diet chips, protein
     * chip, cook-time bucket, sort mode and the favourites/PRO toggles in
     * ONE object. Persisted (survives a reload) and carried in the room
     * payload as optional `filters` (ADR-0028), so every household member
     * browses the same slice of the catalog.
     */
    const quickFilters = ref<QuickFilters>(defaultQuickFilters())
    /**
     * The remembered default serving size (ADR-0037) — the household's
     * usual portion count, used as the starting value for every NEW
     * recipe, Auto-Plan pack, History re-plan and unplanned cook.
     *
     * Device-local on purpose: the PLAN's servings are the household's
     * shared truth (they ride the room payload as plan entries), while a
     * default is one person's starting point. Syncing it would let a
     * phone that happens to cook for eight re-open a recipe another member
     * had deliberately set to four.
     *
     * Starts at the authored `serving_count` (6) so an install that never
     * touches the control behaves exactly as before.
     */
    const defaultServings = ref<number>(FALLBACK_SERVINGS)
    /** Persistent household room code the app auto-joins on start (ADR-0019). */
    const householdRoom = ref('')
    /**
     * Cooking-view step timers (ADR-0020): variant id -> step-VIEW leader
     * index -> timer. Keyed by view (not raw step) because a "Meanwhile"
     * pair is one view and shares one timer. Persisted so a reload
     * mid-cook resumes an honest countdown (remaining + startedAt).
     *
     * ADR-0041: the inner key is a TIMER ID, not a step-view index, and
     * each value is a named `CookTimer`, so one cook can run several
     * countdowns at once from the single global strip. Same persisted
     * slice as before — the backup registry (ADR-0013) needs no new one.
     */
    const stepTimers = ref<Record<number, Record<number, CookTimer>>>({})
    /** Transient toast: plain message, optionally with inline action buttons. */
    const toast = ref<Toast | null>(null)
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    /** Dismissal callback of the toast currently on screen. */
    let onDismiss: (() => void) | undefined

    function setCookingStep(variantId: number, step: number) {
      cookingStepIndex.value[variantId] = step
    }

    function cookingStep(variantId: number): number {
      return cookingStepIndex.value[variantId] ?? 0
    }

    /** Every armed timer of a recipe, oldest id first (ADR-0041). */
    function timers(variantId: number): CookTimer[] {
      const forRecipe = stepTimers.value[variantId]
      if (!forRecipe) return []
      return Object.values(forRecipe).sort((a, b) => a.id - b.id)
    }

    /** One armed timer by id, or undefined when it was cleared. */
    function timerById(variantId: number, id: number): CookTimer | undefined {
      return stepTimers.value[variantId]?.[id]
    }

    /** True when another timer would exceed `MAX_CONCURRENT_TIMERS`. */
    function isTimerListFull(variantId: number): boolean {
      return timers(variantId).length >= MAX_CONCURRENT_TIMERS
    }

    /**
     * Arm a NEW timer for a recipe and return its id, or null when the
     * concurrent cap is already reached — the caller then asks which
     * timer to replace (ADR-0041 §2). A running timer stamps `startedAt`
     * here, once, so nothing downstream re-arms a countdown.
     */
    function addTimer(variantId: number, label: string, seconds: number, running = true): number | null {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      if (Object.keys(forRecipe).length >= MAX_CONCURRENT_TIMERS) return null
      const id = nextTimerId(forRecipe)
      forRecipe[id] = newCookTimer(id, label, seconds, running, running ? Date.now() : null)
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
      return id
    }

    /** Swap a timer that is already on the strip for a new value. */
    function replaceTimer(variantId: number, id: number, label: string, seconds: number): void {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      if (!(id in forRecipe)) return
      forRecipe[id] = newCookTimer(id, label, seconds, true, Date.now())
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
    }

    /**
     * Start (or restart) one timer. `seconds` defaults to the timer's own
     * remaining value, so a paused timer resumes where it stopped.
     */
    function startTimer(variantId: number, id: number, seconds?: number): void {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      const existing = forRecipe[id]
      if (!existing) return
      const base = seconds === undefined ? existing.remaining : seconds
      forRecipe[id] = newCookTimer(id, existing.label, base || 300, true, Date.now())
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
    }

    /** Pause one timer, freezing the remaining seconds it had. */
    function pauseTimer(variantId: number, id: number, remaining: number): void {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      const existing = forRecipe[id]
      if (!existing) return
      forRecipe[id] = {
        ...existing,
        remaining: clampSeconds(remaining),
        running: false,
        startedAt: null,
      }
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
    }

    /** Rename one timer in place (the chip's label field). */
    function renameTimer(variantId: number, id: number, label: string): void {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      const existing = forRecipe[id]
      if (!existing) return
      forRecipe[id] = { ...existing, label: normalizeTimerLabel(label) }
      stepTimers.value = { ...stepTimers.value, [variantId]: forRecipe }
    }

    /** Drop one timer entirely (a chip's delete). */
    function clearTimer(variantId: number, id: number): void {
      const forRecipe = { ...(stepTimers.value[variantId] ?? {}) }
      if (!(id in forRecipe)) return
      delete forRecipe[id]
      const next = { ...stepTimers.value }
      if (Object.keys(forRecipe).length === 0) delete next[variantId]
      else next[variantId] = forRecipe
      stepTimers.value = next
    }

    /**
     * Replace persisted ui prefs wholesale (backup import).
     *
     * `quickFilters` accepts the whole unified object; a LEGACY
     * `dietFilters` array (backup written before ADR-0027) is still
     * accepted and folded into the diets half, so an old backup restores
     * the user's diet chips instead of silently dropping them.
     */
    function applySettings(prefs: {
      shareCookedHistory?: boolean
      quickFilters?: unknown
      dietFilters?: unknown
      householdRoom?: string
      stepTimers?: unknown
      autoPlanRuleset?: unknown
      autoPlanMode?: unknown
      autoPlanGeneration?: unknown
      defaultServings?: unknown
    }): void {
      if (typeof prefs.shareCookedHistory === 'boolean') {
        shareCookedHistory.value = prefs.shareCookedHistory
        // A restore that carries the value is an EXPLICIT choice (the
        // dialog says settings are overwritten): the one-time default
        // migration must not re-apply over it on the next launch.
        historyShareDefaultMigrated.value = true
      }
      if (
        typeof prefs.autoPlanRuleset === 'string' &&
        (AUTO_PLAN_RULESETS as readonly string[]).includes(prefs.autoPlanRuleset)
      ) {
        autoPlanRuleset.value = prefs.autoPlanRuleset as AutoPlanRuleset
      }
      if (
        (prefs.autoPlanMode === 'add' || prefs.autoPlanMode === 'replace')
      ) {
        autoPlanMode.value = prefs.autoPlanMode
      }
      if (typeof prefs.autoPlanGeneration === 'number' && Number.isFinite(prefs.autoPlanGeneration) && prefs.autoPlanGeneration >= 0) {
        autoPlanGeneration.value = Math.floor(prefs.autoPlanGeneration)
      }
      const filters =
        normalizeQuickFilters(prefs.quickFilters) ??
        (Array.isArray(prefs.quickFilters)
          ? normalizeQuickFilters({ diets: prefs.quickFilters })
          : null) ??
        (Array.isArray(prefs.dietFilters) ? normalizeQuickFilters({ diets: prefs.dietFilters }) : null)
      if (filters) quickFilters.value = filters
      if (typeof prefs.householdRoom === 'string') setHouseholdRoom(prefs.householdRoom)
      if (prefs.stepTimers !== undefined) stepTimers.value = sanitizeStepTimers(prefs.stepTimers)
      // A backup written before ADR-0037 has no key at all: that means
      // "don't touch", so the device keeps the default it already had. A
      // value that IS present is normalized by `setDefaultServings`, which
      // CLAMPS an out-of-range count to MAX_SERVINGS and IGNORES a
      // non-finite or below-floor one (leaving the current value) rather
      // than storing a 0 that would re-scope every future recipe to one
      // portion. A backup carrying a malformed value is rejected upstream by
      // the slice validator, so this path only ever sees a count or nothing.
      if (prefs.defaultServings !== undefined) {
        setDefaultServings(prefs.defaultServings as number)
      }
    }

    /**
     * Seed the unified filters from state persisted before ADR-0027 (a
     * v0.12 localStorage blob holds `dietFilters` and no `quickFilters`),
     * and repair anything the hydrated value got wrong.
     *
     * Runs once, after persistence hydration. Hydration is a raw
     * `$patch` of whatever was in localStorage, so a hand-edited,
     * half-written or older-build value reaches the store verbatim;
     * without this the Recipes tab would read a malformed `diets` array
     * and could fail while iterating it. A non-object (or a legacy
     * `dietFilters` array) falls back to the migration, then to defaults.
     */
    function migrateLegacyFilters(): void {
      let raw: string | null = null
      try {
        raw = localStorage.getItem('mealime-planner:v1:ui')
      } catch {
        return // storage unavailable: nothing to migrate
      }
      const migrated = migrateLegacyUiFilters(raw)
      if (migrated) {
        quickFilters.value = migrated
        return
      }
      const normalized = normalizeQuickFilters(quickFilters.value)
      if (normalized) quickFilters.value = normalized
      else quickFilters.value = defaultQuickFilters()
    }

    /**
     * Apply the ADR-0032 default (sharing ON) to a pre-ADR-0032 install,
     * and mark EVERY install as migrated so the default can never re-run.
     *
     * Called from `afterHydrate`: at that point the persisted blob has loaded,
     * so we can inspect what actually landed. Two cases:
     *
     * - **Pre-ADR-0032 install**: the blob carries `shareCookedHistory: false`
     *   (the old default) and NO `historyShareDefaultMigrated` flag. We adopt
     *   ON — the owner ruled that a silent `false` is not a user choice.
     *
     * - **Fresh install**: nothing has been toggled, so the persisted blob has
     *   NEITHER key. We leave `shareCookedHistory` at its in-memory default
     *   (`true` from the `ref(true)`) untouched — there is no `false` to
     *   override — and mark migrated so a later opt-OUT is honoured.
     *
     * That split is the whole fix for the bug where a fresh install that
     * opted out before the first reload re-awakened sharing on the next
     * hydrate: the old version ran the default unconditionally whenever
     * `migrated` was false, and a fresh install looks identical to a legacy
     * blob at that point.
     */
    function adoptHistoryShareDefault(): void {
      if (historyShareDefaultMigrated.value) return

      let hasLegacyBlob = false
      try {
        const raw = localStorage.getItem('mealime-planner:v1:ui')
        if (raw) {
          const blob = JSON.parse(raw) as Record<string, unknown>
          hasLegacyBlob =
            Object.prototype.hasOwnProperty.call(blob, 'shareCookedHistory') &&
            !Object.prototype.hasOwnProperty.call(blob, 'historyShareDefaultMigrated')
        }
      } catch {
        hasLegacyBlob = true // unreadable blob: adopt the default once
      }

      if (hasLegacyBlob) shareCookedHistory.value = true
      historyShareDefaultMigrated.value = true
    }

    /**
     * Repair a hydrated `defaultServings` (ADR-0037).
     *
     * Persistence hydration is a raw `$patch` of whatever localStorage
     * held, so a hand-edited, truncated or older-build value lands in the
     * ref verbatim. That value multiplies into every recipe's scale
     * factor, so unlike a UI label a bad one is arithmetic: `0` would
     * collapse a recipe, `1e9` would render unusable quantities. Anything
     * that is not a usable count is replaced by the authored fallback.
     */
    function repairDefaultServings(): void {
      if (isServings(defaultServings.value)) return
      defaultServings.value = FALLBACK_SERVINGS
    }

    /**
     * Keep only well-formed timers out of an imported/loaded map
     * (validation-first import: unknown shapes are dropped, not trusted).
     *
     * This is also where ADR-0041's persistence migration lives: a
     * pre-ADR-0041 record — `{ remaining, running, startedAt }` under a
     * step-VIEW index, with no label — is a perfectly good countdown, so
     * it is adopted as one timer keyed by that same id and labelled
     * "Step". User data is never dropped for the rename; only a record
     * that is not a countdown at all is discarded.
     */
    function sanitizeStepTimers(value: unknown): Record<number, Record<number, CookTimer>> {
      const out: Record<number, Record<number, CookTimer>> = {}
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
      for (const [variantRaw, viewsRaw] of Object.entries(value as Record<string, unknown>)) {
        if (!/^\d+$/.test(variantRaw)) continue
        if (typeof viewsRaw !== 'object' || viewsRaw === null || Array.isArray(viewsRaw)) continue
        const timers: Record<number, CookTimer> = {}
        for (const [idRaw, timer] of Object.entries(viewsRaw as Record<string, unknown>)) {
          if (!/^\d+$/.test(idRaw) || !isStepTimer(timer)) continue
          const id = Number(idRaw)
          timers[id] = {
            id,
            label: normalizeTimerLabel((timer as CookTimer).label),
            remaining: clampSeconds(timer.remaining),
            running: timer.running,
            startedAt: timer.startedAt === null ? null : timer.startedAt,
          }
        }
        if (Object.keys(timers).length > 0) out[Number(variantRaw)] = timers
      }
      return out
    }

    /**
     * Persist (or clear) the household room code (ADR-0021).
     *
     * Input is normalized to canonical form — three hyphenated lowercase
     * words (`amber-falcon-lantern`) or a legacy 4–12 char uppercase
     * alphanumeric code, both still accepted (ADR-0019 households).
     * Anything else clears the setting rather than storing a code that
     * can never join.
     */
    function setHouseholdRoom(code: string) {
      const normalized = normalizeRoomCode(code)
      householdRoom.value = isRoomCode(normalized) ? normalized : ''
    }

    /**
     * Remember a new default serving size (ADR-0037). Called by every
     * surface that changes servings on purpose — the recipe-detail
     * stepper, the plan-row stepper and the Settings control — so the
     * next recipe, Auto-Plan pack or re-plan starts where the user left
     * off instead of at the authored 6.
     *
     * The write is CLAMPED, never trusted: this is a persisted, hand-
     * editable value, and an out-of-range one would scale every future
     * recipe. `0` from a `servings--` at the floor keeps the current
     * value rather than resetting the default to 1.
     */
    function setDefaultServings(value: number): void {
      if (!Number.isFinite(value) || value < MIN_SERVINGS) return
      defaultServings.value = clampServings(value)
    }

    /** End the current toast (if any) and fire its onDismiss exactly once. */
    function endToast() {
      if (toastTimer) {
        clearTimeout(toastTimer)
        toastTimer = undefined
      }
      const cb = onDismiss
      onDismiss = undefined
      toast.value = null
      cb?.()
    }

    function showToast(message: string, options: ToastOptions = {}) {
      // A replacing toast ends the previous one first (its onDismiss fires).
      endToast()
      onDismiss = options.onDismiss
      toast.value = { message, actions: options.actions, kind: options.kind }
      toastTimer = setTimeout(endToast, options.duration ?? 2500)
    }

    /** Dismiss the current toast immediately (e.g. the Cancel button). */
    function dismissToast() {
      endToast()
    }

    return {
      cookingStepIndex,
      shareCookedHistory,
      historyShareDefaultMigrated,
      quickFilters,
      householdRoom,
      stepTimers,
      toast,
      autoPlanRuleset,
      autoPlanMode,
      autoPlanGeneration,
      defaultServings,
      nextAutoPlanGeneration,
      advanceAutoPlanGeneration,
      setCookingStep,
      cookingStep,
      timers,
      timerById,
      isTimerListFull,
      addTimer,
      replaceTimer,
      startTimer,
      pauseTimer,
      renameTimer,
      clearTimer,
      applySettings,
      migrateLegacyFilters,
      adoptHistoryShareDefault,
      setDefaultServings,
      repairDefaultServings,
      setHouseholdRoom,
      showToast,
      dismissToast,
    }
  },
  {
    // The quick filters (ADR-0027), the share/room prefs and the step
    // timers (ADR-0020, so a reload mid-cook resumes honestly) persist;
    // cookingStepIndex stays session-scoped.
    persist: {
      key: 'mealime-planner:v1:ui',
      pick: [
        'shareCookedHistory',
        // Not a setting: the once-only marker for ADR-0032's default
        // migration. Persisted so the migration cannot run twice on a
        // genuinely pre-ADR-0032 install. It is set to TRUE on first launch
        // of this build for EVERY install (fresh or migrated), so that a
        // fresh install that has not opted out is never mistaken for a
        // legacy blob and never has its toggle reset back to the default
        // (issue: opt-out on a fresh install was re-enabled after reload).
        'historyShareDefaultMigrated',
        'quickFilters',
        'householdRoom',
        'stepTimers',
        'autoPlanRuleset',
        'autoPlanMode',
        'autoPlanGeneration',
        // The remembered default serving size (ADR-0037): a device-local
        // preference, restored on the next launch.
        'defaultServings',
      ],
      // Hydration has already run when this fires, so a v0.12 blob (which
      // has no `quickFilters` and therefore patched nothing) can still be
      // migrated from its legacy `dietFilters` array — and a pre-ADR-0032
      // blob can still have the new history default applied to it.
      afterHydrate: (context) => {
        const store = context.store as unknown as {
          migrateLegacyFilters: () => void
          adoptHistoryShareDefault: () => void
          repairDefaultServings: () => void
        }
        store.migrateLegacyFilters()
        store.adoptHistoryShareDefault()
        store.repairDefaultServings()
      },
    },
  },
)