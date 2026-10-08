<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { createHashvatar, type HashvatarResult } from 'hashvatar'
import { avatarTones } from '../lib/personAvatar'

/**
 * A person's generated avatar (ADR-0063, DESIGN.md "Person avatars and
 * the room roster").
 *
 * The `hashvatar` generator in DITHER mode, hashed on the person's
 * DISPLAY NAME — the owner's ask — so two devices showing the same person
 * render the same pattern, and a rename re-skins the pattern everywhere
 * (identical names rendering identical patterns is a documented
 * consequence, never a bug). The palette is NOT free art: `tones` are
 * read at runtime from the design system's family tokens
 * (src/lib/personAvatar.ts), so the pattern is always inside the palette.
 *
 * The canvas sits on a `surface-sunken` disc with a `border` keyline, so
 * any generated palette meets a known surface (DESIGN.md). Sizes are the
 * DESIGN.md tokens, not ad-hoc numbers: `avatar` (40px, default) where
 * the avatar stands in a row of its own, `avatar-sm` (28px) inline.
 *
 * Animation is ON by default and collapses to a still pattern under
 * `prefers-reduced-motion: reduce`; `destroy()` runs on unmount AND on
 * every hash/size change — a looping canvas that outlives its row is a
 * battery leak, not a decoration.
 */

const props = withDefaults(
  defineProps<{
    /** The DISPLAY NAME — the hash input (not the UUID). */
    name: string
    /** `md` = the `avatar` token (40px), `sm` = `avatar-sm` (28px). */
    size?: 'md' | 'sm'
    /** Animate the pattern (off under reduced motion). */
    animated?: boolean
  }>(),
  { size: 'md', animated: true },
)

// The reduced-motion query (ADR-0063 names `useReducedMotion`; the
// installed @vueuse/core build exposes the same signal as `useMediaQuery`,
// so the query is built here once — same reactivity, same semantics).
const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

const host = ref<HTMLElement | null>(null)
/** The live render; destroyed before every re-render and on unmount. */
let current: HashvatarResult | null = null

function destroy(): void {
  if (!current) return
  current.destroy()
  current.canvas.remove()
  current = null
}

function render(): void {
  destroy()
  if (!host.value || !props.name) return
  current = createHashvatar({
    hash: props.name,
    mode: 'dither',
    animated: props.animated && !reducedMotion.value,
    size: props.size === 'sm' ? 28 : 40,
    tones: avatarTones(),
  })
  // The generated canvas is square; the circular CLIP is the host's
  // `rounded-full overflow-hidden` (the disc), never a rounded canvas.
  current.canvas.className = 'block h-full w-full'
  host.value.appendChild(current.canvas)
}

watch(
  () => [props.name, props.size, props.animated, reducedMotion.value] as const,
  () => render(),
)

onMounted(render)
onUnmounted(destroy)
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-surface-sunken"
    :class="size === 'sm' ? 'size-7' : 'size-10'"
    aria-hidden="true"
  >
    <span ref="host" class="block size-full" />
  </span>
</template>
