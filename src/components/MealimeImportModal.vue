<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircle2, X } from 'lucide-vue-next'
import AppModal from './AppModal.vue'
import { imageSrc, onImgError } from '../lib/images'
import {
  mealimeReportLines,
  type MealimeMatch,
  type MealimeMatchResult,
} from '../lib/mealimeImport'

/**
 * The Mealime-favourites-import SUCCESS modal (ADR-0058): after an
 * applied import the user SEES what landed — image + title per recipe,
 * the same visual grammar as the Auto-Plan dialog's confirm preview
 * (imageSrc/onImgError tiles, token classes only, dark mode is the theme
 * flip). The failure paths (malformed paste, all-miss, catalog-load
 * failure) never mount this — they keep their inline report / toast.
 *
 * Focus management is AppModal's: the ONE shared machinery (trigger
 * remembered, focus moved in on open, Tab trapped, restored on EVERY close
 * path — button, Escape, scrim).
 *
 * A full Mealime import is tens of recipes; the tile list CLAMPS to a
 * max-height with its own scroll while every row stays in the DOM.
 */
const props = defineProps<{
  result: MealimeMatchResult & { added: number; removed: number }
  /** variantId -> catalog entry (name + image url), resolved by the parent. */
  catalogById: Map<number, { name: string; image: string }>
}>()

const emit = defineEmits<{ close: [] }>()

function close() {
  emit('close')
}

/** Headline: the success + counts, in one sentence. The removed count
 *  lives in the report lines below — it already has its own sentence. */
const headline = computed(() => {
  const matchedCount = props.result.matched.length
  // Honest zero (added === 0 && removed === 0): the user asked to SEE the
  // success, so it opens; the headline says what actually happened.
  if (props.result.added === 0 && props.result.removed === 0) {
    return `Your favourites already match — ${matchedCount} ${matchedCount === 1 ? 'recipe' : 'recipes'}`
  }
  const byId = props.result.matched.filter((m: MealimeMatch) => m.by === 'id').length
  return `${matchedCount} ${matchedCount === 1 ? 'favourite' : 'favourites'} imported — ${byId} by id, ${matchedCount - byId} by name`
})

/** The report's sentences (missing, duplicates, removed) — the SAME
 * wording the inline report renders, from the one shared helper. */
const reportLines = computed(() => mealimeReportLines(props.result))

const tiles = computed(() =>
  props.result.matched.map((m) => {
    const entry = props.catalogById.get(m.variantId)
    return { variantId: m.variantId, name: entry?.name ?? '', image: entry?.image ?? '' }
  }),
)
</script>

<template>
  <AppModal
    dialog-label="Mealime favourites imported"
    overlay-class="z-50 flex items-end justify-center bg-surface-dark/50 sm:items-center"
    panel-class="max-h-[85vh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-surface-raised p-4 shadow-xl sm:rounded-2xl"
    panel-test="mealime-import-modal"
    @close="close"
  >
    <div class="flex items-start justify-between gap-3">
      <h3 class="flex items-center gap-2 text-body-sm font-bold tracking-tight">
        <CheckCircle2 :size="18" aria-hidden="true" class="shrink-0 text-success" />
        Mealime favourites imported
      </h3>
      <button
        class="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-sunken"
        aria-label="Close import report"
        data-test="mealime-import-modal-close"
        @click="close"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </div>
    <p class="text-label-md" data-test="mealime-import-modal-headline">{{ headline }}</p>

    <!-- The report's full sentences: the removed/missing/duplicates
    lines the inline report carries — shared wording, one helper. -->
    <p
      class="mt-2 text-xs"
      data-test="mealime-import-modal-report"
      aria-live="polite"
    >
      <template v-for="(line, i) in reportLines" :key="i">
        {{ line }}<br v-if="i < reportLines.length - 1" />
      </template>
    </p>

    <ul
      class="mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3"
      aria-label="Imported favourites"
      data-test="mealime-import-preview"
    >
      <li
        v-for="tile in tiles"
        :key="tile.variantId"
        class="rounded-lg ring-1"
        data-test="mealime-import-preview-tile"
      >
        <img
          :src="imageSrc(tile.image)"
          :alt="tile.name"
          loading="lazy"
          @error="onImgError"
          class="aspect-[4/3] w-full rounded-t-lg object-cover"
        />
        <p class="line-clamp-2 px-1.5 py-1 text-[11px] leading-tight font-medium">
          {{ tile.name }}
        </p>
      </li>
    </ul>

    <button
      class="mt-3 h-11 w-full rounded-xl bg-brand text-sm font-semibold text-on-brand active:bg-brand-strong"
      data-test="mealime-import-modal-done"
      @click="close"
    >
      Done
    </button>
  </AppModal>
</template>