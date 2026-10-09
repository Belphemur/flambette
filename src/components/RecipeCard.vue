<script setup lang="ts">
import { computed } from 'vue'
import { imageSrc, onImgError } from '../lib/images'
import RatingStars from './RatingStars.vue'
import HueIcon from './HueIcon.vue'
import type { VariantMeta } from '../lib/types'
import { catalog } from '../lib/catalog'
import { isUserRecipeId, showNewBadge } from '../lib/userRecipes'
import { ICON_ROLES, ingredientRole, mealRole } from '../lib/palette'
import { useFavouritesStore } from '../stores/favourites'
import { Clock, Heart } from 'lucide-vue-next'

const props = defineProps<{ meta: VariantMeta }>()

const favourites = useFavouritesStore()

/** Categorical ingredient-TYPE hue (ADR-0036); null when the catalog
 *  publishes no category we have a hue for — no icon beats a wrong hue. */
const typeRole = computed(() =>
  ingredientRole(catalog.value?.dataById.get(props.meta.id)?.category_name),
)

/**
 * Meal OCCASION hue (ADR-0043) — a SEPARATE family from the ingredient
 * type above, because "dinner" and "contains meat" are different
 * questions and one colour must not answer both. Null for a ruleset we
 * have no hue for (today only `cpg`), and then the row simply shows no
 * occasion icon: an absent fact is better than a guessed colour.
 */
const mealTypeRole = computed(() => mealRole(props.meta.ruleset))

const isFavourite = computed(() => favourites.isFavourite(props.meta.id))

/**
 * ADR-0054: the NEW badge — this card's recipe was authored by the
 * household, and was added less than `NEW_BADGE_DAYS` ago.
 *
 * Two things it deliberately does NOT say. It does not say "Mealime"
 * (the source filter already owns that question, and a card is not where
 * a catalog's provenance gets explained) and it does not borrow the PRO
 * badge's warning colour, which would read as "something is wrong with
 * this recipe". It reuses the PRO badge's SHAPE — same slot, same chip,
 * same type scale — so the two read as one family of corner marks, and
 * it takes the brand hue because "yours" is the brand's own claim, not a
 * caveat.
 *
 * `addedAt` comes from the artifact, not from `first_published_at` read
 * here: the catalog exposes the household's own timestamp, so the card
 * does not have to know which VariantMeta field was the honest one.
 */
const showNew = computed(() => {
  const c = catalog.value
  if (!c) return false
  if (!isUserRecipeId(props.meta.id, c.userRecipeIds)) return false
  return showNewBadge(c.userRecipeAddedAt.get(props.meta.id))
})
</script>

<template>
  <!-- No `group/htt` here (ADR-0044): the icon tooltip is anchored by a
  hit-test on the icon's own rect, not by an ancestor group — hovering
  the card must NOT open it. -->
  <!-- ADR-0068 level 1: an index card on the counter — paper fill, 1px
  keyline, NO shadow. Hover strengthens the keyline (desktop only); the
  card never lifts. -->
  <article
  class="group relative overflow-hidden rounded-xl bg-surface-raised ring-1 ring-border transition-shadow hovercap:hover:ring-border-strong"
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
  <!-- Corner marks sit on the photograph, so they ride the same
  espresso disc chrome as the photo controls (ADR-0067). -->
  <span
  v-if="showNew"
  class="absolute top-2 left-2 rounded bg-espresso px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-brand-soft"
  data-test="new-badge"
  >
  NEW
  </span>
  <span
  v-else-if="meta.is_pro"
  class="absolute top-2 left-2 rounded bg-espresso px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-warning-soft"
  >
  PRO
  </span>
  <!-- A REAL control above the card's stretched link: the heart is not
  nested inside the link, it stops propagation, and it carries its
  own 44px hit area (DESIGN.md Components/Selection). -->
  <!-- DESIGN.md photo-control: a solid ESPRESSO disc (roasted espresso,
  ADR-0067 — literal dark chrome over any photograph), white idle glyph,
  favourite-soft heart when selected. -->
  <button
  class="absolute top-2 right-2 z-10 flex size-11 items-center justify-center rounded-full bg-espresso text-on-brand"
  :aria-label="isFavourite ? 'Remove from favourites' : 'Add to favourites'"
  :aria-pressed="isFavourite"
  @click.stop="favourites.toggleFavourite(meta.id)"
  >
  <Heart
  :size="20"
  :fill="isFavourite ? 'currentColor' : 'none'"
  :class="isFavourite ? 'text-favourite-soft' : ''"
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

  <!-- Compact facts: TYPE, meal OCCASION, energy and time. Sodium is
  deliberately absent — it belongs to the recipe's nutrition detail, not
  to a glanceable browse tile. Both icons carry their own name
  (role="img") and neither redundant word is printed beside them. The
  occasion is a different question from the ingredient type, so it wears
  its own hue family (ADR-0043). -->
  <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label-md text-text-muted">
  <span v-if="typeRole" class="flex items-center">
  <HueIcon :role="typeRole" :size="16" :label="ICON_ROLES[typeRole].label" />
  </span>
  <span v-if="mealTypeRole" class="flex items-center">
  <HueIcon :role="mealTypeRole" :size="16" :label="ICON_ROLES[mealTypeRole].label" />
  </span>
  <!-- The DATA voice (ADR-0066): quantities and times render in
  JetBrains Mono with tabular numerals — never prose. -->
  <span class="flex items-center gap-1 whitespace-nowrap font-mono-data tabular-nums" data-test="card-energy">
  <HueIcon role="energy" :size="16" />{{ Math.round(meta.calories) }} kcal
  </span>
  <span class="flex items-center gap-1 whitespace-nowrap font-mono-data tabular-nums" data-test="card-time">
  <Clock :size="16" aria-hidden="true" />{{ meta.cooking_minutes }} min
  </span>
  </p>

  <div class="relative z-10 mt-1.5">
  <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="15" compact />
  </div>
  </div>
  </article>
</template>