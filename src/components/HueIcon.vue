<script setup lang="ts">
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
 */
const props = withDefaults(defineProps<{ role: IconRole; size?: number; label?: string }>(), {
  size: 18,
  label: undefined,
})
</script>

<template>
  <component
  :is="ROLE_GLYPHS[ICON_ROLES[props.role].glyph]"
  :size="props.size"
  :class="hueClass(props.role)"
  :role="props.label ? 'img' : undefined"
  :aria-hidden="props.label ? undefined : 'true'"
  :aria-label="props.label"
  :title="props.label"
  />
</template>