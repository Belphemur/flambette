<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from 'vue'
import { useRouter } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import {
  Check,
  ChevronLeft,
  Flame,
  type LucideIcon,
  Search,
  BookOpen,
  CalendarPlus,
  ShoppingBasket,
} from '@lucide/vue'
import { useUiStore } from '../stores/ui'
import {
  useOnboardingStore,
  ONBOARDING_STEPS,
  COMPLETION_STEP,
  STAMP_LABELS,
  type OnboardingStep,
  type StampName,
} from '../stores/onboarding'

const router = useRouter()
const ui = useUiStore()
const onboarding = useOnboardingStore()

/** Silence the halo pulse for motion-sensitive users (ADR-0097 §1). */
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

/** Bounding rect of the current spotlight target, or null for full-screen cards. */
const targetRect = ref<DOMRect | null>(null)

/** Whether the step card sits below the target (vs above). */
const cardBelow = ref(true)

/** Interval + interaction cleanup. */
let pollTimer: ReturnType<typeof setInterval> | null = null
let interactionCleanup: (() => void) | null = null
let autoCompleteTimer: ReturnType<typeof setTimeout> | null = null
let routeUnwatch: (() => void) | null = null

/* ---------- Step / stamp lookups ---------- */

const currentStepIdx = computed(() => onboarding.currentStep)
const stepData = computed<OnboardingStep | null>(() => onboarding.step)
const isCompletion = computed(() => onboarding.currentStep === COMPLETION_STEP)
const isSpotlight = computed(() => !!stepData.value?.target)

/** Map step key → icon component. */
const STEP_ICONS: Record<string, LucideIcon> = {
  welcome: Flame,
  search: Search,
  open: BookOpen,
  plan: CalendarPlus,
  groceries: ShoppingBasket,
}

function currentIcon(): LucideIcon {
  if (isCompletion.value) return Flame
  return STEP_ICONS[stepData.value?.key ?? 'welcome'] ?? Flame
}

/** Whether a stamp has been earned. */
function hasStamp(stamp: StampName | null): boolean {
  if (!stamp) return false
  return onboarding.rewards.includes(stamp)
}

/* ---------- Spotlight geometry ---------- */

const SCRIM_RGBA = 'rgba(23, 19, 16, 0.75)'

/** Style for the scrim "frame" — a box at the target's rect with a massive
 *  box-shadow that dims everything except the target (the hole). */
const dimFrameStyle = computed((): CSSProperties | null => {
  if (!targetRect.value) return null
  const r = targetRect.value
  return {
    position: 'fixed',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    pointerEvents: 'none',
    boxShadow: `0 0 0 2000px ${SCRIM_RGBA}`,
    zIndex: 40,
  }
})

/** Style for the tomato highlight ring around the target. */
const ringStyle = computed((): CSSProperties | null => {
  if (!targetRect.value) return null
  const r = targetRect.value
  return {
    position: 'fixed',
    top: `${r.top - 5}px`,
    left: `${r.left - 5}px`,
    width: `${r.width + 10}px`,
    height: `${r.height + 10}px`,
    pointerEvents: 'none',
    border: '2px solid var(--color-brand)',
    boxShadow: `0 0 0 8px var(--color-brand-tint)`,
    borderRadius: '12px',
    zIndex: 41,
  }
})

/** Inline style for the anchored step card (below/above the target). */
const anchoredCardStyle = computed((): CSSProperties | null => {
  if (!targetRect.value) return null
  const r = targetRect.value
  const midX = r.left + r.width / 2
  const cardW = Math.min(360, window.innerWidth - 32)
  const left = Math.max(16, midX - cardW / 2)

  if (cardBelow.value) {
    return { position: 'fixed', top: `${r.bottom + 16}px`, left: `${left}px`, width: `${cardW}px`, zIndex: 50 }
  }
  return {
    position: 'fixed',
    bottom: `${window.innerHeight - r.top + 16}px`,
    left: `${left}px`,
    width: `${cardW}px`,
    zIndex: 50,
  }
})

/* ---------- Auto-complete + navigation ---------- */

function cleanupSpotlight(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (interactionCleanup) { interactionCleanup(); interactionCleanup = null }
  if (autoCompleteTimer) { clearTimeout(autoCompleteTimer); autoCompleteTimer = null }
  if (routeUnwatch) { routeUnwatch(); routeUnwatch = null }
  targetRect.value = null
}

/** Navigate to the route that hosts a step's target, if needed. */
function navigateTargetRoute(step: OnboardingStep): void {
  if (!step.route) return
  if (router.currentRoute.value.path === step.route) return
  void router.push(step.route)
}

/** Find the target element and set up the spotlight + auto-complete. */
function findTarget(target: string, stepIdx: number): void {
  const el = document.querySelector<HTMLElement>(`[data-test="${target}"]`)
  if (!el) {
    let attempts = 0
    pollTimer = setInterval(() => {
      attempts++
      const found = document.querySelector<HTMLElement>(`[data-test="${target}"]`)
      if (found) {
        clearInterval(pollTimer!)
        pollTimer = null
        measureAndListen(stepIdx, found)
      } else if (attempts > 50) {
        clearInterval(pollTimer!)
        pollTimer = null
      }
    }, 100)
    return
  }
  measureAndListen(stepIdx, el)
}

/** Measure the target rect, position the card, and attach listeners. */
function measureAndListen(stepIdx: number, el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  targetRect.value = rect
  cardBelow.value = rect.bottom + 320 < window.innerHeight

  const step = ONBOARDING_STEPS[stepIdx]
  if (!step) return

  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (interactionCleanup) { interactionCleanup(); interactionCleanup = null }
    if (autoCompleteTimer) { clearTimeout(autoCompleteTimer); autoCompleteTimer = null }
    onboarding.completeStep(stepIdx)
  }

  switch (step.target) {
    case 'recipe-search-field':
      el.addEventListener('focus', finish, { once: true })
      el.addEventListener('input', finish, { once: true })
      interactionCleanup = () => {
        el.removeEventListener('focus', finish)
        el.removeEventListener('input', finish)
      }
      break
    case 'recipe-detail':
    case 'grocery-list':
      // The dialog / list just appeared — the real interaction is the
      // user arriving at this surface. A short grace lets them read the card.
      autoCompleteTimer = setTimeout(finish, 1000)
      break
    case 'add-to-plan':
      el.addEventListener('click', finish, { once: true })
      interactionCleanup = () => el.removeEventListener('click', finish)
      break
  }
}

/** Re-run spotlight setup whenever the active step changes. */
watch(
  () => onboarding.currentStep,
  async (stepIdx) => {
    cleanupSpotlight()
    if (stepIdx < 0 || stepIdx >= ONBOARDING_STEPS.length) return
    const step = ONBOARDING_STEPS[stepIdx]
    if (!step.target) return

    navigateTargetRoute(step)

    if (step.route && router.currentRoute.value.path !== step.route) {
      const stop = router.afterEach(() => {
        stop()
        void nextTick(() => findTarget(step.target!, stepIdx))
      })
      routeUnwatch = () => stop()
    } else {
      await nextTick()
      findTarget(step.target, stepIdx)
    }
  },
  { immediate: true, flush: 'post' },
)

/* ---------- Actions ---------- */

function dismiss(): void {
  onboarding.dismiss()
}

/** "Got it" / "I have done this — skip ahead": advance without the stamp. */
function skipAhead(): void {
  onboarding.next()
}

function goBack(): void {
  if (onboarding.currentStep > 0) {
    onboarding.skipTo(onboarding.currentStep - 1)
  }
}

const showBack = computed(() => onboarding.currentStep > 0)

onMounted(() => {
  void nextTick(() => {
    if (stepData.value?.target && onboarding.currentStep >= 0) {
      findTarget(stepData.value.target, onboarding.currentStep)
    }
  })
})

onBeforeUnmount(() => {
  cleanupSpotlight()
})
</script>

<template>
  <Teleport to="body">
    <!-- ===== Spotlight scrim: dim frame with a hole at the target ===== -->
    <div v-if="targetRect" :style="dimFrameStyle" />

    <!-- ===== Target highlight ring (halo pulse, suppressed for reduced motion) ===== -->
    <div
      v-if="targetRect"
      class="pointer-events-none fixed z-41 rounded-xl"
      :class="prefersReducedMotion ? '' : 'animate-pulse'"
      :style="ringStyle"
    />

    <!-- ===== Full-screen scrim for non-spotlight steps ===== -->
    <div
      v-if="currentStepIdx >= 0 && !targetRect"
      class="fixed inset-0 z-40 bg-espresso/75"
    />

    <!-- ===== Step card===== -->
    <div
      v-if="currentStepIdx >= 0"
      class="fixed z-50 pointer-events-auto"
      :style="isSpotlight ? anchoredCardStyle : null"
      :data-test="isCompletion ? 'onboarding-complete' : `onboarding-step-${stepData?.key}`"
    >
      <!-- Full-screen centered card (welcome / completion) -->
      <div
        v-if="isCompletion || !isSpotlight"
        class="mx-auto w-full max-w-md rounded-3xl bg-surface-raised p-8 ring-1 ring-border shadow-warm"
      >
        <!-- ===== Completion card ===== -->
        <div v-if="isCompletion" class="text-center">
          <div class="mb-6 flex justify-center">
            <Flame :size="32" class="text-brand" />
          </div>
          <h2 class="text-headline-md text-text">Your journey through Flambette</h2>
          <p class="mt-2 text-body-sm text-text-muted">
            You've collected {{ onboarding.rewards.length }} of 5 stamps.
            <template v-if="onboarding.isComplete">
              Welcome to the kitchen.
            </template>
            <template v-else>
              Keep going — every stamp earns you a tip.
            </template>
          </p>

          <!-- Journey passport stamp strip -->
          <div class="my-8 flex items-center justify-center gap-3">
            <div
              v-for="(step, i) in ONBOARDING_STEPS"
              :key="step.stamp || step.key"
              class="flex flex-col items-center gap-1"
            >
              <span
                class="flex size-10 items-center justify-center rounded-full border text-xs font-mono"
                :class="
                  hasStamp(step.stamp)
                    ? 'border-saffron bg-brand text-on-brand'
                    : 'border-border bg-surface text-text-muted'
                "
                :aria-label="hasStamp(step.stamp) ? `${STAMP_LABELS[step.stamp!]} earned` : `${STAMP_LABELS[step.stamp!]} — not yet`"
                :title="STAMP_LABELS[step.stamp!]"
              >
                <Check v-if="hasStamp(step.stamp)" :size="16" aria-hidden="true" />
                <span v-else class="text-[10px]">{{ i + 1 }}</span>
              </span>
              <span class="text-[10px] font-mono text-text-muted">
                {{ STAMP_LABELS[step.stamp!] }}
              </span>
            </div>
          </div>

          <div class="flex flex-col gap-2 pt-4">
            <button
              class="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-on-brand transition-colors hover:bg-brand-strong active:scale-[0.98]"
              data-test="onboarding-start-cooking"
              @click="dismiss"
            >
              Start cooking
            </button>
            <!-- ADR-0097 §3: household invitation folded into the completion card. -->
            <button
              v-if="!ui.householdRoom"
              class="h-12 w-full rounded-lg border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-text active:bg-surface-sunken"
              data-test="onboarding-start-household"
              @click="() => { ui.showToast('Use the Household room card in Settings to start a room'); dismiss() }"
            >
              Start a household
            </button>
          </div>
        </div>

        <!-- Welcome card -->
        <div v-else class="text-center">
          <div class="mb-4 flex justify-center">
            <Flame :size="32" class="text-brand" />
          </div>
          <h2 class="text-headline-md text-text">Welcome to Flambette</h2>
          <p class="mt-3 text-body-sm text-text-muted">
            Your kitchen companion for planning meals from the frozen catalog.
            This quick tour shows you how to search, plan, and shop — all
            offline, all yours.
          </p>
          <div class="mt-6 flex flex-col gap-2 pt-2">
            <button
              class="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-on-brand transition-colors hover:bg-brand-strong active:scale-[0.98]"
              data-test="onboarding-start-tour"
              @click="onboarding.next"
            >
              Start tour
            </button>
            <button
              class="text-sm font-semibold text-text-muted hover:text-text"
              data-test="onboarding-skip-intro"
              @click="dismiss"
            >
              Skip tour
            </button>
          </div>
        </div>
      </div>

      <!-- ===== Anchored step card (spotlight steps 1–4) ===== -->
      <div
        v-else
        class="w-full max-w-sm rounded-3xl bg-surface-raised p-5 ring-1 ring-border shadow-warm"
      >
        <!-- Top meta: Step N of 5 + stamp preview -->
        <div class="mb-4 flex items-center justify-between">
          <span class="text-[11px] font-mono font-bold tracking-wider uppercase text-brand-text">
            Step {{ onboarding.stepNumber }} of 5
          </span>
          <span
            v-if="stepData?.stamp"
            class="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            :class="
              hasStamp(stepData.stamp)
                ? 'bg-brand-tint text-brand-text'
                : 'bg-surface text-text-muted'
            "
          >
            <span
              v-if="hasStamp(stepData.stamp)"
              class="flex size-4 items-center justify-center rounded-full bg-brand text-on-brand"
            >
              <Check :size="10" aria-hidden="true" />
            </span>
            <span v-else class="text-[10px]">{{ stepData.stamp }}</span>
          </span>
        </div>

        <!-- Progress dots -->
        <div class="mb-4 grid grid-cols-5 gap-1.5">
          <div
            v-for="(_, i) in ONBOARDING_STEPS"
            :key="i"
            class="h-1.5 rounded-full"
            :class="
              i < onboarding.stepNumber - 1
                ? 'bg-brand'
                : i === onboarding.stepNumber - 1
                  ? 'bg-brand/50'
                  : 'bg-border'
            "
          />
        </div>

        <!-- Icon + title -->
        <div class="mb-3 flex items-start gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand">
            <component :is="currentIcon()" :size="20" aria-hidden="true" />
          </span>
          <h3 class="text-headline-sm text-text">{{ stepData?.title }}</h3>
        </div>

        <!-- Body -->
        <p class="mb-4 text-body-sm text-text-muted">
          {{ stepData?.body }}
        </p>

        <!-- Hint when target is not yet visible -->
        <p
          v-if="stepData?.hint && !targetRect"
          class="mb-4 rounded-lg bg-brand-tint/30 p-2 text-xs text-brand-text"
        >
          {{ stepData.hint }}
        </p>

        <!-- Action footer -->
        <div class="flex items-center justify-between pt-2">
          <button
            v-if="showBack"
            class="flex items-center gap-1 text-sm font-semibold text-text-muted hover:text-text"
            data-test="onboarding-back"
            @click="goBack"
          >
            <ChevronLeft :size="16" aria-hidden="true" />
            Back
          </button>
          <div v-else />

          <div class="flex items-center gap-2">
            <button
              class="text-sm font-semibold text-text-muted hover:text-text"
              data-test="onboarding-skip-step"
              @click="skipAhead"
            >
              I've done this
            </button>
            <button
              class="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-strong active:scale-[0.98]"
              data-test="onboarding-got-it"
              @click="skipAhead"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Warm Culinary Paper shadow token (ADR-0067). */
.shadow-warm {
  box-shadow: 0 25px 50px -12px rgba(23, 19, 16, 0.25),
    0 0 0 1px rgba(229, 216, 203, 0.6);
}
</style>
