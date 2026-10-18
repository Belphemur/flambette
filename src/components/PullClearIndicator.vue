<script setup lang="ts">
import type { PullPhase } from '../lib/pullToClear'

/**
 * The pull-to-clear state indicator (ADR-0092 decision 2) — ONE
 * presentational component for BOTH the Grocery tab and Shop view, so
 * the two surfaces cannot drift. Pure rendering: the state machine and
 * pointer handling live in `usePullToClear`; the label text is the
 * state the e2e asserts (`data-state` = pull | armed).
 *
 * Hidden from assistive tech on purpose: it is a transient gesture
 * affordance (the adaptive button is the accessible one), and
 * announcing every dragged pixel would be noise.
 */
defineProps<{ phase: PullPhase }>()
</script>

<template>
  <div class="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center" aria-hidden="true">
    <p
      v-if="phase !== 'idle'"
      data-test="pull-clear-indicator"
      :data-state="phase"
      class="rounded-full bg-surface-raised px-3 py-1 text-label-sm font-medium text-text ring-1 ring-border"
    >
      {{ phase === 'armed' ? 'Release to clear checked' : 'Pull to clear checked' }}
    </p>
  </div>
</template>
