<script setup lang="ts">
import { computed, ref } from 'vue'
import { ICON_ROLES, ROLE_GLYPHS, hueClass, type IconRole } from '../lib/palette'
import { useIconHoverTarget } from '../composables/useIconHoverTarget'
import TooltipBubble from './TooltipBubble.vue'

/**
 * The one renderer for a role glyph (ADR-0036 item 5: ONE role-to-glyph
 * mapping drives all call sites). It resolves the glyph from the shared
 * registry in `src/lib/palette.ts` rather than each component choosing
 * its own icon, so "vegetarian" can never be a sprout here and a salad
 * bowl there.
 *
 * `label` makes the ICON the carrier of the meaning, which is what the
 * recipe views need now that the redundant category word beside the icon
 * is gone: pass the role's label and the icon becomes `role="img"` with
 * an accessible name and a tooltip, and the word is never announced
 * twice. Without a label it is what an icon next to real text has always
 * been here — `aria-hidden` (ADR-0029).
 *
 * `tooltip` (ADR-0040) is the visual DUAL of that name, never its
 * replacement: the bubble is `aria-hidden` and `pointer-events-none`, so
 * the accessible name stays the single carrier. It defaults to the
 * `label`, which gives a tooltip to exactly the two places that have
 * BARE icons carrying meaning (the browse card type icon and the detail
 * header type icon) and to nothing else — a diet/protein chip already
 * prints its word beside the glyph, so a bubble there would be noise.
 * Pass `tooltip=""` to opt a labelled icon OUT.
 *
 * REVEAL (ADR-0044): the host span is `pointer-events-none` — the card's
 * stretched link keeps its click path under the icon — so the icon can
 * never match `:hover` and the old ancestor-`group/htt` anchor is GONE
 * (it opened the bubble for the whole card on the browse tile, and on
 * the recipe page it had no anchor at all). The pointer reveal is now a
 * JS hit-test: `useIconHoverTarget` watches the shared `pointermove`
 * listener and flips `pointerInside` while the pointer is inside THIS
 * host's rect — hovering the icon, and only the icon, on every surface
 * that renders it. The keyboard reveal is `@focusin`/`@focusout` on the
 * focusable host itself (`focusWithin`); both feed one class, and the
 * whole thing stays inside the `hovercap:` gate — `@media (hover: hover)`
 * from ADR-0040 — so the touch project can never reveal a bubble by
 * tapping (a tap FOCUSES the host, and the media gate is what keeps that
 * silent here).
 *
 * The host is still `tabindex="0"`, `role="img"`/`aria-label` still
 * carry the meaning for AT, and a click on the icon still reaches the
 * card's stretched link (the host stays pointer-transparent).
 *
 * It is deliberately NOT `hidden … hovercap:block` unconditionally (the
 * shape ADR-0040's sketch used): `hovercap:block` compiles to
 * `display:block` INSIDE the media query, so on every hover-capable
 * device it overrides `hidden` and the bubble would be permanently
 * open. `hidden` + the conditional reveal class gives the same "cannot
 * render on touch" guarantee without that failure mode. This component
 * is the ONE tooltip implementation (DRY); `RatingStars`' rating
 * preview is a DIFFERENT hover surface with its own group (ADR-0044 §3).
 *
 * ADR-0055: the glyph's native `title` is GONE — ADR-0040's recorded
 * follow-up ("drop title on bubble-bearing icons") is closed here; the
 * bubble is the visual dual of the accessible name and the OS tooltip
 * no longer doubles it.
 */
const props = withDefaults(
  defineProps<{
    role: IconRole
    size?: number
    label?: string
    tooltip?: string
    /** Opt-in tap-reveal (ADR-0055): ENGAGED by the recipe detail view
    only — browse cards stay hover-only (the host stays
    pointer-transparent so the card's stretched link keeps the tap). */
    tapReveal?: boolean
  }>(),
  { size: 18, label: undefined, tooltip: undefined, tapReveal: false },
)

/** The bubble text: an explicit tooltip, else the label, else nothing. */
const bubble = computed(() => {
  const text = props.tooltip ?? props.label
  return text ?? ''
})

/**
 * ADR-0044: subscribe the host to the shared pointer hit-test — but only
 * when a bubble exists (a labelled icon); an `aria-hidden` glyph beside
 * real text has nothing to reveal, and must not even register with the
 * listener. `label`/`tooltip` are static per usage, so the subscription
 * decided here at setup is the subscription for the element's life.
 */
const hostEl = ref<HTMLElement | null>(null)
const pointerInside = ref(false)
const focusWithin = ref(false)
if (bubble.value) {
  useIconHoverTarget(hostEl, pointerInside)
}

/**
 * ADR-0055: the tap-reveal STATE lives inside TooltipBubble; the host
 * (pointer-active ONLY when tapReveal is engaged) forwards the tap. The
 * bubble ref is set only when a bubble exists, so the handler is safe to
 * attach unconditionally.
 */
const bubbleEl = ref<InstanceType<typeof TooltipBubble> | null>(null)
function onHostClick() {
  if (props.tapReveal) bubbleEl.value?.tap()
}
</script>

<template>
  <!-- Focusable so the keyboard can reach the same information the
  pointer gets (see the header note). ADR-0055: `pointer-events-none`
  ONLY where the tap must pass through to a stretched link (browse
  cards — ADR-0044's pinned rule); where tapReveal is engaged (the
  detail header) there is no stretched link, so the host becomes
  tap-responsive. -->
  <span
  ref="hostEl"
  tabindex="0"
  data-test="hue-icon"
  class="relative inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
  :class="props.tapReveal ? 'hovercap:cursor-pointer' : 'pointer-events-none'"
  @click="onHostClick"
  @focusin="focusWithin = true"
  @focusout="focusWithin = false"
  >
    <component
    :is="ROLE_GLYPHS[ICON_ROLES[props.role].glyph]"
    :size="props.size"
    :class="hueClass(props.role)"
    :role="props.label ? 'img' : undefined"
    :aria-hidden="props.label ? undefined : 'true'"
    :aria-label="props.label"
    />
    <!-- ADR-0055: the ONE bubble component; `icon-tooltip` arrives by
    attribute fallthrough. Controlled mode — this host is
    pointer-transparent (ADR-0044), so the JS hit-test/focus verdict is
    the `active` prop. -->
    <TooltipBubble
    v-if="bubble"
    ref="bubbleEl"
    :text="bubble"
    :active="pointerInside || focusWithin"
    :tap-reveal="props.tapReveal"
    data-test="icon-tooltip"
    />
  </span>
</template>