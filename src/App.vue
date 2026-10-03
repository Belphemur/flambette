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
import { appVersion } from './lib/appVersion'
import { homeSeoHead } from './lib/seo'
import { normalizeRoomCode } from './lib/roomWords'
import { useHead } from '@unhead/vue'
import JoinCongratsModal from './components/JoinCongratsModal.vue'

/**
 * The app-level DEFAULT head (ADR-0048). Every app-shell route is served
 * the same SPA fallback HTML, so it all shares this one head — canonical
 * to the homepage, which is the duplicate-content defence for /plan,
 * /grocery, /settings … Route components layer their own scoped entries
 * over it; Unhead drops those on unmount and this default resurfaces.
 *
 * The strings come from `homeSeoHead()` — the SAME builder the
 * prerenderer writes into `dist/index.html`, so a crawler and the
 * hydrating app cannot disagree.
 */
useHead(homeSeoHead())

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
  // Status is NOT food identity (DESIGN.md): a live room gets the status
  // family's `success` green — a dot beside the word — while the chip's own
  // text keeps the calm primary foreground. Amber stays reserved for the
  // failure states, so the green can never read as a warning, nor as a
  // dietary cue: hue-vegetarian / hue-vegan are deliberately OTHER greens
  // (ADR-0049).
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
  const code = room.code
  const peers = room.peers
  /**
   * The one sentence the chip states about itself, used in TWO places: the
   * tooltip bubble and the aria-label. Derived once so they cannot drift,
   * and it is the e2e handle now that the native `title` is gone (ADR-0049).
   *
   * A headcount of `null` is a real third state — this device has not been
   * told yet — so it is phrased as absence rather than as a number. A
   * device that is still connecting is not a household of one.
   */
  const detail: Record<RoomStatus, string> = {
    live: peers === null ? `Live room ${code}` : `Live room ${code} (${peers} in room)`,
    connecting: 'Connecting to the household…',
    error: `Offline — ${room.error ?? 'not connected'}`,
    idle: 'Offline — not connected',
  }
  const description = detail[status]
  return {
    icon: ROOM_STATUS_ICONS[status],
    label: labels[status],
    cls: ROOM_STATUS_CLS[status],
    /** The green dot is a LIVE-only signal (ADR-0049). */
    dot: status === 'live',
    description,
    code,
  }
})

/** The recipe detail view is full-bleed (edge-to-edge hero image). */
const isRecipe = computed(() => route.name === 'recipe')

/** Clicking the header logo always returns to the recipes list (the
 * homepage). ADR-0048: app-shell routes share one head, so the recipes
 * route is the canonical home — never navigate away from it when already
 * there. */
function goHome() {
  if (route.name === 'recipes') {
    // Same page: scroll to top instead of a no-op navigation.
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  } else {
    void router.push({ name: 'recipes', query: route.query.room ? {} : undefined })
  }
}

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
  const canonical = normalizeRoomCode(roomCode)
  room.join(roomCode)
  ui.showToast('Joining live room…')
  /**
   * Remember that this join came from a LINK, and for which code, so the
   * congrats modal knows who to thank (ADR-0049). Captured HERE, before
   * the query is stripped below — by the time a `joined` frame arrives the
   * URL is long gone, and a household auto-join (ADR-0019) must NOT open
   * this modal: nobody handed that device a link, so there is nobody to
   * congratulate. An unusable code is not remembered at all, so a broken
   * link toasts and stays silent.
   */
  linkJoinCode.value = canonical || null
  // Strip the param so a reload doesn't re-join from the URL.
  void router.replace({ query: {} })
}

/** The code a shared link asked for; `null` for every other join. */
const linkJoinCode = ref<string | null>(null)
/** The code the congrats modal is celebrating; `null` while it is closed. */
const congratsCode = ref<string | null>(null)

watch(
  () => [room.status, room.code] as const,
  ([status, code]) => {
    if (!linkJoinCode.value) return
    // BOTH conditions: live, AND live in the code the link named. A
    // reconnect into some other room must not claim a join that never
    // happened.
    if (status !== 'live' || code !== linkJoinCode.value) return
    congratsCode.value = code
    linkJoinCode.value = null
  },
)

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
  <button
  type="button"
  data-test="home-link"
  class="flex items-center gap-2 py-1 text-lg font-bold tracking-tight text-brand-text"
  :aria-label="route.name === 'recipes' ? 'Back to top of recipes' : 'Recipes list'"
  @click="goHome()"
  >
  <img src="/favicon.svg" alt="" width="22" height="22" class="inline" aria-hidden="true" />
  Flambette
  </button>
  <div class="flex items-center gap-2">
  <span
  data-test="app-version"
  class="max-w-28 min-w-0 truncate text-xs text-text-muted"
  :title="`Version ${appVersion}`"
  >{{ appVersion }}</span>
  <span
  v-if="roomChip"
  class="group relative flex cursor-help items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium"
  :class="roomChip.cls"
  :aria-label="roomChip.description"
  data-test="room-chip"
  >
  <span
  v-if="roomChip.dot"
  class="size-2 shrink-0 rounded-full bg-success"
  data-test="room-chip-dot"
  aria-hidden="true"
  />
  <component :is="roomChip.icon" :size="14" aria-hidden="true" />
  {{ roomChip.label }}
  <!-- The PROPER tooltip, replacing the native `title` (ADR-0049). The OS
       one cannot be styled, does not appear on keyboard focus, and put a
       SECOND copy of the chip's meaning in a place that could drift from
       the aria-label. `focus-within` makes it reachable without a pointer;
       `pointer-events-none` keeps the bubble from swallowing a click on
       the chip, and `aria-hidden` keeps it out of the a11y tree because
       the chip's aria-label already says exactly this.
       Plain CSS on purpose: useIconHoverTarget exists for HueIcon, whose
       host is pointer-transparent and can never match :hover — this chip
       is an ordinary pointer-active element.

       HIDDEN MEANS `hidden`, NOT `invisible`, and the bubble is capped at
       `max-w-56` and anchored `right-0`. Both are load-bearing, and the
       first version got both wrong in a way that only showed up on a
       phone: `visibility: hidden` still occupies layout, so a
       `whitespace-nowrap` bubble centred with `left-1/2` beside the
       header's right edge overflowed the Pixel 7 viewport. That made the
       DOCUMENT horizontally scrollable, and a horizontally scrollable
       document breaks hit-testing for the `fixed` bottom nav — every
       tap on a nav tab silently became a no-op. `display: none`
       contributes nothing at all, exactly as HueIcon's bubble does. -->
  <span
  class="pointer-events-none absolute right-0 top-full z-30 mt-1.5 hidden w-max max-w-56 rounded-lg bg-surface-dark px-2 py-1 text-xs font-normal leading-snug text-text-dark shadow-md group-hover:block group-focus-within:block"
  data-test="room-chip-tooltip"
  role="tooltip"
  aria-hidden="true"
  >{{ roomChip.description }}</span>
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
  <!-- Arriving through a shared ?room= link (ADR-0049). Opened only once the
       room is LIVE and is the code the link named, so a household auto-join
       and a failed link both stay silent here. -->
  <JoinCongratsModal
  v-if="congratsCode"
  :code="congratsCode"
  @dismiss="congratsCode = null"
  />
</template>
