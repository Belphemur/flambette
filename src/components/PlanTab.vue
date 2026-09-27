<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useClipboard } from '@vueuse/core'
import { catalog } from '../lib/catalog'
import { imageSrc, onImgError } from '../lib/images'
import { planShareUrl } from '../lib/share'
import { applyBackup, backupFileName, buildBackupZip } from '../lib/backup'
import type { VariantMeta } from '../lib/types'
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

/* ---------- Backup & restore (ADR-0013) ---------- */

const backupInput = ref<HTMLInputElement | null>(null)

/** File staged for import: shown in the confirm dialog before it is applied. */
const pendingBackup = ref<File | null>(null)
const backupConfirmOpen = computed(() => pendingBackup.value !== null)

function downloadBackup(): void {
  const blob = new Blob([buildBackupZip() as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = backupFileName()
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  ui.showToast('Backup downloaded')
}

/** Validate + apply happens ONLY after the user confirms; a rejected file
 *  (bad json / wrong app tag) mutates nothing (atomic apply). */
function confirmBackupImport(): void {
  const file = pendingBackup.value
  if (!file) return
  pendingBackup.value = null
  void file
    .arrayBuffer()
    .then((buf) => applyBackup(new Uint8Array(buf)))
    .then((result) => {
      if (!result.ok) {
        ui.showToast(`Couldn't import backup — ${result.error}`)
        return
      }
      const c = result.counts ?? { plans: 0, items: 0, history: 0, ingredients: 0, checks: 0, favourites: 0 }
      ui.showToast(`Backup restored — ${c.plans} plans, ${c.items} items`)
    })
}

function onBackupInputChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // re-selecting the same file must fire change again
  if (file) pendingBackup.value = file
}

function cancelBackupImport(): void {
  pendingBackup.value = null
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
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:text-primary"
            :aria-label="`Mark ${meal.meta.name} as cooked`"
            data-test="mark-cooked"
            @click="plan.markCooked(meal.meta.id)"
          >
            ✓
          </button>
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
          class="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-white shadow-sm active:bg-primary-dark"
          title="Share your plan via a link or a live room"
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
              :disabled="shareUrl === null"
              data-test="copy-share-link"
              @click="copyShareUrl"
            >
              {{ copied ? '✓ Copied' : 'Copy one-time link' }}
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
            Share your plan live: everyone sees plan and grocery changes instantly, both ways.
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
              <span class="block text-xs dark:text-stone-400">Off by default — opt in to sync your “cooked” log with everyone.</span>
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
                {{ copied ? '✓ Copied' : 'Copy room link' }}
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
            {{ room.status === 'connecting' ? 'Starting…' : '⏺ Start live room' }}
          </button>
        </div>

        <!-- Backup & restore (ADR-0013) -->
        <div class="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-950">
          <span class="text-sm font-bold tracking-tight">Backup &amp; restore</span>
          <p class="text-xs dark:text-stone-400">
            Save everything (plan, groceries, history, favourites, settings) to a file — or restore one. Works fully offline.
          </p>
          <div class="flex gap-2">
            <button
              class="flex h-11 flex-1 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark"
              data-test="export-settings"
              aria-label="Download backup file"
              @click="downloadBackup"
            >
              ⬇ Export backup
            </button>
            <button
              class="flex h-11 flex-1 items-center justify-center rounded-xl border dark:border-stone-700 px-4 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800"
              data-test="import-settings"
              aria-label="Choose a backup file to restore"
              @click="backupInput?.click()"
            >
              ⬆ Import backup
            </button>
          </div>
          <input
            ref="backupInput"
            type="file"
            accept="application/zip,.zip"
            class="hidden"
            aria-label="Backup file picker"
            data-test="import-settings-input"
            @change="onBackupInputChange"
          />
        </div>
        <!-- Import-backup confirm dialog -->
        <div
          v-if="backupConfirmOpen"
          class="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 p-4"
          @click.self="cancelBackupImport"
        >
          <div
            class="w-full max-w-md space-y-3 rounded-2xl bg-white p-4 shadow-xl dark:bg-stone-900"
            role="dialog"
            aria-label="Confirm backup restore"
          >
            <h3 class="text-sm font-bold tracking-tight">Restore this backup?</h3>
            <p class="text-xs dark:text-stone-400">
              This overwrites your current plan, checked items, cooked history, favourites, custom ingredients and settings with the backup’s contents.
            </p>
            <p class="truncate text-xs dark:text-stone-500">
              {{ pendingBackup?.name }}
            </p>
            <div class="flex gap-2">
              <button
                class="h-11 flex-1 rounded-xl border dark:border-stone-700 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800"
                data-test="import-settings-cancel"
                aria-label="Cancel restore"
                @click="cancelBackupImport"
              >
                Cancel
              </button>
              <button
                class="h-11 flex-1 rounded-xl bg-primary text-sm font-semibold text-white active:bg-primary-dark"
                data-test="import-settings-confirm"
                aria-label="Restore backup"
                @click="confirmBackupImport"
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </Teleport>
  </section>
</template>
