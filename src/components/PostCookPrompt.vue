<script setup lang="ts">
import AppModal from './AppModal.vue'
import FavouriteButton from './FavouriteButton.vue'
import RatingStars from './RatingStars.vue'

/**
 * The post-cook prompt (ADR-0083): the cooking session raises this modal
 * after a successful Finish — the completion's acknowledgment. The modal
 * IS the acknowledgment, so the "Enjoy! Marked as cooked" toast does not
 * also fire on this path (the mid-cook mark keeps its toast + Undo).
 *
 * Content is the existing controls, mounted, never re-implemented (DRY):
 * the ONE RatingStars at the rate card's sizes (32 phone / 24 desktop via
 * the component's own lgSize, ADR-0082) writing the same ratings store,
 * and the ONE FavouriteButton writing the favourites store — the two
 * things a person most likely wants at the exact moment the meal is done.
 *
 * Close semantics are the ADR's, owned by the caller (CookingView):
 * - `done` — the ONLY non-Undo exit (Done button, scrim tap, Escape all
 *   land here via AppModal's one `close` emit): the caller closes the
 *   prompt and navigates to /history, where the cooked entry just landed;
 * - `undo` — "Undo — not actually cooked" calls the SAME
 *   `plan.undoMarkCooked(event, prior)` the old toast Undo called; the
 *   caller clears the session's recorded cook and the cook STAYS open.
 *
 * Focus restore is AppModal's and already covers the opener-unmounts
 * case: on a `done` close the cook session unmounts with the navigation,
 * AppModal's restore target (the Finish button) leaves the document, and
 * the restore falls back to body; on `undo` the session is still mounted,
 * so the Finish button regains focus exactly as a toast Undo would.
 */
defineProps<{ variantId: number }>()

const emit = defineEmits<{ done: []; undo: [] }>()
</script>

<template>
  <AppModal
    dialog-label="Enjoyed it?"
    overlay-class="z-50 flex items-end justify-center modal-scrim sm:items-center"
    panel-class="w-full max-w-sm rounded-t-2xl bg-surface-raised p-5 space-y-4 sm:rounded-2xl"
    overlay-test="post-cook-overlay"
    panel-test="post-cook-prompt"
    @close="emit('done')"
  >
  <h2 class="text-lg font-bold tracking-tight text-text">Enjoyed it?</h2>
  <!-- The rating target is the cooked variant id — the same id the
  ratings store keys on — so a half-star rating made here persists
  exactly like one made on the detail card (ADR-0083). -->
  <div class="flex items-center justify-between gap-3" data-test="post-cook-actions">
    <RatingStars :variant-id="variantId" :size="32" :lg-size="24" />
    <FavouriteButton :variant-id="variantId" />
  </div>
  <button
    type="button"
    class="h-11 w-full rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand active:bg-brand-strong"
    data-test="post-cook-done"
    @click="emit('done')"
  >
    Done
  </button>
  <button
    type="button"
    class="mx-auto block text-label-sm font-medium text-text-muted underline-offset-2 hover:text-text hover:underline focus-visible:underline"
    data-test="post-cook-undo"
    @click="emit('undo')"
  >
    Undo — not actually cooked
  </button>
  </AppModal>
</template>