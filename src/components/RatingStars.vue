<script setup lang="ts">
import { computed, ref } from 'vue'
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
  /**
   * Catalog mean 0..1 filling the stars when the household has not
   * rated — the strip's number prints the SAME fallback (ADR-0031's
   * precedence), so the value and the stars can never disagree. Without
   * it (cards) the stars stay empty and the hint text carries the mean.
   */
  fallbackRating?: number
}>()

const ratingStore = useRatingStore()
const ui = useUiStore()

const mine = computed(() => ratingStore.ratingFor(props.variantId))
const count = computed(() => ratingStore.countFor(props.variantId))

/**
 * The score a hover/focus WOULD set (ADR-0040), 0.5-step like the store.
 * Presentation only: the preview feeds the same `fillPercent` the
 * committed rating feeds, so a half slot previews a half star, and it
 * NEVER calls `setRating` — the store write stays exactly where it is,
 * on the tap. Mouse-out/focus-out restores the committed value at once.
 */
const hovered = ref<number | null>(null)
const display = computed(() => {
  if (hovered.value !== null) return hovered.value
  if (mine.value > 0) return mine.value
  // No household opinion yet: the catalog mean fills the stars so the
  // value printed beside them (the same fallback) and the fill agree.
  return (props.fallbackRating ?? 0) * 5
})

/** Five slots, each split in two half-star targets. */
const slots = [1, 2, 3, 4, 5].map((n) => ({ n, halves: [n - 0.5, n] }))

/** How much of slot `n` is filled by the DISPLAYED rating (0..100%). */
function fillPercent(n: number): number {
  return Math.min(100, Math.max(0, (display.value - (n - 1)) * 100))
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

/** Preview on hover AND on keyboard focus, so both get the same signal. */
function preview(value: number | null) {
  hovered.value = value
}

/**
 * The bubble's text is the SAME `starLabel()` the slot's `aria-label`
 * uses — one string table, so the sighted preview and the accessible name
 * can never drift (ADR-0040).
 */
const previewLabel = computed(() =>
  hovered.value === null ? '' : starLabel(hovered.value),
)
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
  class="relative inline-flex group/htt"
  data-test="rating-stars-inner"
  >
  <span
  v-if="hovered !== null"
  role="presentation"
  aria-hidden="true"
  data-test="rating-preview"
  class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-max -translate-x-1/2 rounded-md bg-surface-dark px-2 py-1 text-[11px] leading-snug text-on-brand shadow-popover hovercap:group-hover/htt:block hovercap:group-focus-within/htt:block"
  >
  {{ previewLabel }}
  </span>
  <span
  v-for="slot in slots"
  :key="slot.n"
  class="relative inline-flex shrink-0"
  :style="{ width: `${size ?? 18}px`, height: `${size ?? 18}px` }"
  >
  <Star
  :size="size ?? 18"
  class="absolute inset-0 text-text"
  aria-hidden="true"
  />
  <!-- The filled portion is a clipped overlay, so a half star reads
  as a half star without shipping half-star glyphs. -->
  <span
  class="pointer-events-none absolute inset-0 overflow-hidden text-warning"
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
  @mouseenter="preview(half)"
  @mouseleave="preview(null)"
  @focus="preview(half)"
  @blur="preview(null)"
  />
  </span>
  </span>
  <span
  v-if="!compact && count === 0 && catalogRating"
  class="ml-0.5 text-[11px] text-text-muted"
  data-test="rating-catalog-hint"
  >
  {{ Math.round(catalogRating * 5 * 10) / 10 }}★
  </span>
  </div>
</template>
