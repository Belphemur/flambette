<script setup lang="ts">
import AppModal from './AppModal.vue'
import type { ConfirmPrompt } from '../stores/ui'

/**
 * THE confirm surface (ADR-0084): a slim centered card over the scrim.
 * Built on the ONE AppModal machinery (teleport, focus trap, focus
 * restore, Escape — never a second copy of any of it); the panel wears
 * the level-2 elevation grammar (`bg-popover border-border
 * shadow-popover rounded-2xl`, per the FilterDropdown/Ingredient-
 * Autocomplete popovers).
 *
 * The dialog's accessible name is the question itself. The confirm
 * action wears ADR-0072's `border-danger` outline for destructive
 * confirmations (every current call site — the `tone` prop keeps the
 * grammar one prop, not a fork); Cancel is the outlined tonal action and
 * means the same thing as Escape and the scrim: no.
 *
 * ONE close event carries the answer (`confirmed: boolean`) — Confirm,
 * Cancel, Escape and scrim all end through it, so the funnel's
 * settle-once / onDismiss-once contract needs exactly one listener.
 * There is NO auto-dismiss: a modal waits for an answer.
 */
defineProps<{ prompt: ConfirmPrompt }>()

const emit = defineEmits<{ close: [confirmed: boolean] }>()

/** Confirm-action visual, per tone (literal strings — Tailwind scans). */
const toneCls = {
  danger: 'border-danger text-danger hover:bg-danger/10 active:bg-danger/20',
  brand: 'bg-brand text-on-brand active:bg-brand-strong',
}
</script>

<template>
  <AppModal
    :dialog-label="prompt.message"
    overlay-class="z-50 flex items-center justify-center modal-scrim p-4"
    panel-class="w-full max-w-sm rounded-2xl border border-border bg-popover p-5 shadow-popover"
    panel-test="confirm-modal"
    @close="emit('close', false)"
  >
    <p class="text-sm font-medium text-text">{{ prompt.message }}</p>
    <div class="mt-4 flex gap-2">
      <button
        type="button"
        class="h-10 flex-1 rounded-lg border text-sm font-semibold transition-colors"
        :class="toneCls[prompt.tone]"
        data-test="confirm-action"
        @click="emit('close', true)"
      >
        {{ prompt.confirmLabel }}
      </button>
      <button
        type="button"
        class="h-10 flex-1 rounded-lg border border-border text-sm font-semibold text-text transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
        data-test="confirm-cancel"
        @click="emit('close', false)"
      >
        Cancel
      </button>
    </div>
  </AppModal>
</template>
