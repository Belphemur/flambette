<script setup lang="ts">
import { Users } from 'lucide-vue-next'

/**
 * The full-page celebration for arriving in a household through a shared
 * `?room=` link (ADR-0049).
 *
 * A toast was the old answer, and it was the wrong one: "Joining live
 * room…" is indistinguishable from every other toast the app raises, and
 * it is gone in three seconds. Someone who has just been handed a link by
 * their household is now *in*, and the next thing they will do is show
 * that code to somebody else — so the code is the most prominent thing
 * on the page, not a fragment of a sentence.
 *
 * This celebrates. It never excuses: a link that fails to join shows the
 * error toast and no modal (the caller decides by only opening this once
 * the room is actually live).
 *
 * The overlay shape is PlanTab's share sheet (`fixed inset-0` +
 * `bg-surface-dark/50`) so the two full-page surfaces in the app read as
 * one family. There is no scrim click-to-dismiss and no Escape here: the
 * only thing to do is acknowledge it, and an accidental dismissal would
 * undo the one moment this screen exists for.
 */
defineProps<{ code: string }>()

const emit = defineEmits<{ (e: 'dismiss'): void }>()

function dismiss() {
  emit('dismiss')
}
</script>

<template>
  <Teleport to="body">
  <div
  class="fixed inset-0 z-40 flex items-center justify-center bg-surface-dark/50 px-6"
  data-test="join-congrats"
  >
  <div
  class="w-full max-w-sm space-y-4 rounded-2xl bg-surface-raised p-6 text-center shadow-xl"
  role="dialog"
  aria-modal="true"
  aria-label="Joined the household"
  data-test="join-congrats-dialog"
  >
  <Users
  :size="32"
  class="mx-auto text-success"
  aria-hidden="true"
  data-test="join-congrats-icon"
  />
  <h2 class="text-lg font-bold tracking-tight">You've joined the household</h2>
  <p class="text-sm text-text-muted">
  Share this code with the rest of your household so everyone plans in the same room.
  </p>
  <p
  class="select-all break-all rounded-xl bg-surface-sunken px-3 py-3 font-mono text-lg font-semibold tracking-tight"
  data-test="join-congrats-code"
  >
  {{ code }}
  </p>
  <button
  type="button"
  class="h-11 w-full rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand active:bg-brand-strong"
  aria-label="Continue to the app"
  data-test="join-congrats-continue"
  @click="dismiss"
  >
  Continue
  </button>
  </div>
  </div>
  </Teleport>
</template>