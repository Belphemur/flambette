<script setup lang="ts">
import { computed } from 'vue'
import { ICON_ROLES, ROLE_GLYPHS, hueClass, type IconRole } from '../lib/palette'

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
 * The bubble reveals on `group-hover/htt` (which a touch device can
 * never fire), on `group-focus/htt` and on `group-focus-within/htt` —
 * all COMBINED with the `hovercap:` variant, i.e.
 * `@media (hover: hover)` — the same discipline that scopes the pointer
 * cursor. The media gate matters: a tap on a phone FOCUSES the button
 * inside a rating row, so an ungated `group-focus-within` would pop a
 * bubble on the touch device this whole mechanism exists to stay off.
 *
 * The host span is itself a focus target (`tabindex="0"`) and is
 * `pointer-events-none`. The latter restores the card link's click path
 * (the positioned tooltip host painted above the stretched
 * `after:inset-0` overlay used to swallow clicks on the type icon) while
 * leaving it keyboard focusable. The trade-off is that the pointer over
 * the icon region now hits whatever is under it, so HOVER is anchored on
 * an ancestor `group/htt` (the browse card root carries the same group
 * name) rather than on the host itself — hovering the card is what opens
 * the bubble, which is also the natural gesture for it.
 *
 * It is deliberately NOT `hidden … hovercap:block` (the shape ADR-0040's
 * sketch used): `hovercap:block` compiles to `display:block` INSIDE the
 * media query and nothing else, so on every hover-capable device it
 * overrides `hidden` and the bubble is permanently open. `hidden` +
 * the two reveal variants gives the same "cannot render on touch"
 * guarantee without that failure mode. This component is the ONE
 * tooltip implementation (DRY).
 *
 * KNOWN, DELIBERATE: the icon keeps its native `title`, so a
 * hover-capable browser will eventually also show its own OS-level
 * tooltip beside this bubble. `title` is retained on instruction
 * (see the ADR-0040 handoff); the follow-up is to drop `title` on
 * bubble-bearing icons only.
 */
const props = withDefaults(defineProps<{ role: IconRole; size?: number; label?: string; tooltip?: string }>(), {
  size: 18,
  label: undefined,
  tooltip: undefined,
})

/** The bubble text: an explicit tooltip, else the label, else nothing. */
const bubble = computed(() => {
  const text = props.tooltip ?? props.label
  return text ?? ''
})
</script>

<template>
  <!-- Focusable so the keyboard can reach the same information the
  pointer gets (see the header note); `pointer-events-none` so the card's
  stretched link keeps the click path under the icon. -->
  <span
  tabindex="0"
  data-test="hue-icon"
  class="group/htt pointer-events-none relative inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
  >
    <component
    :is="ROLE_GLYPHS[ICON_ROLES[props.role].glyph]"
    :size="props.size"
    :class="hueClass(props.role)"
    :role="props.label ? 'img' : undefined"
    :aria-hidden="props.label ? undefined : 'true'"
    :aria-label="props.label"
    :title="props.label"
    />
    <span
    v-if="bubble"
    role="presentation"
    aria-hidden="true"
    data-test="icon-tooltip"
    class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-max max-w-40 -translate-x-1/2 rounded-md bg-surface-dark px-2 py-1 text-[11px] leading-snug text-on-brand shadow-lg hovercap:group-hover/htt:block hovercap:group-focus/htt:block hovercap:group-focus-within/htt:block"
    >
    {{ bubble }}
    </span>
  </span>
</template>