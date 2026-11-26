<script setup lang="ts">
/**
 * ADR-0104's visual channel on ONE strip chip: a non-interactive outline
 * overlay that inherits the chip's bounds. The chip container and its
 * countdown/Delete buttons never move, so Stop/Delete stay tappable.
 * Extracted from CookingView (review hardening 2026-11-26) so the markup
 * is defined once; the data-test marker stays identical for e2e.
 */
defineProps<{ alarmTest?: string }>()
</script>

<template>
  <span
    :data-test="alarmTest ?? 'timer-chip-shake'"
    data-test-alarm-shake="active"
    aria-hidden="true"
    class="alarm-shake pointer-events-none absolute inset-0 rounded-xl"
  ></span>
</template>
