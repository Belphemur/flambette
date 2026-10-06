<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
 *    `useIconHoverTarget`/`@focusin`. Reveal classes `hovercap:opacity-100
 *    hovercap:visible` — ADR-0044's `@media (hover: hover)` gate,
 *    preserved verbatim.
 * 2. CSS (no `active`): the bubble carries `group-hover:opacity-100
 *    group-hover:visible` (+ focus-within) statically and fires on the
 *    nearest `.group` ancestor — for ordinary pointer-active elements
 *    (the room chip, the migrated title hosts). The call site's contract
 *    is a `.group` ancestor that CONTAINS the bubble (group-hover is a
 *    descendant selector — the one-shape rule ADR-0055 records).
 * 3. TAP-REVEAL (`tapReveal` prop): internal `tapOpen` state + a 3 s
 *    timer (ADR-0055 Decision 4). The open state is an INLINE
 *    `opacity/visibility` style, deliberately UNGATED by `hovercap:` —
 *    the one place touch may reveal a bubble, and only where the surface
 *    opted in. The tap itself arrives via `tap()` (exposed), called by
 *    the host's click. Rules: auto-dismiss after TOOLTIP_TAP_REVEAL_MS;
 *    a second tap while open hides IMMEDIATELY (toggle — a user who
 *    taps again is dismissing); the timer is cleared on unmount, which
 *    covers leaving the view.
 *
 * FADE (owner ruling, 2026-10-06): every bubble enters and leaves
 * through an opacity+visibility transition — never a hard display swap.
 * That REVERSES the old `hidden`-not-`invisible` rule, and the reason
 * the old rule existed is still respected: the ADR-0049 Pixel 7 failure
 * was an UNCLAMPED bubble widening the document until the fixed bottom
 * nav stopped receiving taps. Hiding by `visibility` needs the bubble
 * to occupy layout, so the same ruling also mandates the in-viewport
 * clamp below — a bubble is never allowed outside the viewport, capped
 * at `max-w-56`, and `pointer-events-none` always.
 *
 * IN-VIEWPORT CLAMP (same ruling): the bubble is positioned by its
 * classes relative to the host (the containing block), then nudged with
 * a `transform` so it stays inside the viewport with an 8px margin:
 * available space is computed from the HOST's rect, the preferred side
 * (the `placement` prop) is flipped to the other side when it does not
 * fit, and the horizontal position is clamped at the screen edges. The
 * transform is applied even while hidden, so the layout box can never
 * widen the document. Recomputed on mount, on text change, on resize,
 * on the HOST's pointerenter/focusin (CSS mode — the cheap hover
 * signal CSS already drives, so no scroll listener is spent), or when
 * the controlled/tap verdict turns true (watch) — never a global
 * scroll listener: an absolute bubble TRAVELS WITH its host when the
 * page scrolls, so re-clamping per scroll frame would be redundant
 * layout reads per bubble (kody r1), and the reveal-time measurement
 * is the one the refinement requires.
 *
 * Chrome (ADR-0055 Decision 3): ONE chrome for all bubbles.
 * `pointer-events-none` — a bubble must never swallow a click aimed at
 * its host. `aria-hidden` — the accessible name is the single carrier
 * of meaning (ADR-0049, inherited); the bubble is never announced.
 *
 * `data-test` and other attributes fall through to the root span, which
 * is how `icon-tooltip` / `room-chip-tooltip` survive the migration
 * without renaming (ADR-0055 Decision 8).
 */
const props = withDefaults(
  defineProps<{
    /** Bubble content. Empty string renders NOTHING (conditional titles). */
    text: string
    /** The two existing pinned shapes (ADR-0055 Decision 3); the
     * preferred side, flipped when the viewport has no room for it. */
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

/** The viewport margin the clamp keeps around every bubble. */
const VIEWPORT_MARGIN = 8

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

const el = ref<HTMLElement | null>(null)

/**
 * The clamp: a transform that keeps the class-positioned bubble inside
 * the viewport, flipping the vertical side when the preferred one does
 * not fit. Measured from the HOST (the bubble's `relative` containing
 * block) plus the bubble's own SIZE (transform-independent), so the
 * arithmetic never iterates.
 */
const nudge = ref<{ dx: number; dy: number } | null>(null)
let raf = 0

function reposition() {
  raf = 0
  const node = el.value
  if (!node || !props.text) {
    nudge.value = null
    return
  }
  // Skip the redundant layout reads while the bubble cannot be seen —
  // EXCEPT in CSS mode, where JS has no other signal that a hover/focus
  // reveal is starting (those measure on mount/resize and on the host's
  // pointerenter/focusin below instead). A skip must KEEP the existing
  // clamp: the bubble hides via visibility, which keeps its layout box,
  // so dropping the transform while hidden would leave an unclamped box
  // in the document (the ADR-0049 hazard) until first reveal. Skip only
  // once a clamp exists; the FIRST measurement while hidden still runs
  // (kody r2). A reveal always measures fresh — the early-out is
  // gated on !shown.
  const cssMode = props.active === undefined
  if (!cssMode && !shown.value && nudge.value !== null) {
    return
  }
  const host = node.parentElement
  if (!host) {
    nudge.value = null
    return
  }
  const b = node.getBoundingClientRect()
  if (b.width === 0) {
    nudge.value = null
    return
  }
  const h = node.parentElement.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 6 // mb-1.5 / mt-1.5
  const m = VIEWPORT_MARGIN
  const w = b.width
  const bh = b.height
  const fitsAbove = h.top - gap - bh >= m
  const fitsBelow = vh - h.bottom - gap - bh >= m

  // Vertical: preferred side first, flip when it does not fit.
  const classAbove = props.placement === 'above-center'
  let above = classAbove
  if (above && !fitsAbove && fitsBelow) above = false
  else if (!above && !fitsBelow && fitsAbove) above = true

  // dy from the class base position to the wanted one. Same side: clamp
  // inside the viewport; flipped side: the jump to the other edge of
  // the host (which fits by construction — a flip only happens when the
  // target side has room).
  const baseTop = classAbove ? h.top - gap - bh : h.bottom + gap
  const wantTop = above === classAbove
    ? Math.max(m, Math.min(baseTop, vh - m - bh))
    : above
      ? h.top - gap - bh
      : h.bottom + gap
  const dy = wantTop - baseTop

  // Horizontal: clamp the bubble's box inside the viewport.
  const centered = classAbove
  const baseLeft = centered ? h.left + h.width / 2 - w / 2 : h.right - w
  const wantLeft = Math.max(m, Math.min(baseLeft, vw - m - w))
  const dx = wantLeft - baseLeft

  nudge.value = dx !== 0 || dy !== 0 ? { dx, dy } : null
}

function scheduleReposition() {
  if (raf === 0) raf = requestAnimationFrame(reposition)
}

/**
 * CSS-mode bubbles: the host's own hover/focus — the same signal the
 * reveal classes use — is the cheap trigger for one measurement. No
 * scroll listener (see the clamp note above). The host is captured
 * REACTIVELY: the root span is behind `v-if="text"`, so it may not
 * exist at mount (a conditional title that starts empty) — a
 * mount-time-only capture would never attach and the reveal-time
 * re-measure would never run for that bubble (kody r2).
 */
let host: HTMLElement | null = null

watch(el, (node) => {
  if (host) {
    host.removeEventListener('pointerenter', scheduleReposition)
    host.removeEventListener('focusin', scheduleReposition)
    host = null
  }
  host = node?.parentElement ?? null
  if (host && props.active === undefined) {
    host.addEventListener('pointerenter', scheduleReposition, { passive: true })
    host.addEventListener('focusin', scheduleReposition, { passive: true })
  }
}, { immediate: true })

onMounted(() => {
  scheduleReposition()
  window.addEventListener('resize', scheduleReposition, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleReposition)
  if (host) {
    host.removeEventListener('pointerenter', scheduleReposition)
    host.removeEventListener('focusin', scheduleReposition)
    host = null
  }
  if (raf !== 0) cancelAnimationFrame(raf)
})

watch(() => props.text, scheduleReposition)
watch(shown, (now) => {
  if (now) scheduleReposition()
})

/** The clamp transform overrides the class translate for centered bubbles. */
const nudgeStyle = computed(() => {
  if (!nudge.value) return undefined
  const { dx, dy } = nudge.value
  const centered = props.placement === 'above-center'
  return centered
    ? { transform: `translate(calc(-50% + ${dx}px), ${dy}px)` }
    : { transform: `translate(${dx}px, ${dy}px)` }
})

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
    if (props.tapReveal) {
      // CSS mode + tap-reveal (the recipe-detail badge): a touch browser
      // can RETAIN :hover after a tap, and an ungated group-hover would
      // re-open the bubble after the second tap hid it or the timer
      // fired. The hover reveal keeps ADR-0044's media gate; the
      // keyboard focus reveal stays ungated (focus is not a touch
      // artefact on a non-focusable wrapper).
      return 'hovercap:group-hover:opacity-100 hovercap:group-hover:visible group-focus-within:opacity-100 group-focus-within:visible'
    }
    // CSS mode: fire on the nearest .group ancestor (hover and focus).
    return 'group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible'
  }
  // Controlled mode: ADR-0044's hovercap gate, verbatim.
  return shown.value ? 'hovercap:opacity-100 hovercap:visible' : ''
})

/** Tap-reveal opens through the same fade (inline style beats classes). */
const tapStyle = computed(() =>
  tapOpen.value ? { opacity: '1', visibility: 'visible' } : undefined,
)

/** All inline styling in one object (Vue rejects mixed arrays of literals). */
const inlineStyle = computed<Record<string, string> | undefined>(() => {
  const merged: Record<string, string> = {}
  if (tapStyle.value) Object.assign(merged, tapStyle.value)
  if (nudgeStyle.value) Object.assign(merged, nudgeStyle.value)
  return Object.keys(merged).length > 0 ? merged : undefined
})
</script>

<template>
  <!-- v-if on `text`: conditional titles (a button's "Waiting…" line, a
  group without a plan date) render no bubble at all, exactly like the
  conditional `title`s they replaced. -->
  <span
  v-if="text"
  ref="el"
  aria-hidden="true"
  class="pointer-events-none absolute z-20 w-max rounded-md bg-surface-dark px-2 py-1 font-normal leading-snug text-text-dark opacity-0 invisible transition-[opacity,visibility] duration-150"
  :class="[PLACEMENTS[placement], revealClasses]"
  :style="inlineStyle"
  >
  {{ text }}
  </span>
</template>
