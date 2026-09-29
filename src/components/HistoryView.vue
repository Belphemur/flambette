<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ChefHat } from 'lucide-vue-next'
import { catalog } from '../lib/catalog'
import { formatAbsolute, formatRelative, useCookHistory } from '../lib/history'
import { imageSrc, onImgError } from '../lib/images'
import type { VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const plan = usePlanStore()
const ui = useUiStore()
const cooked = useCookHistory()

/** Catalog meta attached to each aggregated row (missing recipes drop). */
interface Row {
  variantId: number
  count: number
  lastAt: number
  meta: VariantMeta
}

const rows = computed<Row[]>(() => {
  const c = catalog.value
  if (!c) return []
  return cooked.historyEntries.value.flatMap((e) => {
    const meta = c.byId.get(e.variantId)
    return meta ? [{ ...e, meta }] : []
  })
})

function openRecipe(id: number) {
  void router.push({ name: 'recipe', params: { id: String(id) } })
}

/** Re-plan the meal at its default servings — same flow as the detail view. */
function addToPlan(row: Row) {
  plan.addToPlan(row.meta, row.meta.serving_count)
  ui.showToast(`Added ${row.meta.name} to plan`)
}
</script>

<template>
  <section class="space-y-3" aria-label="Cooking history">
    <p class="text-xs text-stone-500 dark:text-stone-400" data-test="history-sync-note">
      Personal to this device by default (ADR-0011). Turn on
      <strong>“Also sync cooked history”</strong> in Settings → Household sync to share it with the room — history then
      syncs both ways, last write wins.
    </p>

    <div
      v-if="rows.length === 0"
      class="py-16 text-center text-stone-400"
      data-test="history-empty"
    >
      <ChefHat :size="40" class="mx-auto" aria-hidden="true" />
      <p class="mt-2 font-medium">Nothing cooked yet</p>
      <p class="mt-1 text-sm">Mark meals as cooked when you finish them.</p>
      <button
        class="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
        @click="router.push('/')"
      >
        Browse recipes
      </button>
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="row in rows"
        :key="row.variantId"
        class="flex items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700"
        data-test="history-row"
      >
        <img
          :src="imageSrc(row.meta.thumbnail_image_url)"
          :alt="row.meta.name"
          loading="lazy"
          class="size-16 shrink-0 cursor-pointer rounded-lg object-cover dark:bg-stone-800"
          @error="onImgError"
          @click="openRecipe(row.variantId)"
        />
        <div class="min-w-0 flex-1 cursor-pointer" @click="openRecipe(row.variantId)">
          <h3 class="line-clamp-2 text-sm font-semibold">{{ row.meta.name }}</h3>
          <p
            class="mt-0.5 text-xs text-stone-500 dark:text-stone-400"
            :title="formatAbsolute(row.lastAt)"
          >
            <span
              class="mr-1 rounded bg-primary/10 px-1.5 py-px text-[10px] font-bold text-primary-dark dark:bg-stone-800 dark:text-primary"
              :data-test="`history-count-${row.variantId}`"
            >
              {{ row.count === 1 ? 'cooked once' : `cooked ${row.count} times` }}
            </span>
            {{ formatRelative(row.lastAt) }}
          </p>
        </div>
        <button
          class="shrink-0 rounded-lg border border-stone-200 px-3 py-2 text-xs font-semibold text-primary-dark hover:bg-stone-50 dark:border-stone-700 dark:text-primary dark:hover:bg-stone-800"
          :aria-label="`Add ${row.meta.name} to plan`"
          :data-test="`history-add-${row.variantId}`"
          @click="addToPlan(row)"
        >
          Add to plan
        </button>
      </li>
    </ul>
  </section>
</template>
