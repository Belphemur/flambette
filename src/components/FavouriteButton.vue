<script setup lang="ts">
import { computed } from 'vue'
import { Heart } from 'lucide-vue-next'
import { useFavouritesStore } from '../stores/favourites'

/**
 * THE favourite control (ADR-0031 / ADR-0074): the espresso-disc heart —
 * roasted espresso disc, white idle glyph, `favourite-soft` fill when the
 * recipe is starred. ONE component for every surface that carries it (the
 * recipe card's photo disc, the detail sheet's disc, the history cards'
 * row toggle), so the look, the 44px hit target and the store write cannot
 * drift between surfaces; the write is the ONE store action
 * (`favourites.toggleFavourite`), and the state is the store's
 * materialized Set — never a local copy.
 *
 * Positioning stays at the call site: unrecognized classes fall through
 * onto the button, so a caller places the disc with `absolute top-2
 * right-2 z-10` exactly as it did when it owned the markup.
 */
const props = withDefaults(
  defineProps<{
    /** The recipe variant this toggle stars (the store's key). */
    variantId: number
    /** Disc diameter in px — 44 is the minimum hit target (DESIGN.md). */
    size?: number
    /** Heart glyph size in px. */
    glyph?: number
  }>(),
  { size: 44, glyph: 20 },
)

const favourites = useFavouritesStore()
const isFavourite = computed(() => favourites.isFavourite(props.variantId))
</script>

<template>
  <button
    type="button"
    class="flex shrink-0 items-center justify-center rounded-full bg-espresso text-on-brand"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :aria-label="isFavourite ? 'Remove from favourites' : 'Add to favourites'"
    :aria-pressed="isFavourite"
    @click.stop="favourites.toggleFavourite(variantId)"
  >
    <Heart
      :size="glyph"
      :fill="isFavourite ? 'currentColor' : 'none'"
      :class="isFavourite ? 'text-favourite-soft' : ''"
      aria-hidden="true"
    />
  </button>
</template>
