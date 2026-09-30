<script setup lang="ts">
import { imageSrc, onImgError } from '../lib/images'
import RatingStars from './RatingStars.vue'
import type { VariantMeta } from '../lib/types'
import { useFavouritesStore } from '../stores/favourites'
import { useRouter } from 'vue-router'
import { Clock, Flame, Star } from 'lucide-vue-next'

const props = defineProps<{ meta: VariantMeta }>()

const favourites = useFavouritesStore()
const router = useRouter()

function openDetail() {
  void router.push({ name: 'recipe', params: { id: String(props.meta.id) } })
}
</script>

<template>
  <article
    class="group relative cursor-pointer overflow-hidden rounded-xl dark:bg-stone-900 shadow-sm ring-1 dark:ring-stone-700 transition-shadow hover:shadow-md"
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
        class="absolute top-1.5 right-1.5 flex size-11 items-center justify-center text-xl drop-shadow transition-transform active:scale-90"
        :aria-label="favourites.isFavourite(meta.id) ? 'Remove from favourites' : 'Add to favourites'"
        @click.stop="favourites.toggleFavourite(meta.id)"
      >
        <Star
          :size="22"
          :fill="favourites.isFavourite(meta.id) ? 'currentColor' : 'none'"
          :class="favourites.isFavourite(meta.id) ? 'text-amber-400' : 'text-white/80'"
          aria-hidden="true"
        />
      </button>
    </div>
    <div class="p-3">
      <h3 class="line-clamp-2 min-h-10 text-sm leading-5 font-semibold">{{ meta.name }}</h3>
      <p class="mt-1.5 flex items-center gap-3 text-xs dark:text-stone-400">
        <span class="flex items-center gap-1">
          <Flame :size="14" aria-hidden="true" />{{ meta.calories }} kcal
        </span>
        <span class="flex items-center gap-1">
          <Clock :size="14" aria-hidden="true" />{{ meta.cooking_minutes }} min
        </span>
      </p>
      <div class="mt-1.5">
        <RatingStars :variant-id="meta.id" :catalog-rating="meta.rating" :size="15" compact />
      </div>
    </div>
  </article>
</template>
