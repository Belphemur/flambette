<script setup lang="ts">
import { computed } from 'vue'
import { Star } from 'lucide-vue-next'
import { useRatingStore } from '../stores/rating'
import { useUiStore } from '../stores/ui'

/**
 * Household star rating for one recipe (ADR-0031).
 *
 * The tap target is a HALF star: the left half of a slot sets `i + 0.5`,
 * the right half `i + 1` — the same 0.5 grid the store persists, so a
 * rating is never silently rounded. Rating is opinion: the value goes
 * into the ratings store (which the room transport publishes IMMEDIATELY)
 * and NEVER into `variant_meta.rating`, which stays read-only catalog
 * truth and is shown underneath as the unrated fallback.
 */
const props = defineProps<{
  variantId: number
  /** Catalog rating 0..1, shown as a dimmed read-only hint. */
  catalogRating?: number
  /** Star size in px. */
  size?: number
  /** Card density: the card variant sits inside a tappable article. */
  compact?: boolean
}>()

const ratingStore = useRatingStore()
const ui = useUiStore()

const mine = computed(() => ratingStore.ratingFor(props.variantId))
const count = computed(() => ratingStore.countFor(props.variantId))

/** Five slots, each split in two half-star targets. */
const slots = [1, 2, 3, 4, 5].map((n) => ({ n, halves: [n - 0.5, n] }))

/** How much of slot `n` is filled by the current rating (0..100%). */
function fillPercent(n: number): number {
  return Math.min(100, Math.max(0, (mine.value - (n - 1)) * 100))
}

function starLabel(value: number): string {
  const text = Number.isInteger(value) ? `${value}` : value.toFixed(1)
  return value === 0.5 ? 'Rate half a star' : `Rate ${text} of 5 stars`
}

function rate(value: number) {
  ratingStore.setRating(props.variantId, value)
  ui.showToast(
    value % 1 === 0 ? `Rated ${value} of 5` : `Rated ${value.toFixed(1)} of 5`,
    { duration: 2000 },
  )
}
</script>

<template>
  <div
    class="flex items-center gap-1"
    data-test="rating-stars"
    :data-variant-id="variantId"
    :data-rating="mine"
    :aria-label="
      count > 0
        ? `Your rating: ${mine} of 5 stars`
        : 'Not rated by your household yet'
    "
    role="group"
  >
    <span
      v-for="slot in slots"
      :key="slot.n"
      class="relative inline-flex shrink-0"
      :style="{ width: `${size ?? 18}px`, height: `${size ?? 18}px` }"
    >
      <Star
        :size="size ?? 18"
        class="absolute inset-0 text-stone-300 dark:text-stone-600"
        aria-hidden="true"
      />
      <!-- The filled portion is a clipped overlay, so a half star reads
           as a half star without shipping half-star glyphs. -->
      <span
        class="pointer-events-none absolute inset-0 overflow-hidden text-amber-400"
        :style="{ width: `${fillPercent(slot.n)}%` }"
        aria-hidden="true"
      >
        <Star :size="size ?? 18" :fill="'currentColor'" class="absolute inset-0" />
      </span>
      <button
        v-for="half in slot.halves"
        :key="half"
        type="button"
        class="absolute top-0 h-full"
        :style="{ left: half % 1 === 0.5 ? '0' : '50%', width: '50%' }"
        :aria-label="starLabel(half)"
        data-test="rating-star"
        @click.stop.prevent="rate(half)"
      />
    </span>
    <span
      v-if="!compact && count === 0 && catalogRating"
      class="ml-0.5 text-[11px] text-stone-400 dark:text-stone-500"
      data-test="rating-catalog-hint"
    >
      {{ Math.round(catalogRating * 5 * 10) / 10 }}★
    </span>
  </div>
</template>
