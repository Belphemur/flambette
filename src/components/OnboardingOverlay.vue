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
import { useRouter, useRoute } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import {
  Check,
  ChevronLeft,
  Flame,
  type LucideIcon,
  Recycle,
  Search,
  BookOpen,
  CalendarPlus,
  ShoppingBasket,
  Users,
} from '@lucide/vue'
import { catalog } from '../lib/catalog'
import { appModalsOpen } from './AppModal.vue'
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
const route = useRoute()
const ui = useUiStore()
const onboarding = useOnboardingStore()

/** Silence the halo pulse for motion-sensitive users (ADR-0097 §1). */
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

/** The frozen catalog size for the welcome card's first feature row
 *  (Stitch mock: "2,759 Hand-Curated Recipes"). Read off the loaded
 *  catalog — the overlay only mounts once `loading` is false (App.vue),
 *  so this is populated — never a hardcoded count that would drift on a
 *  catalog refresh. */
const recipeCount = computed(() => catalog.value?.variantMeta.length ?? 0)

/** Welcome card feature rows (Stitch mock, screen 1); the first row leads
 *  with the live catalog size. */
const WELCOME_FEATURES = computed(() => [
  {
    icon: BookOpen,
    title: `${recipeCount.value.toLocaleString()} hand-curated recipes`,
    badge: '100% offline',
    body: 'No internet required. Every recipe, photo, and scaled prep plan is available entirely on your device.',
  },
  {
    icon: Recycle,
    title: 'Waste-aware meal planning',
    badge: 'Zero waste',
    body: 'Plan smart and reduce food waste with auto-portioned quantities, so you buy fewer extra ingredients.',
  },
  {
    icon: Users,
    title: 'No accounts. Live household sync',
    badge: 'Room code',
    body: 'Share with your home in real time using a memorable three-word room code.',
  },
])

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

/** Navigating away from the tour's surface mid-spotlight ENDS the tour
 *  (ADR-0097 §5 "dismissible anywhere"): the user signalled they'll explore
 *  alone, so dismiss — stamps are kept, Settings can restart. Tour-driven
 *  navigation is exempt: it always lands INSIDE the step's routePrefix. */
watch(
  () => route.path,
  (p) => {
    const step = onboarding.step
    if (!step?.target || !step.routePrefix) return
    if (!p.startsWith(step.routePrefix)) onboarding.dismiss()
  },
)

/* ---------- Actions ---------- */

function dismiss(): void {
  onboarding.dismiss()
}

/** Escape owns dismissal (ADR-0097 §5). CAPTURE phase on window so the
 *  overlay's keypress is decided BEFORE target/bubble handlers see it —
 *  RecipeDetail's own Escape handler (navigate back) would otherwise also
 *  react while the spotlight sits on `recipe-detail`. A live AppModal owns
 *  Escape instead (its bubble listener runs later, so we simply yield);
 *  IME composition Escapes (keyCode 229) are never ours. */
function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (e.isComposing || e.keyCode === 229) return
  if (appModalsOpen()) return
  e.stopImmediatePropagation()
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
  window.addEventListener('keydown', onEscape, true)
  void nextTick(() => {
    if (stepData.value?.target && onboarding.currentStep >= 0) {
      findTarget(stepData.value.target, onboarding.currentStep)
    }
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEscape, true)
  cleanupSpotlight()
})
</script>

<template>
  <Teleport to="body">
    <div
      data-test="onboarding-overlay"
      :data-test-step="isCompletion ? 'completion' : (stepData?.key ?? 'welcome')"
      class="fixed inset-0 z-50 pointer-events-none"
    >
      <!-- ===== Spotlight scrim: dim frame with a hole at the target ===== -->
      <div v-if="targetRect" :style="dimFrameStyle" />

      <!-- ===== Target highlight ring (halo pulse, suppressed for reduced motion) ===== -->
      <div
        v-if="targetRect"
        data-test="spotlight-ring"
        class="pointer-events-none fixed z-41 rounded-xl"
        :class="prefersReducedMotion ? '' : 'animate-pulse'"
        :style="ringStyle"
      />

    <!-- ===== Full-screen scrim — ONLY the modal-like steps (welcome /
    completion). Spotlight steps never block: while their target has not
    been found yet the card floats non-modally so the user can perform the
    interaction the step is asking for (e.g. tap a recipe card); the
    spotlight steps' found-target scrim is the pointer-events-none dim
    frame instead. ===== -->
    <div
      v-if="currentStepIdx >= 0 && !isSpotlight"
      class="pointer-events-auto fixed inset-0 z-40 bg-espresso/75"
      data-test="onboarding-scrim"
      @click="dismiss"
    />

    <!-- ===== Step card===== -->
    <div
      v-if="currentStepIdx >= 0"
      class="fixed z-50"
      :class="
        targetRect
          ? 'pointer-events-auto'
          : 'inset-0 flex items-center justify-center px-4 pointer-events-none'
      "
      :style="targetRect ? anchoredCardStyle : null"
      :data-test="isCompletion ? 'onboarding-complete' : `onboarding-step-${stepData?.key}`"
    >
      <!-- Welcome / completion (steps without a spotlight target) -->
      <div
        v-if="!stepData?.target"
        class="pointer-events-auto mx-auto w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-3xl bg-surface-raised p-8 ring-1 ring-border shadow-warm"
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
          <div data-test="passport" class="my-8 flex items-center justify-center gap-3">
            <div
              v-for="(step, i) in ONBOARDING_STEPS.slice(0, COMPLETION_STEP)"
              :key="step.stamp || step.key"
              :data-test="`onboarding-stamp`"
              :data-stamp="step.stamp"
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
            A warm, photo-led kitchen companion designed to plan meals faster,
            minimize grocery waste, and cook with ease.
          </p>

          <!-- Feature rows (Stitch welcome mock): the three things that
               make flambette different, before the tour starts. -->
          <div class="mt-5 space-y-2 text-left">
            <div
              v-for="feature in WELCOME_FEATURES"
              :key="feature.title"
              class="flex items-start gap-3 rounded-xl bg-brand-tint/40 p-3"
            >
              <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-brand">
                <component :is="feature.icon" :size="16" aria-hidden="true" />
              </span>
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
                  {{ feature.title }}
                  <span
                    class="rounded-full bg-saffron-soft/50 px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wide text-espresso"
                  >{{ feature.badge }}</span>
                </p>
                <p class="mt-0.5 text-xs leading-relaxed text-text-muted">{{ feature.body }}</p>
              </div>
            </div>
          </div>

          <div class="mt-6 flex flex-col gap-2 pt-2">
            <button
              class="h-12 w-full rounded-xl bg-brand px-4 text-base font-semibold text-on-brand transition-colors hover:bg-brand-strong active:scale-[0.98]"
              data-test="onboarding-start-tour"
              @click="onboarding.next()"
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
          <p class="mt-4 text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Quick 60-second walkthrough
          </p>
        </div>
      </div>

      <!-- ===== Step card — anchored when the target is found (wrapper
           positions it), centered while the target has not appeared yet ===== -->
      <div
        v-else
        class="pointer-events-auto w-full max-w-sm rounded-3xl bg-surface-raised p-5 ring-1 ring-border shadow-warm"
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
