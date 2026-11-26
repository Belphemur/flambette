<script setup lang="ts">
import { computed } from 'vue'
import type { AlarmingTimer } from '../lib/timerAlertHost'

/**
 * The alarm surface for BOTH fullscreen focus modes (cooking and shopping,
 * ADR-0104 review hardening 2026-11-26). The shell banner is deliberately
 * hidden there — cooking carried a recipe-scoped strip, shopping has no
 * timer surface at all — so a timer from ANOTHER recipe (or one expired
 * while shopping) would otherwise ring with no visible output and no
 * reachable Stop. This indicator is recipe-agnostic: it lists every key in
 * the host's `alarmingTimers` mirror and owns the same Stop verb as the
 * shell banner (the timers' own Clear), never a second alarm state.
 */
const props = defineProps<{ timers: AlarmingTimer[] }>()
defineEmits<{ stop: [] }>()

const names = computed(() =>
  props.timers.map((t: AlarmingTimer) => `“${t.label}”`).join(', '),
)
</script>

<template>
  <div
    v-if="timers.length"
    role="alert"
    data-test="fullscreen-alarm"
    class="fixed top-20 left-1/2 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-3xl border border-border bg-popover px-4 py-2.5 text-sm font-medium leading-snug text-text shadow-popover"
  >
    <!-- The shake rides a NON-interactive inner wrapper, never the Stop
         button: a moving target is unusable (ADR-0104 implementation
         detail). Reduced motion keeps the static brand outline. -->
    <span
      data-test="fullscreen-alarm-shake"
      data-test-alarm-shake="active"
      class="alarm-shake inline-flex items-center gap-1"
    >
      <span data-test="fullscreen-alarm-text">Time's up — still ringing: {{ names }}</span>
      <span data-test="fullscreen-alarm-shake-marker" aria-hidden="true" class="sr-only">shaking</span>
    </span>
    <button
      type="button"
      data-test="fullscreen-alarm-stop"
      class="rounded-full bg-brand px-3 py-1 text-xs font-bold uppercase tracking-wide text-on-brand"
      :aria-label="`Stop the alarm for ${names}`"
      @click="$emit('stop')"
      >Stop</button
    >
  </div>
</template>
