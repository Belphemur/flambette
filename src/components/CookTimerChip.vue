<script setup lang="ts">
import { Pause, Play, X } from '@lucide/vue'
import { formatCountdown } from '../lib/stepTimer'

/**
 * One armed timer's controls — THE chip markup (coding-philosophy DRY).
 * CookingView used to spell the strip chip and the manage-sheet row as
 * two hand-copies of the same Pause/Restart + Delete pair; this local
 * component is the one markup. The SURFACES differ in hooks and voice,
 * so they come in as props:
 *
 * - `countdownTest` / `clearTest`: the per-surface data-test hooks (the
 *   strip chip's countdown is `step-timer` for every chip — the parent's
 *   container carries the id — while the manage row names the id).
 * - `countdownClass`: saffron on the strip (the cook reads it at arm's
 *   length), plain text in the sheet.
 * - `live`: the strip chip owns the polite live region (countdown NEVER
 *   uses the toast surface, ADR-0020) and its sr-only announce; the
 *   manage sheet does not speak.
 * - `nameTest` / `nameClass`: the sheet's rows flex-fill their name; the
 *   strip chip truncates it narrowly. The name hook is `chip-name` ONLY
 *   on the strip — never prefix any inner hook with `timer-chip-` (the
 *   parent's `[data-test^="timer-chip-"]` locator would double-match).
 */
defineProps<{
  /** The armed timer this chip drives. */
  timer: { id: number; label: string }
  /** Derived seconds still left (the parent owns the 1s tick). */
  remaining: number
  /** Derived: running AND time left (the parent computes via isCounting). */
  running: boolean
  countdownTest: string
  clearTest: string
  countdownClass: string
  nameClass: string
  /** The polite-region announce text; only the strip chip passes one. */
  srAnnounce?: string
  nameTest?: string
  live?: boolean
}>()

const emit = defineEmits<{ toggle: []; clear: [] }>()
</script>

<template>
  <span :data-test="nameTest" :class="nameClass">{{ timer.label }}</span>
  <button
    class="flex h-11 min-w-24 shrink-0 items-center justify-center gap-1 px-1 font-mono-data text-xl font-semibold tabular-nums"
    :class="countdownClass"
    :data-test="countdownTest"
    :aria-live="live ? 'polite' : undefined"
    :aria-label="
      running
        ? `Pause ${timer.label} timer, ${formatCountdown(remaining)} left`
        : `Start ${timer.label} timer, ${formatCountdown(remaining)} left`
    "
    @click="emit('toggle')"
  >
    <Pause v-if="running" :size="16" aria-hidden="true" />
    <Play v-else :size="16" aria-hidden="true" />
    <span>{{ formatCountdown(remaining) }}</span>
    <span v-if="srAnnounce" class="sr-only">{{ srAnnounce }}</span>
  </button>
  <button
    class="flex size-11 shrink-0 items-center justify-center"
    :data-test="clearTest"
    :aria-label="`Delete the ${timer.label} timer`"
    @click="emit('clear')"
  >
    <X :size="16" aria-hidden="true" />
  </button>
</template>
