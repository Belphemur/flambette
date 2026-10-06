<script setup lang="ts">
import { computed, ref } from 'vue'
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
import { MAX_SERVINGS } from '../lib/servings'
import type { VariantMeta } from '../lib/types'
import { usePlanStore } from '../stores/plan'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'
import AutoPlanDialog from './AutoPlanDialog.vue'
import TooltipBubble from './TooltipBubble.vue'

const plan = usePlanStore()
const room = useRoomStore()
const router = useRouter()
const ui = useUiStore()

/** The Auto-Plan dialog is its OWN component (ADR-0046 §2.1); PlanTab
 *  keeps only the trigger buttons, which open it through `defineExpose`. */
const autoPlanDialog = ref<InstanceType<typeof AutoPlanDialog> | null>(null)

/* ---------- Share sheet ---------- */

const shareSheetOpen = ref(false)
// legacy: true falls back to document.execCommand('copy') on insecure
// origins (plain-HTTP LAN IPs), where navigator.clipboard is undefined.
const { copy: copyText, copied } = useClipboard({ legacy: true, copiedDuring: 2000 })

/**
 * The sheet is ROOM-ONLY since ADR-0051 retired one-shot `?p=` links: the
 * sheet no longer encodes a plan, so opening it is synchronous and cannot
 * fail on a plan that is too large to encode.
 */
function openShareSheet() {
  shareSheetOpen.value = true
}

function closeShareSheet() {
  shareSheetOpen.value = false
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

/**
 * Bump one planned meal's servings by `delta` and remember the new count
 * as the device default (ADR-0037).
 *
 * Scaling a meal up for a big dinner is the clearest possible statement of
 * "this is roughly how we cook", so it updates the default the same way the
 * detail stepper does. `-1` at the floor is a no-op for both the plan
 * entry and the default.
 *
 * The bound is applied to the PLAN ENTRY too, not just the memory: an
 * entry that ran to 100 while the default held 99 would be a value the
 * remembered default could never express, and the two would drift apart.
 */
function bumpServings(meal: PlannedMeal, delta: number) {
  const next = Math.min(MAX_SERVINGS, meal.servings + delta)
  if (next < 1) return
  plan.setServings(meal.meta.id, next)
  ui.setDefaultServings(next)
}

/** The `+` disables at the cap, matching the detail stepper. */
function canMore(meal: PlannedMeal): boolean {
  return meal.servings < MAX_SERVINGS
}

</script>
<template>
  <section class="space-y-3">
  <div v-if="meals.length === 0" class="py-16 text-center text-text-muted">
  <UtensilsCrossed :size="40" class="mx-auto" aria-hidden="true" />
  <p class="mt-2 font-medium">Your meal plan is empty</p>
  <p class="mt-1 text-sm">Add recipes from the Recipes tab to build your week.</p>
  <div class="mt-4 flex items-center justify-center gap-2">
  <button
  class="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand"
  @click="router.push('/')"
  >
  Browse recipes
  </button>
  <!-- Auto-Plan is the prominent route to building a plan, so it carries
       the ONE filled tomato on this surface; Share is secondary. -->
  <button
  class="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-on-brand shadow-sm active:bg-brand-strong"
  data-test="auto-plan-button"
  @click="autoPlanDialog?.open()"
  >
  <Salad :size="16" aria-hidden="true" class="mr-1 inline" />
  Auto-Plan
  </button>
  </div>
  </div>

  <template v-else>
  <div class="grid grid-cols-3 gap-2 rounded-xl p-4 text-center ring-1">
  <div>
  <p class="text-lg font-bold text-brand-text">{{ totals.meals }}</p>
  <p class="text-xs">{{ totals.meals === 1 ? 'meal' : 'meals' }}</p>
  </div>
  <div>
  <p class="text-lg font-bold text-brand-text">{{
  Math.round(totals.calories).toLocaleString()
  }}</p>
  <p class="text-xs">kcal total</p>
  </div>
  <div>
  <p class="text-lg font-bold text-brand-text">{{ totals.cookTime }}</p>
  <p class="text-xs">min to cook</p>
  </div>
  </div>

  <ul class="space-y-2">
  <li
  v-for="meal in meals"
  :key="meal.meta.id"
  class="rounded-xl ring-1"
  >
  <!-- 44px controls need ~230px; on a 390px phone that is more than half
  the row, so the control cluster WRAPS to its own line and the recipe
  name keeps the full width. `min-w-0 flex-1` is what actually stops the
  title collapsing to "Tus K…" beside the stepper. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-2.5">
  <img
  :src="imageSrc(meal.meta.thumbnail_image_url)"
  :alt="meal.meta.name"
  loading="lazy"
  @error="onImgError"
  class="size-16 shrink-0 hovercap:cursor-pointer rounded-lg object-cover"
  @click="openRecipe(meal.meta.id)"
  />
  <div class="min-w-[12rem] flex-1 hovercap:cursor-pointer" @click="openRecipe(meal.meta.id)">
  <h3 class="line-clamp-2 text-sm font-semibold">{{ meal.meta.name }}</h3>
  <p class="mt-0.5 text-xs">
  {{ Math.round(meal.meta.calories) }} kcal/serving ·
  {{ meal.meta.cooking_minutes }} min
  <span v-if="meal.meta.is_pro" class="ml-1 rounded bg-surface-dark px-1 py-px text-[10px] font-bold text-warning-soft">PRO</span>
  </p>
  </div>
  <div class="ml-auto flex shrink-0 items-center gap-1">
  <div class="flex shrink-0 items-center rounded-lg border">
  <button
  class="flex size-11 items-center justify-center"
  :disabled="meal.servings <= 1"
  :aria-label="`Fewer servings of ${meal.meta.name}`"
  @click="bumpServings(meal, -1)"
  >
  <Minus :size="16" aria-hidden="true" />
  </button>
  <span class="w-6 text-center text-xs font-semibold" aria-label="Servings">{{ meal.servings }}</span>
  <button
  class="flex size-11 items-center justify-center"
  :aria-label="`More servings of ${meal.meta.name}`"
  :disabled="!canMore(meal)"
  @click="bumpServings(meal, 1)"
  >
  <Plus :size="16" aria-hidden="true" />
  </button>
  </div>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-brand-text"
  :aria-label="`Mark ${meal.meta.name} as cooked`"
  data-test="mark-cooked"
  @click="plan.markCooked(meal.meta.id)"
  >
  <Check :size="18" aria-hidden="true" />
  </button>
  <button
  class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-favourite"
  :aria-label="`Remove ${meal.meta.name} from plan`"
  @click="plan.removeFromPlan(meal.meta.id)"
  >
  <X :size="18" aria-hidden="true" />
  </button>
  </div>
  </div>
  </li>
  </ul>

  <button
  class="w-full rounded-xl bg-brand py-3 text-sm font-semibold text-on-brand shadow-sm active:bg-brand-strong"
  data-test="auto-plan-button"
  @click="autoPlanDialog?.open()"
  >
  <Salad :size="16" aria-hidden="true" class="mr-1 inline" />
  Auto-Plan
  </button>

  <div class="flex gap-2">
  <button
  class="w-full rounded-xl border py-3 text-sm font-medium"
  @click="plan.clearPlan"
  >
  Clear plan
  </button>
  <button
  class="group relative w-full rounded-xl border py-3 text-sm font-medium hover:bg-surface-sunken"
  @click="openShareSheet"
  >
  Share
  <!-- ADR-0055: the OS title becomes the one bubble; a focusable button
  gets hover AND focus-within reveal. The bubble is a CHILD of the
  button — the button is the group host — and aria-hidden keeps it out
  of the button's accessible name (all specs locate it by role name
  'Share' exact). -->
  <TooltipBubble text="Share your plan via a link or a live room" placement="below-right" />
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
  class="fixed inset-0 z-40 flex items-end justify-center bg-surface-dark/50"
  @click.self="closeShareSheet"
  >
  <div
  class="w-full max-w-app space-y-3 rounded-t-2xl bg-surface-raised p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
  role="dialog"
  aria-label="Share your meal plan"
  >
  <div class="flex items-center justify-between">
  <h3 class="text-sm font-bold tracking-tight">Share your plan</h3>
  <button
  class="flex size-11 items-center justify-center rounded-full hover:bg-surface-sunken"
  aria-label="Close share sheet"
  @click="closeShareSheet"
  >
  <X :size="18" aria-hidden="true" />
  </button>
  </div>
  <p class="text-xs">
  One-time plan links were removed (ADR-0051). A live room is the one way to
  share now — and it syncs both ways, live, instead of a frozen snapshot.
  </p>

  <!-- Live room: the ONLY share path since ADR-0051 retired `?p=`. -->
  <div class="space-y-2 rounded-xl bg-surface p-3">
  <div class="flex items-center gap-2">
  <span class="text-sm font-bold tracking-tight">Live room</span>
  <span
  class="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-muted"
  >New</span
  >
  </div>
  <p class="text-xs">
  Share your plan live: everyone sees plan, grocery and recipe-filter changes instantly, both ways.
  </p>
  <label
  class="group relative flex items-start gap-2.5 py-1"
  >
  <!-- ADR-0055: the OS title becomes the one bubble; the checkbox in
  the label makes focus-within reachable. DESCENDANT of the group host
  (the label). -->
  <TooltipBubble
  text="On by default — turn it off to stop sharing future cooks (already-shared cooks stay in the room)"
  placement="below-right"
  />
  <input
  type="checkbox"
  data-test="share-history-toggle"
  class="mt-0.5 size-4 accent-brand"
  :aria-label="`Share cooked history with room (${ui.shareCookedHistory ? 'on, default' : 'off, opt-out'})`"
  v-model="ui.shareCookedHistory"
  />
  <span class="text-sm leading-tight">
  Share cooked history with room
  <span class="block text-xs">On by default — the room keeps one merged cooking log. Turn it off to stop sharing new cooks: already-shared cooks stay in the room. Also in Settings → Household sync.</span>
  </span>
  </label>
  <template v-if="room.inRoom">
  <input
  class="h-11 w-full rounded-lg border border-border bg-surface px-3 text-xs text-text-muted outline-none focus:border-brand-text"
  type="text"
  readonly
  :value="roomLink ?? ''"
  aria-label="Live room link"
  @focus="($event.target as HTMLInputElement).select()"
  />
  <div class="flex gap-2">
  <button
  class="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-dark px-4 text-sm font-semibold text-warning-soft active:bg-surface-dark-sunken"
  data-test="copy-room-link"
  @click="copyRoomLink"
  >
  {{ copied ? 'Copied' : 'Copy room link' }}
  </button>
  <button
  class="h-11 rounded-xl border px-4 text-sm font-medium"
  data-test="leave-room"
  @click="room.leave()"
  >
  Leave room
  </button>
  </div>
  </template>
  <button
  v-else
  class="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand active:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
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

  <!-- Auto-Plan dialog (ADR-0046 §2.1): its own component now; the
  trigger buttons above open it through `defineExpose`. -->
  <AutoPlanDialog ref="autoPlanDialog" />

  </section>
</template>
