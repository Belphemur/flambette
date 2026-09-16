<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard } from '@vueuse/core'
import { catalog } from '../lib/catalog'
import { imageSrc, onImgError } from '../lib/images'
import { planShareUrl } from '../lib/share'
import type { VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useUiStore } from '../stores/ui'

const plan = usePlanStore()
const router = useRouter()
const ui = useUiStore()

/* ---------- Share sheet ---------- */

const shareSheetOpen = ref(false)
const shareUrl = ref<string | null>(null)
// legacy: true falls back to document.execCommand('copy') on insecure
// origins (plain-HTTP LAN IPs), where navigator.clipboard is undefined.
const { copy: copyText, copied } = useClipboard({ legacy: true, copiedDuring: 2000 })
const nativeShareSupported = typeof navigator.share === 'function'

// Recompute the share link whenever the plan changes; null = too large.
watch(
  () => [plan.plan, plan.customItems] as const,
  async () => {
    shareUrl.value = await planShareUrl(plan.plan, plan.customItems)
  },
  { immediate: true, deep: true },
)

async function openShareSheet() {
  shareUrl.value = await planShareUrl(plan.plan, plan.customItems)
  if (!shareUrl.value) {
    ui.showToast('Plan too large to share via URL')
    return
  }
  shareSheetOpen.value = true
}

function closeShareSheet() {
  shareSheetOpen.value = false
}

function copyShareUrl() {
  if (!shareUrl.value) return
  // useClipboard resolves even via the legacy path; reject -> toast.
  void copyText(shareUrl.value).catch(() => ui.showToast("Couldn't copy the link"))
}

async function nativeShare() {
  if (!shareUrl.value || !nativeShareSupported) return
  try {
    await navigator.share({
      title: 'My Mealime meal plan',
      text: 'Check out my meal plan!',
      url: shareUrl.value,
    })
    shareSheetOpen.value = false
  } catch {
    // User dismissed the native sheet — nothing to do.
  }
}

interface PlannedMeal {
  meta: VariantMeta
  servings: number
}

const meals = computed<PlannedMeal[]>(() => {
  const c = catalog.value
  if (!c) return []
  return plan.plan.flatMap((entry) => {
    const meta = c.byId.get(entry.variantId)
    return meta ? [{ meta, servings: entry.servings }] : []
  })
})

const totals = computed(() => ({
  meals: meals.value.length,
  calories: meals.value.reduce((sum, m) => sum + m.meta.calories * m.servings, 0),
  cookTime: meals.value.reduce((sum, m) => sum + m.meta.cooking_minutes, 0),
  servings: meals.value.reduce((sum, m) => sum + m.servings, 0),
}))

function openRecipe(id: number) {
  void router.push({ name: 'recipe', params: { id: String(id) } })
}
</script>
<template>
  <section class="space-y-3">
    <div v-if="meals.length === 0" class="py-16 text-center text-stone-400">
      <p class="text-4xl">🍽️</p>
      <p class="mt-2 font-medium">Your meal plan is empty</p>
      <p class="mt-1 text-sm">Add recipes from the Recipes tab to build your week.</p>
      <button
        class="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
        @click="router.push('/')"
      >
        Browse recipes
      </button>
    </div>

    <template v-else>
      <div class="grid grid-cols-3 gap-2 rounded-xl dark:bg-stone-900 p-4 text-center ring-1 dark:ring-stone-700">
        <div>
          <p class="text-lg font-bold text-primary-dark">{{ totals.meals }}</p>
          <p class="text-xs dark:text-stone-400">{{ totals.meals === 1 ? 'meal' : 'meals' }}</p>
        </div>
        <div>
          <p class="text-lg font-bold text-primary-dark">{{ Math.round(totals.calories).toLocaleString() }}</p>
          <p class="text-xs dark:text-stone-400">kcal total</p>
        </div>
        <div>
          <p class="text-lg font-bold text-primary-dark">{{ totals.cookTime }}</p>
          <p class="text-xs dark:text-stone-400">min to cook</p>
        </div>
      </div>

      <ul class="space-y-2">
        <li
          v-for="meal in meals"
          :key="meal.meta.id"
          class="flex items-center gap-3 rounded-xl dark:bg-stone-900 p-2.5 ring-1 dark:ring-stone-700"
        >
          <img
            :src="imageSrc(meal.meta.thumbnail_image_url)"
            :alt="meal.meta.name"
            loading="lazy"
            @error="onImgError"
            class="size-16 shrink-0 cursor-pointer rounded-lg dark:bg-stone-800 object-cover"
            @click="openRecipe(meal.meta.id)"
          />
          <div class="min-w-0 flex-1 cursor-pointer" @click="openRecipe(meal.meta.id)">
            <h3 class="line-clamp-2 text-sm font-semibold">{{ meal.meta.name }}</h3>
            <p class="mt-0.5 text-xs dark:text-stone-400">
              {{ Math.round(meal.meta.calories) }} kcal/serving ·
              {{ meal.meta.cooking_minutes }} min
              <span v-if="meal.meta.is_pro" class="ml-1 rounded bg-stone-900 px-1 py-px text-[10px] font-bold text-amber-300">PRO</span>
            </p>
          </div>
          <div class="flex shrink-0 items-center rounded-lg border dark:border-stone-700">
            <button
              class="flex size-9 items-center justify-center dark:text-stone-300"
              :disabled="meal.servings <= 1"
              :aria-label="`Fewer servings of ${meal.meta.name}`"
              @click="plan.setServings(meal.meta.id, meal.servings - 1)"
            >
              −
            </button>
            <span class="w-6 text-center text-xs font-semibold" aria-label="Servings">{{ meal.servings }}</span>
            <button
              class="flex size-9 items-center justify-center dark:text-stone-300"
              :aria-label="`More servings of ${meal.meta.name}`"
              @click="plan.setServings(meal.meta.id, meal.servings + 1)"
            >
              +
            </button>
          </div>
          <button
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-rose-600"
            :aria-label="`Remove ${meal.meta.name} from plan`"
            @click="plan.removeFromPlan(meal.meta.id)"
          >
            ✕
          </button>
        </li>
      </ul>

      <div class="flex gap-2">
        <button
          class="w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 py-3 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800"
          @click="plan.clearPlan"
        >
          Clear plan
        </button>
        <button
          class="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-white shadow-sm active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="shareUrl === null"
          :title="shareUrl === null ? 'Plan too large to share via URL' : 'Share your plan via a link'"
          @click="openShareSheet"
        >
          Share
        </button>
      </div>
    </template>

    <!-- Share sheet -->
    <Teleport to="body">
      <div
        v-if="shareSheetOpen"
        class="fixed inset-0 z-40 flex items-end justify-center bg-stone-900/50"
        @click.self="closeShareSheet"
      >
        <div
          class="w-full max-w-2xl space-y-3 rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl dark:bg-stone-900"
          role="dialog"
          aria-label="Share your meal plan"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold tracking-tight">Share your plan</h3>
            <button
              class="flex size-9 items-center justify-center rounded-full dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close share sheet"
              @click="closeShareSheet"
            >
              ✕
            </button>
          </div>
          <p class="text-xs dark:text-stone-400">
            Anyone with this link gets your current plan loaded into their app.
          </p>
          <input
            class="h-11 w-full rounded-lg border border-stone-200 bg-stone-50 px-3 text-xs text-stone-700 outline-none focus:border-primary dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300"
            type="text"
            readonly
            :value="shareUrl ?? ''"
            aria-label="Share link"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <div class="flex gap-2">
            <button
              class="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-amber-300 active:bg-stone-800 dark:bg-stone-800 dark:text-primary"
              data-test="copy-share-link"
              @click="copyShareUrl"
            >
              {{ copied ? '✓ Copied' : 'Copy link' }}
            </button>
            <button
              v-if="nativeShareSupported"
              class="flex h-11 flex-1 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark"
              @click="nativeShare"
            >
              Share…
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
