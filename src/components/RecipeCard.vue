<script setup lang="ts">
import { computed } from 'vue'
import { imageSrc, onImgError } from '../lib/images'
import RatingStars from './RatingStars.vue'
import HueIcon from './HueIcon.vue'
import type { VariantMeta } from '../lib/types'
import { catalog } from '../lib/catalog'
import { ICON_ROLES, ingredientRole } from '../lib/palette'
import { useFavouritesStore } from '../stores/favourites'
import { Clock, Heart } from 'lucide-vue-next'

const props = defineProps<{ meta: VariantMeta }>()

const favourites = useFavouritesStore()

/** Categorical ingredient-TYPE hue (ADR-0036); null when the catalog
 *  publishes no category we have a hue for — no icon beats a wrong hue. */
const typeRole = computed(() =>
  ingredientRole(catalog.value?.dataById.get(props.meta.id)?.category_name),
)

const isFavourite = computed(() => favourites.isFavourite(props.meta.id))
</script>

<template>
  <article
  class="group group/htt relative overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border transition-shadow hover:shadow-md"
  data-test="recipe-card"
  :data-variant-id="meta.id"
  >
  <div class="relative">
  <img
  :src="imageSrc(meta.thumbnail_image_url)"
  :alt="meta.name"
  loading="lazy"
  @error="onImgError"
  class="aspect-[4/3] w-full bg-surface-sunken object-cover"
  />
  <span
  v-if="meta.is_pro"
  class="absolute top-2 left-2 rounded bg-surface-dark px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-warning-soft"
  >
  PRO
  </span>
  <!-- A REAL control above the card's stretched link: the heart is not
  nested inside the link, it stops propagation, and it carries its
  own 44px hit area (DESIGN.md Components/Selection). -->
  <button
  class="absolute top-2 right-2 z-10 flex size-11 items-center justify-center rounded-full bg-surface-dark text-text-dark"
  :aria-label="isFavourite ? 'Remove from favourites' : 'Add to favourites'"
  :aria-pressed="isFavourite"
  @click.stop="favourites.toggleFavourite(meta.id)"
  >
  <Heart
  :size="20"
  :fill="isFavourite ? 'currentColor' : 'none'"
  :class="isFavourite ? 'text-favourite-soft' : 'text-text-dark'"
  aria-hidden="true"
  />
  </button>
  </div>

  <div class="p-3 sm:p-4">
  <h3 class="line-clamp-2 min-h-10 text-sm leading-5 font-semibold sm:text-title">
  <!-- The title IS the card link. Its ::after stretches over the
  whole card, so the entire tile is one target, while the heart
  and the rating stay independent controls above it (no nested
  interactive elements inside a link). -->
  <RouterLink
  :to="{ name: 'recipe', params: { id: String(meta.id) } }"
  class="recipe-card-stretch after:absolute after:inset-0 hover:no-underline"
  data-test="recipe-card-link"
  >
  {{ meta.name }}
  </RouterLink>
  </h3>

  <!-- Compact facts: TYPE, energy and time. Sodium is deliberately
  absent — it belongs to the recipe's nutrition detail, not to a
  glanceable browse tile. The type icon carries its own name
  (role="img") and the category word is NOT printed beside it. -->
  <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label-md text-text-muted">
  <span v-if="typeRole" class="flex items-center">
  <HueIcon :role="typeRole" :size="16" :label="ICON_ROLES[typeRole].label" />
  </span>
  <span class="flex items-center gap-1 whitespace-nowrap" data-test="card-energy">
  <HueIcon role="energy" :size="16" />{{ Math.round(meta.calories) }} kcal
  </span>
  <span class="flex items-center gap-1 whitespace-nowrap" data-test="card-time">
  <Clock :size="16" aria-hidden="true" />{{ meta.cooking_minutes }} min
  </span>
  </p>

  <div class="relative z-10 mt-1.5">
  <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="15" compact />
  </div>
  </div>
  </article>
</template>