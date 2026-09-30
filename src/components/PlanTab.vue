<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard } from '@vueuse/core'
import {
  Check,
  CircleDot,
  Minus,
  Plus,
  Salad,
  UtensilsCrossed,
  X,
} from 'lucide-vue-next'
import { catalog } from '../lib/catalog'
import { imageSrc, onImgError } from '../lib/images'
import { MAX_MEALS, MIN_MEALS, type PackPlan } from '../lib/packPlanner'
import { planShareUrl } from '../lib/share'
import type { VariantMeta } from '../lib/types'
import { runAutoPlan } from '../composables/useAutoPlan'
import { usePlanStore } from '../stores/plan'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'

const plan = usePlanStore()
const room = useRoomStore()
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

function copyRoomLink() {
  const link = room.roomLink()
  if (!link) return
  void copyText(link).catch(() => ui.showToast("Couldn't copy the link"))
}

/* ---------- Live room ---------- */

const roomLink = computed(() => room.roomLink())

function startLiveRoom() {
  if (room.status === 'connecting') return
  room.create()
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

/* ---------- Auto-Plan (ADR-0024) ---------- */

const CATEGORIES = [
  { value: '', label: 'Any protein' },
  { value: 'meat', label: 'Meat' },
  { value: 'fish', label: 'Fish' },
  { value: 'vegetarian', label: 'Vegetarian' },
] as const

const autoPlanOpen = ref(false)
const autoPlanCount = ref(4)
const autoPlanCategory = ref<'' | 'meat' | 'fish' | 'vegetarian'>('')
const autoPlanBusy = ref(false)
// Ruleset + mode live in the UI STORE (persisted, ADR-0027); the dialog
// binds them through v-model on the store refs.
const RULESETS = [
  { value: 'dinner', label: 'Dinner' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'dessert', label: 'Dessert' },
  { value: 'any', label: 'Any' },
] as const
/** After Generate: the pending result awaiting the confirm step. */
const pendingPlan = ref<(PackPlan & { eligibleCount: number }) | null>(null)

function openAutoPlan() {
  pendingPlan.value = null
  autoPlanOpen.value = true
}

function closeAutoPlan() {
  autoPlanOpen.value = false
  pendingPlan.value = null
}

// Changed choices invalidate the confirmable pack: the visible result
// must always belong to the settings on screen (qodo thread 4).
watch(
  [
    autoPlanCount,
    autoPlanCategory,
    () => ui.autoPlanMode,
    () => ui.autoPlanRuleset,
  ],
  () => {
    pendingPlan.value = null
  },
)

async function generateAutoPlan() {
  if (autoPlanBusy.value) return
  autoPlanBusy.value = true
  // Pin the choices this run was made with; a result coming back after
  // the user changed any control is stale and must not apply.
  const wanted = {
    count: autoPlanCount.value,
    category: autoPlanCategory.value,
    ruleset: ui.autoPlanRuleset,
    mode: ui.autoPlanMode,
    generation: ui.nextAutoPlanGeneration(),
  }
  try {
    const result = await runAutoPlan({
      count: wanted.count,
      category: wanted.category || undefined,
      ruleset: wanted.ruleset,
      mode: wanted.mode,
      seedGeneration: wanted.generation,
    })
    if (
      wanted.count !== autoPlanCount.value ||
      wanted.category !== autoPlanCategory.value ||
      wanted.ruleset !== ui.autoPlanRuleset ||
      wanted.mode !== ui.autoPlanMode ||
      wanted.generation !== ui.nextAutoPlanGeneration()
    ) {
      return
    }
    pendingPlan.value = result
  } catch {
    ui.showToast("Couldn't load the planner — try again")
  } finally {
    autoPlanBusy.value = false
  }
}

/** Auto-Plan preview (WS6): the picked meals resolved to title + image so
 *  the user SEES the pack before replacing a hand-curated plan. Same
 *  catalog + image helpers the recipe cards use (offline, no new fetches). */
const pendingMeals = computed(() => {
  const ids = pendingPlan.value?.variantIds ?? []
  const c = catalog.value
  if (!c) return []
  return ids.flatMap((id) => {
    const meta = c.byId.get(id)
    return meta ? [{ id, name: meta.name, image: meta.thumbnail_image_url, minutes: meta.cooking_minutes }] : []
  })
})

/**
 * A preview tile is missing for a variant the catalog cannot resolve.
 * Confirming would then replace the plan with a meal the user never saw,
 * so the confirm button stays disabled until the preview is complete
 * (the counts line still reports the planner's own number).
 */
const previewComplete = computed(
  () =>
    !!pendingPlan.value &&
    // An EMPTY pack (pool exhausted under the active filters) must never
    // be confirmable: in replace mode it would erase the plan (qodo
    // round 1, thread 2).
    pendingPlan.value.variantIds.length > 0 &&
    pendingMeals.value.length === pendingPlan.value.variantIds.length,
)

/** Confirm/apply step: add mode APPENDS to the current plan (no
 *  destructive confirm needed); replace mode REPLACES it after the
 *  preview (confirm-before-destroy, unchanged from phase 19). */
function confirmAutoPlan() {
  const result = pendingPlan.value
  if (!result) return
  // An EMPTY pack (pool exhausted under the active filters) must never
  // apply: in replace mode replacePlan([]) would ERASE the user's plan
  // (qodo round 1, thread 2); in add mode it would be a no-op anyway.
  if (result.variantIds.length === 0) {
    ui.showToast(result.warnings?.[0] ?? 'No eligible recipes for this plan')
    closeAutoPlan()
    return
  }
  // Snapshot the plan AT CONFIRM TIME, not at dialog-open: a room update
  // may have changed the plan while generation was pending, and building
  // the entries from the stale open-time copy would discard it (qodo
  // round 1, thread 1). Undo restores this exact state.
  const atConfirm = plan.plan.map((e) => ({ ...e }))
  const clearedAtConfirm = { ...plan.clearedIngredients }
  const replacing = ui.autoPlanMode === 'replace'
  // Fresh planning = fresh ingredients: re-planning a meal must forget
  // any cleared-ingredient snapshot (same rule as addToPlan, ADR v0.4
  // clear semantics) or re-planned groceries stay hidden (qodo thread 2).
  for (const variantId of result.variantIds) plan.restoreIngredients(variantId)
  // ADD mode completes the current plan: base entries stay, additions
  // land exactly like hand-added ones (authored servings; ADR-0027).
  const entries = replacing
    ? result.variantIds.map((variantId) => ({ variantId, servings: 6 }))
    : [...atConfirm, ...result.variantIds.map((variantId) => ({ variantId, servings: 6 }))]
  plan.replacePlan(entries, plan.customItems)
  // The generation counter advances AFTER a successful apply so the next
  // run rotates the seed (ADR-0027).
  ui.advanceAutoPlanGeneration()
  // Undo restores the EXACT pre-apply state (ids + servings + the
  // cleared-ingredient map) from copies taken at confirm time — not from
  // the mutable dialog refs a later dialog open would overwrite
  // (qodo thread 3). Same semantics in BOTH modes.
  const undo = () => {
    plan.replacePlan(atConfirm, plan.customItems)
    plan.setClearedIngredients(clearedAtConfirm)
  }
  const warning = result.warnings?.[0]
  ui.showToast(
    warning
      ? `Plan generated — ${warning}`
      : replacing
        ? `Plan generated: ${result.variantIds.length} meals`
        : `${result.variantIds.length} meals added to your plan`,
    {
      actions: atConfirm.length > 0 || !replacing ? [{ label: 'Undo', run: undo, testId: 'auto-plan-undo' }] : undefined,
      duration: 6000,
      kind: 'autoplan-toast',
    },
  )
  closeAutoPlan()
}
</script>
<template>
  <section class="space-y-3">
    <div v-if="meals.length === 0" class="py-16 text-center text-stone-400">
      <UtensilsCrossed :size="40" class="mx-auto" aria-hidden="true" />
      <p class="mt-2 font-medium">Your meal plan is empty</p>
      <p class="mt-1 text-sm">Add recipes from the Recipes tab to build your week.</p>
      <div class="mt-4 flex items-center justify-center gap-2">
        <button
          class="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
          @click="router.push('/')"
        >
          Browse recipes
        </button>
        <button
          class="rounded-xl border border-primary px-4 py-2.5 text-sm font-semibold text-primary-dark dark:text-primary"
          data-test="auto-plan-button"
          @click="openAutoPlan"
        >
          <Salad :size="16" aria-hidden="true" class="mr-1 inline" />
          Auto-Plan
        </button>
      </div>
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
              <Minus :size="16" aria-hidden="true" />
            </button>
            <span class="w-6 text-center text-xs font-semibold" aria-label="Servings">{{ meal.servings }}</span>
            <button
              class="flex size-9 items-center justify-center dark:text-stone-300"
              :aria-label="`More servings of ${meal.meta.name}`"
              @click="plan.setServings(meal.meta.id, meal.servings + 1)"
            >
              <Plus :size="16" aria-hidden="true" />
            </button>
          </div>
          <button
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-primary"
            :aria-label="`Mark ${meal.meta.name} as cooked`"
            data-test="mark-cooked"
            @click="plan.markCooked(meal.meta.id)"
          >
            <Check :size="18" aria-hidden="true" />
          </button>
          <button
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-rose-600"
            :aria-label="`Remove ${meal.meta.name} from plan`"
            @click="plan.removeFromPlan(meal.meta.id)"
          >
            <X :size="18" aria-hidden="true" />
          </button>
        </li>
      </ul>

      <button
        class="w-full rounded-xl border border-primary py-3 text-sm font-semibold text-primary-dark dark:text-primary"
        data-test="auto-plan-button"
        @click="openAutoPlan"
      >
        <Salad :size="16" aria-hidden="true" class="mr-1 inline" />
        Auto-Plan
      </button>

      <div class="flex gap-2">
        <button
          class="w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 py-3 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800"
          @click="plan.clearPlan"
        >
          Clear plan
        </button>
        <button
          class="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-white shadow-sm active:bg-primary-dark"
          title="Share your plan via a link or a live room"
          @click="openShareSheet"
        >
          Share
        </button>
      </div>
    </template>

    <!-- Backup & restore used to live at the bottom of this tab (ADR-0013);
         it MOVED to the Settings tab (ADR-0016) — managing your data is not
         a plan concern, and here it sat under a list the user reads, not
         edits. The Plan tab keeps the share / live-room surface. -->

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
              <X :size="18" aria-hidden="true" />
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
              :disabled="shareUrl === null"
              data-test="copy-share-link"
              @click="copyShareUrl"
            >
              {{ copied ? 'Copied' : 'Copy one-time link' }}
            </button>
            <button
              v-if="nativeShareSupported"
              class="flex h-11 flex-1 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark"
              @click="nativeShare"
            >
              Share…
            </button>
          </div>
          <p v-if="shareUrl === null" class="text-xs text-amber-600 dark:text-amber-400">
            Plan too large for a one-time link — share it live instead.
          </p>

        <!-- Live room -->
        <div class="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-950">
          <div class="flex items-center gap-2">
            <span class="text-sm font-bold tracking-tight">Live room</span>
            <span
              class="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600 dark:bg-stone-800 dark:text-stone-300"
              >New</span
            >
          </div>
          <p class="text-xs dark:text-stone-400">
            Share your plan live: everyone sees plan, grocery and recipe-filter changes instantly, both ways.
          </p>
          <label
            class="flex items-start gap-2.5 py-1"
            title="Off by default — your cooked history stays personal unless you opt in"
          >
            <input
              type="checkbox"
              data-test="share-history-toggle"
              class="mt-0.5 size-4 accent-[color:var(--color-primary,#16a34a)]"
              :aria-label="`Share cooked history with room (${ui.shareCookedHistory ? 'on' : 'off, default'})`"
              v-model="ui.shareCookedHistory"
            />
            <span class="text-sm leading-tight">
              Share cooked history with room
              <span class="block text-xs dark:text-stone-400">Off by default — opt in to sync your “cooked” log with everyone. Also in Settings → Household sync.</span>
            </span>
          </label>
          <template v-if="room.inRoom">
            <input
              class="h-11 w-full rounded-lg border border-stone-200 bg-stone-50 px-3 text-xs text-stone-700 outline-none focus:border-primary dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300"
              type="text"
              readonly
              :value="roomLink ?? ''"
              aria-label="Live room link"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <div class="flex gap-2">
              <button
                class="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-amber-300 active:bg-stone-800 dark:bg-stone-800 dark:text-primary"
                data-test="copy-room-link"
                @click="copyRoomLink"
              >
                {{ copied ? 'Copied' : 'Copy room link' }}
              </button>
              <button
                class="h-11 rounded-xl border dark:border-stone-700 px-4 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800"
                data-test="leave-room"
                @click="room.leave()"
              >
                Leave room
              </button>
            </div>
          </template>
          <button
            v-else
            class="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
            data-test="start-room"
            :disabled="room.status === 'connecting'"
            @click="startLiveRoom"
          >
            <CircleDot v-if="room.status !== 'connecting'" :size="16" aria-hidden="true" />
            {{ room.status === 'connecting' ? 'Starting…' : 'Start live room' }}
          </button>
        </div>

      </div>
      </div>
    </Teleport>

    <!-- Auto-Plan dialog (ADR-0024): popover with count + category, then an
         explicit confirm step before REPLACING the (possibly hand-curated)
         plan. Undo restores the exact previous entries. -->
    <Teleport to="body">
      <div
        v-if="autoPlanOpen"
        class="fixed inset-0 z-40 flex items-end justify-center bg-stone-900/50"
        @click.self="closeAutoPlan"
      >
        <div
          class="w-full max-w-2xl space-y-4 rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl dark:bg-stone-900"
          role="dialog"
          aria-label="Generate an auto-plan"
          data-test="auto-plan-dialog"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold tracking-tight">Auto-Plan</h3>
            <button
              class="flex size-9 items-center justify-center rounded-full dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close auto-plan"
              @click="closeAutoPlan"
            >
              <X :size="18" aria-hidden="true" />
            </button>
          </div>
          <p class="text-xs dark:text-stone-400">
            Picks meals that share whole packages so you throw less away.
            Add mode completes your current plan and shares its groceries;
            replace swaps it — undo works right after either way.
          </p>

          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium" id="auto-plan-mode-label">Mode</span>
            <div
              class="flex rounded-lg border dark:border-stone-700"
              role="radiogroup"
              aria-labelledby="auto-plan-mode-label"
              data-test="auto-plan-mode"
            >
              <button
                v-for="m in [
                  { value: 'add', label: 'Add meals' },
                  { value: 'replace', label: 'Replace plan' },
                ]"
                :key="m.value"
                class="px-3 py-2 text-xs font-semibold first:rounded-l-lg last:rounded-r-lg"
                :class="ui.autoPlanMode === m.value ? 'bg-primary text-white' : 'dark:text-stone-300 dark:hover:bg-stone-800'"
                role="radio"
                :aria-checked="ui.autoPlanMode === m.value"
                :data-test="`auto-plan-mode-${m.value}`"
                @click="ui.autoPlanMode = m.value as 'add' | 'replace'"
              >
                {{ m.label }}
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3">
            <label class="text-sm font-medium" for="auto-plan-ruleset">Meal type</label>
            <select
              id="auto-plan-ruleset"
              data-test="auto-plan-ruleset"
              class="h-10 rounded-lg border border-stone-200 bg-stone-50 px-2 text-sm dark:border-stone-700 dark:bg-stone-950"
              v-model="ui.autoPlanRuleset"
            >
              <option v-for="r in RULESETS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </div>

          <div class="flex items-center justify-between gap-3">
            <label class="text-sm font-medium" for="auto-plan-count">Meals</label>
            <div class="flex items-center rounded-lg border dark:border-stone-700">
              <button
                class="flex size-10 items-center justify-center dark:text-stone-300 disabled:opacity-40"
                :disabled="autoPlanCount <= MIN_MEALS"
                aria-label="Fewer meals"
                data-test="auto-plan-count-minus"
                @click="autoPlanCount = Math.max(MIN_MEALS, autoPlanCount - 1)"
              >
                <Minus :size="18" aria-hidden="true" />
              </button>
              <input
                id="auto-plan-count"
                data-test="auto-plan-count"
                class="w-10 bg-transparent text-center text-sm font-semibold focus:outline-none"
                type="number"
                min="1"
                max="10"
                :value="autoPlanCount"
                aria-label="Number of meals"
                @change="autoPlanCount = Math.min(MAX_MEALS, Math.max(MIN_MEALS, Number(($event.target as HTMLInputElement).value) || MIN_MEALS))"
              />
              <button
                class="flex size-10 items-center justify-center dark:text-stone-300 disabled:opacity-40"
                :disabled="autoPlanCount >= MAX_MEALS"
                aria-label="More meals"
                data-test="auto-plan-count-plus"
                @click="autoPlanCount = Math.min(MAX_MEALS, autoPlanCount + 1)"
              >
                <Plus :size="18" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3">
            <label class="text-sm font-medium" for="auto-plan-category">Protein</label>
            <select
              id="auto-plan-category"
              data-test="auto-plan-category"
              class="h-10 rounded-lg border border-stone-200 bg-stone-50 px-2 text-sm dark:border-stone-700 dark:bg-stone-950"
              v-model="autoPlanCategory"
            >
              <option v-for="c in CATEGORIES" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </div>

          <button
            class="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-white active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
            data-test="auto-plan-generate"
            :disabled="autoPlanBusy"
            @click="generateAutoPlan"
          >
            {{ autoPlanBusy ? 'Generating…' : pendingPlan ? 'Regenerate' : 'Generate' }}
          </button>

          <div v-if="pendingPlan" class="ring-1 dark:ring-stone-700 rounded-xl p-3 space-y-2" data-test="auto-plan-preview">
            <p class="text-xs dark:text-stone-400">
              <template v-if="ui.autoPlanMode === 'add'">
                Adds {{ pendingPlan.variantIds.length }} new
                {{ pendingPlan.variantIds.length === 1 ? 'meal' : 'meals' }} to your plan —
              </template>
              <template v-else>
                Found a {{ pendingPlan.variantIds.length }}-meal pack —
              </template>
              the full plan buys {{ pendingPlan.packagesBought }}
              {{ pendingPlan.packagesBought === 1 ? 'package' : 'packages' }}
              ({{ pendingPlan.eligibleCount }} eligible recipes).
              <template v-if="ui.autoPlanMode === 'replace'">
                Replaces your current plan
                <template v-if="plan.plan.length > 0">({{ plan.plan.length }} meals)</template>.
              </template>
            </p>
            <p v-if="!previewComplete" class="text-xs text-amber-700 dark:text-amber-400">
              Showing {{ pendingMeals.length }} of {{ pendingPlan.variantIds.length }} meals — the rest are still
              loading, so this plan cannot be confirmed yet.
            </p>
            <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Meals in this auto-plan">
              <li
                v-for="meal in pendingMeals"
                :key="meal.id"
                class="overflow-hidden rounded-lg ring-1 dark:ring-stone-700"
                :data-test="`auto-plan-meal-${meal.id}`"
              >
                <img
                  :src="imageSrc(meal.image)"
                  :alt="meal.name"
                  loading="lazy"
                  @error="onImgError"
                  class="aspect-[4/3] w-full object-cover dark:bg-stone-800"
                />
                <p class="line-clamp-2 px-1.5 py-1 text-[11px] leading-tight font-medium" :title="meal.name">
                  {{ meal.name }}
                </p>
                <p class="px-1.5 pb-1 text-[10px] dark:text-stone-400">{{ meal.minutes }} min</p>
              </li>
            </ul>
            <div class="flex gap-2">
              <button
                class="h-10 flex-1 rounded-xl bg-primary text-sm font-semibold text-white active:bg-primary-dark"
                data-test="auto-plan-confirm"
                :disabled="!previewComplete"
                :title="previewComplete ? undefined : 'Waiting for the preview to load'"
                @click="confirmAutoPlan"
              >
                {{ ui.autoPlanMode === 'add' ? 'Add these meals' : 'Use this plan' }}
              </button>
              <button
                class="h-10 flex-1 rounded-xl border dark:border-stone-700 text-sm font-medium dark:text-stone-300"
                data-test="auto-plan-cancel"
                @click="pendingPlan = null"
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

  </section>
</template>
