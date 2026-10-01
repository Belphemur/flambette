<script setup lang="ts">
import { computed } from 'vue'
import { imageSrc, onImgError } from '../lib/images'
import RatingStars from './RatingStars.vue'
import HueIcon from './HueIcon.vue'
import type { VariantMeta } from '../lib/types'
import { catalog } from '../lib/catalog'
import { ICON_HUES, ingredientRole } from '../lib/palette'
import { useFavouritesStore } from '../stores/favourites'
import { useRouter } from 'vue-router'
import { Clock, Heart } from 'lucide-vue-next'

const props = defineProps<{ meta: VariantMeta }>()

const favourites = useFavouritesStore()
const router = useRouter()

/** Categorical ingredient-TYPE hue (ADR-0035); null when the catalog
 *  publishes no category we have a hue for — no icon beats a wrong hue. */
const typeRole = computed(() =>
  ingredientRole(catalog.value?.dataById.get(props.meta.id)?.category_name),
)

function openDetail() {
  void router.push({ name: 'recipe', params: { id: String(props.meta.id) } })
}
</script>

<template>
  <article
    class="group relative hovercap:cursor-pointer overflow-hidden rounded-xl dark:bg-stone-900 shadow-sm ring-1 dark:ring-stone-700 transition-shadow hover:shadow-md"
    data-test="recipe-card"
    :data-variant-id="meta.id"
    @click="openDetail"
  >
    <div class="relative">
      <img
        :src="imageSrc(meta.thumbnail_image_url)"
        :alt="meta.name"
        loading="lazy"
        @error="onImgError"
        class="aspect-[4/3] w-full dark:bg-stone-800 object-cover"
      />
      <span
        v-if="meta.is_pro"
        class="absolute top-2 left-2 rounded bg-stone-900/80 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-300"
      >
        PRO
      </span>
      <button
        class="absolute top-1.5 right-1.5 flex size-9 items-center justify-center rounded-full bg-stone-900/70 shadow backdrop-blur-sm transition-transform active:scale-90"
        :aria-label="favourites.isFavourite(meta.id) ? 'Remove from favourites' : 'Add to favourites'"
        @click.stop="favourites.toggleFavourite(meta.id)"
      >
        <Heart
          :size="18"
          :fill="favourites.isFavourite(meta.id) ? 'currentColor' : 'none'"
          :class="favourites.isFavourite(meta.id) ? 'text-rose-500' : 'text-white/90'"
          aria-hidden="true"
        />
      </button>
    </div>
    <div class="p-3">
      <h3 class="line-clamp-2 min-h-10 text-sm leading-5 font-semibold">{{ meta.name }}</h3>
      <p class="mt-1.5 flex items-center gap-3 text-xs dark:text-stone-400 lg:hidden">
        <span class="flex items-center gap-1">
          <HueIcon role="energy" :size="14" />{{ meta.calories }} kcal
        </span>
        <span class="flex items-center gap-1">
          <Clock :size="14" aria-hidden="true" />{{ meta.cooking_minutes }} min
        </span>
      </p>
      <!-- Desktop metadata band (ADR-0035): the freed width of the wider
           container pays for ONE horizontal row — ingredient TYPE, energy,
           time and sodium — instead of the two cramped items the phone
           has room for. It only exists from `lg` up, so the mobile card
           layout, padding and tap targets are untouched. -->
      <p
        v-if="typeRole || meta.sodium_mg"
        class="mt-2 hidden items-center gap-3 rounded-lg bg-stone-100 px-2 py-1.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400 lg:flex"
        data-test="recipe-meta-band"
      >
        <span v-if="typeRole" class="flex items-center gap-1" :data-test="`recipe-type-${typeRole}`">
          <HueIcon :role="typeRole" :size="14" />{{ ICON_HUES[typeRole].label }}
        </span>
        <span class="flex items-center gap-1">
          <HueIcon role="energy" :size="14" />{{ meta.calories }} kcal
        </span>
        <span class="flex items-center gap-1">
          <Clock :size="14" aria-hidden="true" />{{ meta.cooking_minutes }} min
        </span>
        <span v-if="meta.sodium_mg" class="flex items-center gap-1">
          <HueIcon role="sodium" :size="14" />{{ Math.round(meta.sodium_mg) }} mg
        </span>
      </p>
      <div class="mt-1.5">
        <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="15" compact />
      </div>
    </div>
  </article>
</template>
