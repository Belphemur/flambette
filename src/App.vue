<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDark, useToggle } from '@vueuse/core'
import {
  CircleAlert,
  CircleDashed,
  CircleDot,
  Moon,
  Sun,
  TriangleAlert,
} from 'lucide-vue-next'
import { TABS, useUiStore } from './stores/ui'
import { getCatalog } from './lib/catalog'
import { decodePlan } from './lib/share'
import { useShareRoomLink } from './composables/useShareRoomLink'
import { usePlanStore } from './stores/plan'
import { useRoomStore, type RoomStatus } from './stores/room'
import { initFavourites } from './stores/favourites'

const reload = () => location.reload()

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const plan = usePlanStore()
const room = useRoomStore()
const { shareAction } = useShareRoomLink()

/** Dark mode: follows the system preference until the user overrides it
 *  (the override persists in localStorage via useDark). */
const isDark = useDark({
  selector: 'html',
  attribute: 'class',
  valueDark: 'dark',
  valueLight: 'light',
})
const toggleDark = useToggle(isDark)

const loading = ref(true)
const loadError = ref<string | null>(null)

/** Cooking and shopping are fullscreen focus modes: no app header, no bottom nav. */
const isCooking = computed(() => route.name === 'cooking')
const isShopping = computed(() => route.name === 'shop')
const isFullscreenMode = computed(() => isCooking.value || isShopping.value)

/** Room status chip shown in the header while sharing a live room. */
const ROOM_STATUS_ICONS: Record<RoomStatus, Component> = {
  live: CircleDot,
  connecting: CircleDashed,
  error: TriangleAlert,
  idle: TriangleAlert,
}
const ROOM_STATUS_CLS: Record<RoomStatus, string> = {
  // Status is NOT food identity (DESIGN.md): a live room keeps the calm
  // primary foreground and relies on the glyph (CircleDot) + the "Live"
  // label for its signal; amber is reserved for the failure states.
  live: 'text-text',
  connecting: 'text-text-muted',
  error: 'text-warning',
  idle: 'text-warning',
}

const roomChip = computed(() => {
  if (!room.inRoom) return null
  const status = room.status
  const labels: Record<RoomStatus, string> = {
  live: 'Live',
  connecting: 'Connecting',
  error: 'Offline',
  idle: 'Offline',
  }
  return {
  icon: ROOM_STATUS_ICONS[status],
  label: labels[status],
  cls: ROOM_STATUS_CLS[status],
  code: room.code,
  }
})

/** The recipe detail view is full-bleed (edge-to-edge hero image). */
const isRecipe = computed(() => route.name === 'recipe')

/** Import a shared plan from `?p=` (replaces the current plan). */
async function importSharedPlan() {
  const p = route.query.p
  if (typeof p !== 'string' || p === '') return
  const shared = await decodePlan(p)
  if (shared) {
  plan.replacePlan(shared.entries, shared.custom)
  ui.showToast('Plan loaded from link')
  } else {
  ui.showToast("Couldn't load the shared plan")
  }
  // Strip the param so a reload doesn't re-import (the plan persists).
  void router.replace({ query: {} })
}

/** Join a live room from `?room=CODE` (applies the room's shared state). */
async function joinRoomFromLink() {
  const roomCode = route.query.room
  if (typeof roomCode !== 'string' || roomCode === '') return
  room.join(roomCode)
  ui.showToast('Joining live room…')
  // Strip the param so a reload doesn't re-join from the URL.
  void router.replace({ query: {} })
}

/**
 * ADR-0019: the saved household room joins itself on every start, so the
 * daily two-phone flow needs no share link. A session resume (room store)
 * or an explicit `?room=` link wins; a failed join only toasts and never
 * blocks the app — the retry happens on the next launch.
 */
function autoJoinHousehold() {
  const code = ui.householdRoom
  if (!code || room.inRoom || room.status !== 'idle') return
  room.join(code)
  // The toast doubles as the share affordance: the second phone gets the
  // link straight from this confirmation (ADR-0023).
  ui.showToast(`Household sync active — ${code}`, {
  kind: 'household',
  actions: [shareAction(code)],
  duration: 6000,
  })
}

// A room we can't reach (relay down, code expired after a relay restart)
// is reported, never fatal: the UI keeps working offline and the next app
// start retries.
watch(
  () => [room.status, room.error] as const,
  ([status, error]) => {
  if (status !== 'error' || !error) return
  // A household sync failure is only meaningful when the failing room IS
  // the household room (qodo phase 18); a bad ?room= link or a Plan-tab
  // room gets the generic live-room message instead.
  if (ui.householdRoom && room.code === ui.householdRoom) {
  ui.showToast(`Household sync unavailable — ${error}. Will retry next launch.`, {
  kind: 'household',
  duration: 6000,
  })
  } else {
  ui.showToast(`Live room unavailable — ${error}.`, { duration: 6000 })
  }
  },
)

onMounted(async () => {
  await router.isReady()
  // Resume a room from a previous page load; a fresh ?room= link wins.
  if (!room.resume()) void joinRoomFromLink()
  void importSharedPlan()
  try {
  await getCatalog()
  loading.value = false
  void initFavourites()
  } catch (e) {
  loadError.value = e instanceof Error ? e.message : String(e)
  }
  // Config is loaded: re-join the household room unless this launch is
  // already in one (session resume / ?room= link).
  autoJoinHousehold()
})
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-app flex-col" data-test="app-shell">
  <header
  v-if="!isFullscreenMode"
  class="sticky top-0 z-20 border-b border-border bg-surface-raised"
  >
  <div class="flex items-center justify-between px-4 py-2">
  <h1 class="flex items-center gap-2 py-1 text-lg font-bold tracking-tight text-brand-text">
  <img src="/favicon.svg" alt="" width="22" height="22" class="inline" />
  Flambette
  </h1>
  <div class="flex items-center gap-2">
  <span
  v-if="roomChip"
  class="flex items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium"
  :class="roomChip.cls"
  :title="roomChip.code ? `Live room ${roomChip.code}` : room.error ?? undefined"
  data-test="room-chip"
  >
  <component :is="roomChip.icon" :size="14" aria-hidden="true" />
  {{ roomChip.label }}
  </span>
  <button
  class="flex size-11 items-center justify-center rounded-full text-xl transition-colors hover:bg-surface-sunken"
  :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
  @click="toggleDark()"
  >
  <!-- The icon shows the mode you would switch TO, so it always
  agrees with the aria-label below, exactly as the emoji
  pair it replaced did: sun while dark ("Switch to light
  mode"). -->
  <Sun v-if="isDark" :size="20" aria-hidden="true" />
  <Moon v-else :size="20" aria-hidden="true" />
  </button>
  </div>
  </div>
  </header>

  <main v-if="loadError" class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
  <CircleAlert :size="40" class="mx-auto" aria-hidden="true" />
  <p class="font-semibold">Couldn't load the recipe catalog</p>
  <p class="text-sm text-text-muted">{{ loadError }}</p>
  <button class="mt-2 rounded-lg bg-brand px-4 py-2 font-semibold text-on-brand" @click="reload()">
  Retry
  </button>
  </main>

  <main v-else-if="loading" class="flex flex-1 items-center justify-center">
  <div class="size-8 animate-spin rounded-full border-4 border-border border-t-brand" role="status">
  <span class="sr-only">Loading…</span>
  </div>
  </main>

  <main
  v-else
  class="flex-1"
  :class="isRecipe || isFullscreenMode ? '' : 'px-4 pt-4 pb-28'"
  >
  <RouterView v-slot="{ Component }">
  <KeepAlive include="RecipesTab,PlanTab,GroceryTab,SettingsTab">
  <component :is="Component" />
  </KeepAlive>
  </RouterView>
  </main>

  <Transition name="toast">
  <div
  v-if="ui.toast"
  role="status"
  class="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-dark px-4 py-2 text-sm font-medium text-on-brand shadow-lg"
  :data-test="ui.toast.kind ? `${ui.toast.kind}-toast` : 'toast'"
  >
  <span>{{ ui.toast.message }}</span>
  <button
  v-for="(action, i) in ui.toast.actions ?? []"
  :key="action.label"
  class="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
  :class="i === 0 ? 'bg-brand text-on-brand' : 'text-text-dark-muted hover:text-on-brand'"
  :data-test="action.testId ?? (i === 0 ? 'toast-action-primary' : 'toast-action-secondary')"
  @click="action.run()"
  >
  {{ action.label }}
  </button>
  </div>
  </Transition>

  <nav
  v-if="!isFullscreenMode"
  class="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-raised"
  aria-label="Main navigation"
  >
  <div class="mx-auto flex max-w-app">
  <button
  v-for="tab in TABS"
  :key="tab.id"
  class="nav-tab flex min-h-14 flex-1 flex-col items-center justify-center gap-1 pt-1.5 text-label-md font-medium transition-colors"
  :class="route.path === tab.to ? 'text-brand-text' : 'text-text-muted'"
  :aria-current="route.path === tab.to ? 'page' : undefined"
  @click="router.push(tab.to)"
  >
  <!-- A tinted icon BACKPLATE marks the active tab (DESIGN.md
  Navigation): a colour change alone is too quiet, and the
  backplate never resizes the tab or moves the label. -->
  <span
  class="flex h-8 w-14 items-center justify-center rounded-full transition-colors"
  :class="route.path === tab.to ? 'bg-brand-tint' : ''"
  >
  <component
  :is="tab.icon"
  :size="22"
  aria-hidden="true"
  class="nav-tab-icon leading-none"
  />
  </span>
  {{ tab.label }}
  </button>
  </div>
  </nav>
  </div>
</template>
