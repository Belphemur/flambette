<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDark, useToggle } from '@vueuse/core'
import { CircleAlert, Moon, Sun, X } from 'lucide-vue-next'
import ChangelogModal from './components/ChangelogModal.vue'
import { checkVersion, type VersionState } from './lib/versionCheck'
import { TABS, useUiStore } from './stores/ui'
import { getCatalog } from './lib/catalog'
import { useShareRoomLink } from './composables/useShareRoomLink'
import { usePlanStore } from './stores/plan'
import { useRoomStore, type RoomStatus } from './stores/room'
import { initFavourites } from './stores/favourites'
import { appVersion } from './lib/appVersion'
import { homeSeoHead } from './lib/seo'
import { normalizeRoomCode } from './lib/roomWords'
import { useHead } from '@unhead/vue'
import JoinCongratsModal from './components/JoinCongratsModal.vue'
import TooltipBubble from './components/TooltipBubble.vue'

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

/**
 * The header room chip: a status DOT and its WORD (ADR-0049 addenda).
 *
 * The owner's first ruling dropped the icon and the word — "Live shouldn't
 * have the green dot and an icon, just the green dot is enough" — and the
 * dot-only chip shipped. After living with it, the owner reversed the word
 * half: "We also need to keep the text Live next to the green dot." So the
 * chip is [dot | badge] + word, with NO icon: the icon was the one element
 * whose content duplicated the word, and it stays gone. The dot borrows the
 * status family (never the food-hue family): `success` green is live,
 * `warning` amber is offline, and a muted dot is the quiet in-between.
 * `hue-vegetarian` / `hue-vegan` are deliberately OTHER greens, so a live
 * room can never read as a dietary cue (DESIGN.md).
 *
 * These are LITERAL class strings because Tailwind scans source text for
 * complete class names.
 */
const ROOM_STATUS_DOT_CLS: Record<RoomStatus, string> = {
  live: 'bg-success',
  connecting: 'bg-text-muted',
  error: 'bg-warning',
  idle: 'bg-warning',
}

const roomChip = computed(() => {
  if (!room.inRoom) return null
  const status = room.status
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
    live: peers === null ? `Live room ${code}` : `Live room ${code}, ${peers} in room`,
    connecting: 'Connecting to the household…',
    error: `Offline — ${room.error ?? 'not connected'}`,
    idle: 'Offline — not connected',
  }
  const description = detail[status]
  /** The word beside the dot (ADR-0049 addendum 12): the owner brought
   *  "Live" back after the dot-only chip. Same record for every state, so
   *  connecting and offline are not reduced to a colour either. */
  const label: Record<RoomStatus, string> = {
    live: 'Live',
    connecting: 'Connecting',
    error: 'Offline',
    idle: 'Offline',
  }
  return {
    dotCls: ROOM_STATUS_DOT_CLS[status],
    label: label[status],
    /**
     * The badge-dot headcount. `null` means "render the plain dot": a
     * household of ONE is the ordinary case and a `1` on the header would
     * be noise, and a not-yet-told device must never be shown a `0`.
     * The count is decorative — the sentence above is the carrier that a
     * screen reader announces and the bubble repeats.
     */
    badge: status === 'live' && peers !== null && peers > 1 ? peers : null,
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

/**
 * One-shot `?p=` link sharing is RETIRED (ADR-0051): rooms are the only way
 * to share a plan. The decoder is gone with it, so an old link can no longer
 * be honoured — but it must not fail silently either. Someone who has a
 * `?p=` link in a chat, a bookmark or a screenshot opens it and would
 * otherwise get a perfectly normal-looking app with no explanation for why
 * their plan did not arrive. So the param is detected, explained, and
 * stripped.
 */
function retireSharedPlanLink() {
  const p = route.query.p
  if (typeof p !== 'string' || p === '') return
  ui.showToast('One-time plan links were removed — share a live room link instead.', {
    duration: 8000,
  })
  // Strip it so a reload does not repeat the toast.
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
/**
 * The headcount AT THE MOMENT the modal opened (ADR-0049 addendum).
 *
 * Captured with the code rather than read live: the `peers` frames keep
 * arriving while the modal is up, and "2 in the room right now" must not
 * silently rewrite itself under a reader who is still reading it. `null`
 * means nobody told us yet, and the modal then says nothing about numbers
 * rather than claiming a `1` it never received.
 */
const congratsPeers = ref<number | null>(null)

watch(
  () => [room.status, room.code] as const,
  ([status, code]) => {
    if (!linkJoinCode.value) return
    // BOTH conditions: live, AND live in the code the link named. A
    // reconnect into some other room must not claim a join that never
    // happened.
    if (status !== 'live' || code !== linkJoinCode.value) return
    congratsCode.value = code
    congratsPeers.value = room.peers
    linkJoinCode.value = null
    // A link join ADOPTS the room (ADR-0049 Decision 11): the person
    // followed a household's invitation, so the code persists as the
    // household room and this device re-joins it on every future launch
    // (ADR-0019). Saved only at the LIVE frame — a link that never joins
    // must not leave a dead code behind, and Leave (Decision 5) still
    // undoes it in one tap.
    ui.setHouseholdRoom(code)
  },
)

/**
 * A FRESH join into an EMPTY plan lands the joiner on the recipes list
 * (ADR-0049 addendum).
 *
 * The problem: a share link (`?room=`) can be followed from anywhere, and
 * a link followed from /plan, /grocery or /history drops somebody into a
 * tab about a plan they have never seen. The room's state lands, and the
 * first screen shows an empty plan (or an empty grocery list) as if it
 * were their own. The recipes list is where the household's actual
 * content is, so that is where a joiner with nothing planned belongs.
 *
 * Deliberately narrow, because a router push is a visible move:
 *  - only a FRESH join-to-live transition. `room.freshJoin` is armed by a
 *    deliberate `join()`/`create()` and disarmed by `leave()` and every
 *    terminal failure, so neither a page-reload RESUME nor an automatic
 *    RECONNECT can yank the view out from under somebody — and a join
 *    that failed cannot navigate minutes later off a stale flag;
 *  - only when the plan is empty AFTER the room's snapshot has landed
 *    (`plan.plan.length === 0`). This watcher runs after the store's
 *    `joined` handler, so a household that HAS meals lands the joiner with
 *    a plan already in place — and they stay on the tab they opened,
 *    which is the right answer: their grocery list is not empty after all.
 *    The empty case is the one that greets a newcomer with a blank tab;
 *  - never on /settings, which is the room's OWN surface: somebody who
 *    just tapped `Join now` is asking about the room, and the card's
 *    `· N in room` line under the field they typed into IS the answer.
 *    Landing them on the recipes list would navigate away from the
 *    confirmation of the thing they just did — two e2e caught exactly
 *    that, which is how this guard got written;
 *  - never from a fullscreen focus mode (cooking / shopping have no nav
 *    to navigate around and their own leave-confirm);
 *  - never a no-op push when the recipes tab is already open.
 */
watch(
  () => [room.status, room.freshJoin] as const,
  ([status, fresh]) => {
    if (status !== 'live' || !fresh) return
    if (plan.plan.length > 0) return
    if (isFullscreenMode.value) return
    if (route.name === 'recipes' || route.name === 'settings') return
    void router.push({ name: 'recipes' })
  },
)

/**
 * ADR-0019: the saved household room joins itself on every start, so the
 * daily two-phone flow needs no share link. A session resume (room store)
 * or an explicit `?room=` link wins; a failed join only toasts and never
 * blocks the app — the retry happens on the next launch.
 *
 * `deliberate = false` (review kody): this runs on EVERY launch of a
 * device that already has a saved room. Arming `freshJoin` here would
 * move somebody off the tab they opened, once per session, for a join
 * they did not ask for this time round — the post-join landing belongs
 * to a join somebody tapped or followed.
 */
function autoJoinHousehold() {
  const code = ui.householdRoom
  if (!code || room.inRoom || room.status !== 'idle') return
  room.join(code, false)
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

/**
 * The changelog modal (ADR-0060): opened from the header version button.
 * State lives here, NOT in a store — it's a transient UI surface, not
 * household data (no STORE_SLICES entry, no persisted slice).
 */
const changelogOpen = ref(false)
function openChangelog() {
  changelogOpen.value = true
}

/**
 * Stale-version banner (ADR-0061): shown when a newer bundle is deployed.
 * Dismissal is SESSION-ONLY (component state, not a store slice); the next
 * page load re-checks fresh, so an update cannot be permanently silenced.
 * The banner lives ABOVE the sticky header and never overlaps the bottom nav.
 */
const showBanner = ref(false)
const bannerState = ref<VersionState | null>(null)
let checkInterval: ReturnType<typeof setInterval> | null = null
let visibilityHandler: (() => void) | null = null

async function checkBannerVersion() {
  const result = await checkVersion({ running: appVersion })
  bannerState.value = result.state
  showBanner.value = result.state === 'stale'
}

function startBannerChecks() {
  // One check after mount (already called from onMounted).
  // Then on every visibilitychange → visible.
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      void checkBannerVersion()
    }
  }
  document.addEventListener('visibilitychange', visibilityHandler)
  // Then every 5 minutes while open.
  checkInterval = setInterval(() => {
    void checkBannerVersion()
  }, 5 * 60 * 1000)
}

function stopBannerChecks() {
  if (checkInterval !== null) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  if (visibilityHandler !== null) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
}


onMounted(async () => {
  await router.isReady()
  // Resume a room from a previous page load; a fresh ?room= link wins.
  if (!room.resume()) void joinRoomFromLink()
  retireSharedPlanLink()
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
  // Stale-version banner: one check after mount, then on a schedule.
  startBannerChecks()
  void checkBannerVersion()
})
onBeforeUnmount(() => {
  stopBannerChecks()
})
</script>
<template>
  <div class="mx-auto flex min-h-dvh max-w-app flex-col" data-test="app-shell">
  <!-- Stale-version banner (ADR-0061): fixed above the sticky header,
       never covering or shifting the bottom nav. role="status" so it is
       announced without interrupting. Session-only dismissal. -->
  <div
    v-if="showBanner"
    data-test="version-banner"
    role="status"
    class="fixed top-0 inset-x-0 z-40 bg-brand px-4 py-2 text-center text-sm font-medium text-on-brand"
  >
    <span data-test="version-banner-text">A new version of Flambette is available</span>
    <button
      type="button"
      data-test="version-refresh"
      class="ml-2 rounded-lg bg-on-brand px-3 py-0.5 text-xs font-bold text-brand"
      aria-label="Refresh to the new version"
      @click="reload()"
      >Refresh</button
    >
    <button
      type="button"
      data-test="version-banner-dismiss"
      class="ml-2 inline-flex size-6 items-center justify-center rounded-full hover:bg-on-brand/20"
      aria-label="Dismiss version notice"
      @click="showBanner = false"
      ><X :size="14" aria-hidden="true" /></button
    >
  </div>

  <header
  v-if="!isFullscreenMode"
  class="sticky z-20 border-b border-border bg-surface-raised"
  :class="showBanner ? 'mt-12' : ''"
  :style="{ top: showBanner ? '48px' : '0px' }"  
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
  <button
  type="button"
  data-test="app-version"
  class="group relative max-w-28 min-w-0"
  :aria-label="`What's new in version ${appVersion}`"
  @click="openChangelog()"
  ><span class="block truncate text-xs text-text-muted">{{ appVersion }}</span>
  <!-- ADR-0055: the OS `title` becomes the one bubble; a span is not
  focusable, so this reveals on hover only — the parity native `title`
  had. below-right: the header pattern (drops down, right-anchored —
  ADR-0049's viewport-overflow lesson). The bubble is a DESCENDANT of
  the group host — `group-hover` is a descendant selector; no spec reads
  this span's textContent. The host is NOT the truncate element: the
  wrapper carries `group relative`, the inner span carries `truncate` —
  its `overflow: hidden` would clip a child bubble (coderabbit r1). -->
  <TooltipBubble :text="`Version ${appVersion}`" placement="below-right" />
  </button>
  <span
  v-if="roomChip"
  class="group relative flex shrink-0 cursor-help items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1.5 text-xs font-medium"
  :aria-label="roomChip.description"
  data-test="room-chip"
  >
  <!-- THE CHIP IS A DOT AND ITS WORD (ADR-0049 addenda 8 + 12). The
       owner's first ruling dropped the icon AND the word; after living
       with the dot-only chip, the owner brought the word back ("keep the
       text Live next to the green dot") — the ICON stays gone, because it
       was the element whose only content duplicated the word. Everything
       else the visuals dropped — the code, the headcount, the offline
       reason — survives in the `aria-label` above, which is what a
       screen reader announces and what the bubble below repeats verbatim.

       The BADGE-DOT branch below is the one exception to "a dot": a
       household of two or more shows the headcount without a tap, which
       is the owner's mobile ask. Dot-scale, beside the word; the count is
       decorative — the aria-label above is the carrier. -->
  <span
  v-if="roomChip.badge === null"
  class="size-2.5 shrink-0 rounded-full"
  :class="roomChip.dotCls"
  data-test="room-chip-dot"
  aria-hidden="true"
  />
  <span
  v-else
  class="flex h-4 min-w-4 items-center justify-center rounded-full bg-success px-1 text-[10px] font-semibold leading-none text-on-success tabular-nums"
  data-test="room-chip-count"
  aria-hidden="true"
  >{{ roomChip.badge }}</span>
  <span>{{ roomChip.label }}</span>
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
       contributes nothing at all, exactly as HueIcon's bubble does.

       ADR-0055: the bubble is now `TooltipBubble` — the ONE tooltip
       implementation. CSS mode (no `active`): this chip is an ordinary
       pointer-active element, so the group-hover/focus-within classes
       live inside the component. `room-chip-tooltip` survives through
       attribute fallthrough (ADR-0055 Decision 8); the load-bearing
       `max-w-56` + `right-0` shape is the `below-right` placement. -->
  <TooltipBubble
  :text="roomChip.description"
  placement="below-right"
  data-test="room-chip-tooltip"
  />
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
  :peers="congratsPeers"
  @dismiss="congratsCode = null"
  />
  <ChangelogModal :open="changelogOpen" @close="changelogOpen = false" />
</template>
