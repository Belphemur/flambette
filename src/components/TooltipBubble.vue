<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * THE one tooltip implementation (ADR-0055; DRY). Every tooltip surface
 * in the app routes through this bubble: HueIcon's icon bubbles, the
 * room chip's bubble, and the native `title`s migrated to bubbles.
 *
 * The component renders the BUBBLE ONLY — never a wrapper around the
 * host — so call sites keep their own DOM (the stretched-link geometry
 * the e2e specs pin is untouched). The reveal STATE also lives here, in
 * exactly one of three modes (ADR-0055 Decision 2):
 *
 * 1. CONTROLLED (`active` given): the caller owns detection — HueIcon's
 *    host is `pointer-events-none` (ADR-0044) and can never match
 *    `:hover`, so it passes `pointerInside || focusWithin` from
 *    `useIconHoverTarget`/`@focusin`. Reveal class `hovercap:block` —
 *    ADR-0044's `@media (hover: hover)` gate, preserved verbatim.
 * 2. CSS (no `active`): the bubble carries `group-hover:block
 *    group-focus-within:block` statically and fires on the nearest
 *    `.group` ancestor — for ordinary pointer-active elements (the room
 *    chip, the migrated title hosts). The call site's contract is a
 *    `group` ancestor (each migrated host gained `group relative`).
 * 3. TAP-REVEAL (`tapReveal` prop): internal `tapOpen` state + a 3 s
 *    timer (ADR-0055 Decision 4). The reveal class is a plain `block`,
 *    deliberately UNGATED by `hovercap:` — the one place touch may
 *    reveal a bubble, and only where the surface opted in. The tap
 *    itself arrives via `tap()` (exposed), called by the host's click.
 *    Rules: auto-dismiss after TOOLTIP_TAP_REVEAL_MS; a second tap while
 *    open hides IMMEDIATELY (toggle — a user who taps again is
 *    dismissing); the timer is cleared on unmount, which covers leaving
 *    the view. The open state is an INLINE `display: block`, not a class:
 *    the base class is `hidden`, and Tailwind sorts `.hidden` AFTER
 *    `.block` in the same layer, so a plain `block` class can never win —
 *    the hover modes win because their `hovercap:`/`group-hover:` VARIANTS
 *    sort later than base utilities. An inline style needs no such order.
 *
 * Chrome (ADR-0055 Decision 3): ONE chrome for all bubbles. `hidden` —
 * never `invisible`, whose layout occupancy overflowed the Pixel 7
 * viewport and broke bottom-nav hit-testing (ADR-0049). `pointer-events-none`
 * — a bubble must never swallow a click aimed at its host.
 * `aria-hidden` — the accessible name is the single carrier of meaning
 * (ADR-0049, inherited); the bubble is never announced.
 *
 * `data-test` and other attributes fall through to the root span, which
 * is how `icon-tooltip` / `room-chip-tooltip` survive the migration
 * without renaming (ADR-0055 Decision 8).
 */
const props = withDefaults(
  defineProps<{
    /** Bubble content. Empty string renders NOTHING (conditional titles). */
    text: string
    /** The two existing pinned shapes (ADR-0055 Decision 3). */
    placement?: 'above-center' | 'below-right'
    /** Controlled reveal verdict; omit for the CSS group-hover mode. */
    active?: boolean
    /** Opt-in tap-reveal (engaged by the recipe detail view only). */
    tapReveal?: boolean
  }>(),
  { placement: 'above-center', active: undefined, tapReveal: false },
)

/** One tap-reveal duration constant for the whole app (ADR-0055 Decision 4). */
const TOOLTIP_TAP_REVEAL_MS = 3_000

/** Tap-reveal state: lives HERE, once (ADR-0055 Decision 2). */
const tapOpen = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

/** Second tap while open hides immediately (ADR-0055 Decision 4). */
function tap() {
  if (tapOpen.value) {
    hide()
  } else {
    tapOpen.value = true
    timer = setTimeout(hide, TOOLTIP_TAP_REVEAL_MS)
  }
}

function hide() {
  tapOpen.value = false
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}

/** Leaving the view unmounts the host — the timer must not outlive it. */
onBeforeUnmount(hide)

defineExpose({ tap, hide })

const shown = computed(() => (props.active ?? false) || tapOpen.value)

/**
 * Placement variants carry ONLY the classes that genuinely differ
 * between the two pinned shapes; the chrome below is shared (ADR-0055
 * Decision 3).
 */
const PLACEMENTS = {
  'above-center': 'bottom-full left-1/2 mb-1.5 w-max max-w-40 -translate-x-1/2 rounded-md text-[11px] leading-snug shadow-lg',
  'below-right': 'top-full right-0 mt-1.5 w-max max-w-56 rounded-lg text-xs leading-snug shadow-md',
} as const

const revealClasses = computed(() => {
  if (props.active === undefined) {
    // CSS mode: fire on the nearest .group ancestor (hover and focus).
    return 'group-hover:block group-focus-within:block'
  }
  // Controlled mode: ADR-0044's hovercap gate, verbatim.
  return shown.value ? 'hovercap:block' : ''
})
</script>

<template>
  <!-- v-if on `text`: conditional titles (a button's "Waiting…" line, a
  group without a plan date) render no bubble at all, exactly like the
  conditional `title`s they replaced. -->
  <span
  v-if="text"
  aria-hidden="true"
  class="pointer-events-none absolute z-20 hidden w-max rounded-md bg-surface-dark px-2 py-1 font-normal leading-snug text-text-dark"
  :class="[PLACEMENTS[placement], revealClasses]"
  :style="tapOpen ? { display: 'block' } : undefined"
  >
  {{ text }}
  </span>
</template>
