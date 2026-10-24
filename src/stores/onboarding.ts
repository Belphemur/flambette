/**
 * Getting-started onboarding tour (ADR-0097).
 *
 * Device-local, personal state — never household-synced (same reasoning as
 * ADR-0037's device-local timer alerts and ADR-0081's pillDismissedRecipes).
 * Persisted under `mealime-planner:v1:onboarding`, but only the durable
 * parts survive a reload: `completedSteps`, `dismissedForever`, and `rewards`.
 * `active` and `currentStep` are session-scoped — a page refresh dismisses
 * the overlay mid-tour while keeping the stamps, so the next `start()`
 * rewinds to the first incomplete step rather than restarting from zero.
 */
import { defineStore } from 'pinia'

/** The five collectible stamps, one per tour step (ADR-0097 §4). */
export type StampName = 'first-taste' | 'sharp-eye' | 'curious-cook' | 'planner' | 'provisioner'

/** One step in the onboarding tour. */
export interface OnboardingStep {
  /** Machine key — the canonical identifier for this step. */
  key: string
  /** The stamp earned when this step is completed via a real interaction. */
  stamp: StampName | null
  /** `data-test` selector to spotlight — `null` for full-screen cards. */
  target: string | null
  /** The route the target lives on, for auto-navigation. */
  route: string | null
  /** Step heading. */
  title: string
  /** Step body text. */
  body: string
  /** One-line hint shown when the target is not yet visible. */
  hint: string
}

/** The full step table: Welcome → Search → Open → Plan → Groceries → Complete. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: 'welcome',
    stamp: 'first-taste',
    target: null,
    route: null,
    title: 'Welcome to Flambette',
    body: 'Your kitchen companion for planning meals from the frozen catalog. This quick tour shows you how to search, plan, and shop — all offline, all yours.',
    hint: '',
  },
  {
    key: 'search',
    stamp: 'sharp-eye',
    target: 'recipe-search-field',
    route: '/recipes',
    title: 'Search for a recipe',
    body: 'Type a recipe name or an ingredient and Flambette finds what\'s in your frozen catalog instantly — no internet required.',
    hint: '',
  },
  {
    key: 'open',
    stamp: 'curious-cook',
    target: 'recipe-detail',
    route: null,
    title: 'Open a recipe',
    body: 'Tap any recipe card to open its details — ingredients, nutrition, and the photo that made you hungry.',
    hint: 'Tap a recipe card to open its details',
  },
  {
    key: 'plan',
    stamp: 'planner',
    target: 'add-to-plan',
    route: null,
    title: 'Add it to your plan',
    body: 'Add this recipe to your unscheduled meal queue. It shows up in your Plan and drops its ingredients into your grocery list.',
    hint: '',
  },
  {
    key: 'groceries',
    stamp: 'provisioner',
    target: 'grocery-list',
    route: '/grocery',
    body: 'Your grocery list is derived from your planned meals — no double-entry, no waste. Check items off as you shop.',
    title: 'See your groceries',
    hint: '',
  },
]

/** Steps go 0–4 for the five tour steps; 5 is the completion card. */
export const COMPLETION_STEP = 5

/** Human-readable stamp labels for the journey passport. */
export const STAMP_LABELS: Record<StampName, string> = {
  'first-taste': 'First taste',
  'sharp-eye': 'Sharp eye',
  'curious-cook': 'Curious cook',
  'planner': 'Planner',
  'provisioner': 'Provisioner',
}

export interface OnboardingState {
  /** True while the overlay is mounted and showing a step card. */
  active: boolean
  /** Index into ONBOARDING_STEPS (0–4), or COMPLETION_STEP (5). */
  currentStep: number
  /** Step indices completed via a real interaction (stamps earned). */
  completedSteps: number[]
  /** Dismissed via X/Escape/Skip — never auto-restart. */
  dismissedForever: boolean
  /** Stamps earned (mirrors completedSteps; the passport reads this). */
  rewards: StampName[]
}

export const useOnboardingStore = defineStore('onboarding', {
  state: (): OnboardingState => ({
    active: false,
    currentStep: -1,
    completedSteps: [],
    dismissedForever: false,
    rewards: [],
  }),

  // Session-scoped: active + currentStep are NOT persisted. The overlay
  // mounts fresh after every load and calls start() to decide whether to
  // show — which rewinds to the first incomplete step (stamps preserved).
  // Persistent: completedSteps, dismissedForever, rewards.
  persist: {
    key: 'mealime-planner:v1:onboarding',
    pick: ['completedSteps', 'dismissedForever', 'rewards'],
  },

  getters: {
    /** True while the overlay is mounted and showing a step. */
    isActive: (state) => state.active,
    /** The current step's config, or null when inactive/completion. */
    step: (state): OnboardingStep | null => {
      if (state.currentStep < 0 || state.currentStep >= ONBOARDING_STEPS.length) return null
      return ONBOARDING_STEPS[state.currentStep]
    },
    /** The stamp that will be earned when the current step is auto-completed. */
    currentStamp: (state): StampName | null => {
      if (state.currentStep < 0 || state.currentStep >= ONBOARDING_STEPS.length) return null
      return ONBOARDING_STEPS[state.currentStep].stamp
    },
    /** True when every TOUR step (0–4) has been completed via real interaction.
     * The completion step (5) is never in completedSteps — it's reached
     * by completing step 4, not by a step-5 interaction. */
    isComplete: (state): boolean => {
      return ONBOARDING_STEPS.slice(0, COMPLETION_STEP).every((_, i) => state.completedSteps.includes(i))
    },
    /** Human-readable "Step N of 5" for the card footer. */
    stepNumber: (state): number => {
      return state.currentStep >= 0 ? state.currentStep + 1 : 0
    },
  },

  actions: {
    /** Begin the tour — called from App.vue after the catalog resolves.
     * Rewinds to the first incomplete step (stamps preserved). No-op when
     * dismissed forever or already complete. */
    start(): void {
      if (this.dismissedForever) return
      if (this.isComplete) return
      if (this.active && this.currentStep >= 0) return
      this.active = true
      const firstIncomplete = ONBOARDING_STEPS.findIndex(
        (_, i) => !this.completedSteps.includes(i),
      )
      this.currentStep = firstIncomplete >= 0 ? firstIncomplete : 0
    },

    /** Advance to the next step (used by "Got it" / skip-ahead). Does NOT
     * earn the stamp — that only happens on a real interaction. */
    next(): void {
      if (this.currentStep < COMPLETION_STEP) {
        this.currentStep += 1
      }
    },

    /** Jump to a specific step index. */
    skipTo(step: number): void {
      this.currentStep = Math.max(0, Math.min(step, COMPLETION_STEP))
    },

    /** Mark a step complete via real interaction: earns the stamp + advances. */
    completeStep(step: number): void {
      if (this.completedSteps.includes(step)) {
        // Already done — just advance if the user is stuck on it.
        this.next()
        return
      }
      this.completedSteps.push(step)
      const stamp = ONBOARDING_STEPS[step]?.stamp
      if (stamp) this.earnStamp(stamp)
      this.next()
    },

    /** Permanently dismiss the tour (X button, Escape, or Skip tour). */
    dismiss(): void {
      this.dismissedForever = true
      this.active = false
      this.currentStep = -1
    },

    /** Restart from the beginning — clears stamps, rewinds to welcome. */
    restart(): void {
      this.dismissedForever = false
      this.completedSteps = []
      this.rewards = []
      this.active = true
      this.currentStep = 0
    },

    /** Record an earned stamp (idempotent). */
    earnStamp(stamp: StampName): void {
      if (!this.rewards.includes(stamp)) {
        this.rewards.push(stamp)
      }
    },
  },
})
