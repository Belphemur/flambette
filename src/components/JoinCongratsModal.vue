<script setup lang="ts">
import AppModal from './AppModal.vue'
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
 * There is no scrim click-to-dismiss and no Escape here (`dismissable:
 * false` on AppModal): the only thing to do is acknowledge it, and an
 * accidental dismissal would undo the one moment this screen exists for.
 * Focus MANAGEMENT is still the full job — AppModal moves focus into the
 * panel on open, traps Tab inside it, and gives the trigger focus back on
 * the way out. Without that, a keyboard user who arrives by link keeps
 * tabbing through controls they cannot see.
 *
 * `peers` is the headcount the relay reported WHEN this modal opened
 * (ADR-0049 addendum), passed in as a value rather than read live: the
 * count keeps arriving on `peers` frames while the panel is up, and a
 * sentence that rewrites itself mid-read is worse than one that is a
 * moment out of date. `null` — nobody told us — omits the sentence
 * entirely rather than inventing a household of one.
 */
defineProps<{ code: string; peers: number | null }>()

const emit = defineEmits<{ (e: 'dismiss'): void }>()

function dismiss() {
  emit('dismiss')
}
</script>

<template>
  <AppModal
    dialog-label="Joined the household"
    :dismissable="false"
    overlay-class="z-40 flex items-center justify-center bg-surface-dark/50 px-6"
    panel-class="w-full max-w-sm space-y-4 rounded-2xl bg-surface-raised p-6 text-center shadow-xl"
    overlay-test="join-congrats"
    panel-test="join-congrats-dialog"
    @close="dismiss"
  >
  <Users
  :size="32"
  class="mx-auto text-success"
  aria-hidden="true"
  data-test="join-congrats-icon"
  />
  <h2 class="text-lg font-bold tracking-tight">You've joined the household</h2>
  <p
  v-if="peers !== null"
  class="text-sm font-medium text-success"
  data-test="join-congrats-peers"
  >
  {{ peers === 1 ? 'You are the first one here right now.' : `You're one of ${peers} in the room right now.` }}
  </p>
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
  </AppModal>
</template>