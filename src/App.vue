<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDark, useMediaQuery, useToggle } from '@vueuse/core'
import { CircleAlert, Moon, Sun, X } from '@lucide/vue'
import ChangelogModal from './components/ChangelogModal.vue'
import { checkVersion, type VersionState } from './lib/versionCheck'
import { TABS, useUiStore } from './stores/ui'
import { getCatalog } from './lib/catalog'
import {
  alarmingTimers,
  ensureTimerAlertPolling,
  type AlarmingTimer,
} from './lib/timerAlertHost'
import { usePlanStore } from './stores/plan'
import { useRoomStore, type RoomStatus } from './stores/room'
import { initFavourites } from './stores/favourites'
import { appVersion } from './lib/appVersion'
import { homeSeoHead, recipesSeoHead } from './lib/seo'
import { normalizeRoomCode } from './lib/roomWords'
import { useHead } from '@unhead/vue'
import JoinCongratsModal from './components/JoinCongratsModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import RosterSheet from './components/RosterSheet.vue'
import TooltipBubble from './components/TooltipBubble.vue'
import { useIdentityStore } from './stores/identity'
import RecipeSearchField from './components/RecipeSearchField.vue'

/**
 * The app-level head (ADR-0048), ONE owner for the two indexable
 * surfaces: the hero (`/`, canonical `/`) and the recipes list
 * (`/recipes`, canonical `/recipes/`). Every other app-shell route is
 * served the same SPA fallback HTML and keeps the homepage head — the
 * duplicate-content defence for /plan, /grocery, /settings …
 *
 * The recipes entry lives HERE, route-gated, not inside RecipesTab:
 * that tab is KeepAlive-CACHED, so leaving the route deactivates it
 * without unmounting, and a scoped `useHead` registered for the
 * component's lifetime would keep overriding the shell's head on every
 * other tab. The strings come from the SAME builders the prerenderer
 * writes into `dist/index.html` and `dist/recipes/index.html`, so a
 * crawler and the hydrating app cannot disagree. Bound below, after
 * `route` exists.
 */

const reload = () => location.reload()

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const plan = usePlanStore()
const room = useRoomStore()
// ADR-0063: instantiating here runs the identity store's hydration-time
// migration (generate when absent while a household room is saved).
const identity = useIdentityStore()

/** The app-level head (ADR-0048): see the block comment above — ONE
 *  owner, the hero and the recipes list, homepage head everywhere else. */
useHead(computed(() => (route.name === 'recipes' ? recipesSeoHead() : homeSeoHead())))

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
 * The global alarm banner (ADR-0093 change note 2026-10-19): while any
 * timer is RINGING, the shell shows one Stop affordance no matter which
 * surface the user is on — ADR-0093's stop verbs live on the cooking
 * strip, and a cook who finished (post-cook Done lands on /history) or
 * is anywhere else must still be able to stop the alarm without finding
 * the recipe and re-entering cooking mode. The banner is a REACH route
 * for the timer's own verbs, not a new alarm state: Stop performs the
 * chip's Clear (cancel) on every ringing timer, which the host observes
 * exactly like a tap on the strip. Hidden on the fullscreen focus modes
 * (cooking carries the full strip with every stop verb; shopping is a
 * modal flow the banner would cover) — the alarm itself is unaffected.
 */
const alarmRinging = computed(() => !isFullscreenMode.value && alarmingTimers.value.length > 0)
const alarmNames = computed(() =>
  alarmingTimers.value.map((t: AlarmingTimer) => `“${t.label}”`).join(', '),
)
function stopAlarms(): void {
  for (const t of alarmingTimers.value) ui.clearTimer(t.variantId, t.timerId)
}

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

/** ADR-0078 + ADR-0096: the hero lives at `/` (home) for new visitors and at
 *  `/welcome` (welcome) for always-accessible reach — both hide the bottom
 *  nav (the header STAYS per Q2) and the hero owns its own padding, like
 *  the fullscreen modes do. A returning device is replace-redirected to
 *  `/recipes` by the router guard, so it never renders either hero route. */
const isHome = computed(() => route.name === 'home' || route.name === 'welcome')

/** ADR-0070 (Addendum 2): the search well is PERSISTENT — it renders in
 *  the header band on EVERY tab at lg+, not only on Recipes. The media
 *  query mirrors the `lg:` Tailwind variant so the v-if (not a CSS hide)
 *  keeps exactly ONE search field in the document at any width, and the
 *  fullscreen focus modes (cooking, shopping) keep their own chrome. */
const isDesktop = useMediaQuery('(min-width: 1024px)')
const showHeaderSearch = computed(() => isDesktop.value && !isFullscreenMode.value)

/**
 * The roster sheet behind the room chip (ADR-0063): tapping the chip opens
 * the PEOPLE currently connected. The chip keeps every status rule; the
 * sheet is a calm overlay, not a navigation change.
 */
const rosterOpen = ref(false)

/**
 * Clicking the header logo goes home (ADR-0078 Q3 + ADR-0096): on the
 * recipes list or either hero route a no-op push would discard the
 * reader's scroll, so scroll to top instead; `welcome` joins that
 * same-page branch (the logo from the always-accessible hero is a
 * scroll-to-top). From any other tab the push goes to `home` — and the
 * router guard decides the destination: `/recipes` for a returning device
 * (their home IS the recipes list) and the hero for a new one; the
 * `?room=` query is not forwarded from a logo press (it is handled by
 * `joinRoomFromLink` on whatever route the device lands on).
 */
function goHome() {
  if (route.name === 'recipes' || route.name === 'home' || route.name === 'welcome') {
    // Same page: scroll to top instead of a no-op navigation.
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  } else {
    void router.push({ name: 'home', query: route.query.room ? {} : undefined })
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
    // ADR-0096 Decision 5: a create or join made FROM either hero route
    // must not navigate away while the household modal is open — the modal
    // IS the confirmation surface.
    if (route.name === 'home' || route.name === 'welcome') return
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
  // ADR-0084 decision 5: the SUCCESS toast is REMOVED — a join that
  // succeeded is visible in the room chip (and share lives on the roster
  // sheet's `roster-share`, ADR-0079, and the Plan tab, ADR-0023); the
  // app does not announce a state the header already shows. The FAILURE
  // toast below STAYS: it reports something the chip does not show.
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
 * The changelog modal (ADR-0060/0096): opened from the header's version
 * button and the Settings About card's info tile. Its open state lives in
 * the ui store as a NON-persisted transient slot (like `toast`/`confirm`)
 * — Settings and the header now share ONE modal through ONE slot, with no
 * STORE_SLICES entry and no persisted slice (a closed modal never survives
 * a reload).
 */

/**
 * Stale-version banner (ADR-0061): shown when a newer bundle is deployed.
 * Dismissal is SESSION-ONLY (ADR-0061 §3): component state, never persisted —
 * the next page load re-checks fresh, so an update can be deferred to a
 * moment the user chooses, never permanently silenced. (The first
 * implementation persisted a 24h timestamp in localStorage, which contradicted
 * the ADR it cited; the ADR is the contract.)
 * The banner lives ABOVE the sticky header and never overlaps the bottom nav.
 */
const bannerDismissed = ref(false)
const bannerState = ref<VersionState | null>(null)
const showBanner = computed(() => bannerState.value === 'stale' && !bannerDismissed.value)
let checkInterval: ReturnType<typeof setInterval> | null = null
let visibilityHandler: (() => void) | null = null

let checkSeq = 0

async function checkBannerVersion() {
  // Dismissed this session: keep the answer, never re-surface the banner.
  if (bannerDismissed.value) return
  // Race guard: a visibilitychange and the interval can overlap, and the
  // fetches may resolve out of order. Only the NEWEST in-flight check may
  // write the state — a stale response landing late would flap the banner
  // between fresh and stale one round early.
  const seq = ++checkSeq
  const result = await checkVersion({ running: appVersion })
  if (seq !== checkSeq) return
  bannerState.value = result.state
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
  // The device-level timer-completion host (ADR-0081 amendment): watches
  // the persisted step timers for the whole app session, so a timer that
  // reaches zero outside the cooking route still alerts. Starting here
  // also SEEDS every already-expired persisted timer as alerted, silently.
  ensureTimerAlertPolling()
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
  <!-- ADR-0065: the SHELL is full-window and the chrome bars (header,
       bottom nav) span the viewport edge to edge; main content and the
       chrome content rows align to the 1100px container. Below 1100px
       nothing changes — this was already the geometry. -->
  <div class="flex min-h-dvh flex-col" data-test="app-shell">
  <!-- Stale-version banner (ADR-0061): fixed above the sticky header,
       never covering or shifting the bottom nav. role="status" so it is
       announced without interrupting. Session-only dismissal. -->
  <div
    v-if="showBanner"
    data-test="version-banner"
    role="status"
    class="fixed top-0 inset-x-0 z-40 h-12 flex flex-nowrap items-center justify-center gap-1 overflow-hidden bg-brand px-3 text-sm font-medium text-on-brand"
  >
    <span data-test="version-banner-text" class="min-w-0 truncate whitespace-nowrap">A new version of Flambette is available</span>
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
      @click="bannerDismissed = true"
      ><X :size="14" aria-hidden="true" /></button
    >
  </div>

  <header
  v-if="!isFullscreenMode"
  class="sticky z-20 border-b border-border bg-surface-raised"
  :class="showBanner ? 'mt-12' : ''"
  :style="{ top: showBanner ? '48px' : '0px' }"  
  >
  <!-- The content row aligns to the 1100px container (ADR-0065): the
       BAND spans the window, the row does not. -->
  <div class="mx-auto flex w-full max-w-app items-center justify-between px-4 py-2">
  <button
  type="button"
  data-test="home-link"
  class="flex items-center gap-2 py-1 text-lg font-bold tracking-tight text-brand-text"
  :aria-label="route.name === 'recipes' ? 'Back to top of recipes' : 'Home'"
  @click="goHome()"
  >
  <img src="/favicon.svg" alt="" width="22" height="22" class="inline" aria-hidden="true" />
  Flambette
  </button>
  <!-- ADR-0070 (Addendum 2): the desktop search well in the header band —
  a sunken field (ADR-0065), width-capped and aligned to the container,
  mounted on EVERY tab. Typing while the grid is not on screen routes to
  Recipes (RecipeSearchField), because the grid is the only results
  surface. The query state and pipeline are the module singleton the
  content field shares, so the field moves between mounts without losing
  an in-flight search. -->
  <RecipeSearchField v-if="showHeaderSearch" variant="header" class="hidden w-full max-w-md lg:block" />
  <div class="flex items-center gap-2">
  <button
  type="button"
  data-test="app-version"
  class="group relative max-w-28 min-w-0"
  :aria-label="`What's new in version ${appVersion}`"
  @click="ui.changelogOpen = true"
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
  <!-- ADR-0063: the chip is a real BUTTON — tapping it opens the room
       roster. Every visual is unchanged (dot | badge | word, ADR-0049).
       ADR-0079: the tooltip is GONE — the sheet is the info surface — so
       `cursor-help` is retired with it (the tap is the affordance). It
       keeps `aria-expanded`, because it opens and closes a sheet. -->
  <button
  v-if="roomChip"
  type="button"
  class="group relative flex shrink-0 items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1.5 text-xs font-medium"
  :aria-label="roomChip.description"
  :aria-expanded="rosterOpen"
  data-test="room-chip"
  @click="rosterOpen = true"
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
  <!-- ADR-0079: the chip carries NO tooltip any more. The hover bubble
       (itself the ADR-0049 replacement for the native `title`) was a
       pointer-gated duplicate of the aria-label's sentence; the room's
       information surface is the roster sheet the chip opens, which
       works identically for touch, keyboard and pointer. The
       `aria-label` above stays the a11y carrier and the e2e handle. -->
  </button>
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
  class="mx-auto w-full max-w-app flex-1"
  :class="isRecipe || isFullscreenMode || isHome ? '' : 'px-4 pt-4 pb-28'"
  >
  <RouterView v-slot="{ Component }">
  <KeepAlive include="RecipesTab,PlanTab,GroceryTab,SettingsTab">
  <component :is="Component" />
  </KeepAlive>
  </RouterView>
  </main>

  <!-- ADR-0084 addendum (2026-10-13): the status pill gets room —
       px-5 py-3, a max-width cap (28rem desktop, viewport minus
       gutters on a phone), rounded-3xl so a wrapped message reads as
       a rounded card instead of a tall narrow capsule, and flex-wrap
       so actions drop to a centred line below long messages instead
       of squeezing beside them. Hooks, position and the level-2
       tokens are untouched. -->
  <Transition name="toast">
  <div
  v-if="ui.toast"
  role="status"
  class="fixed bottom-24 left-1/2 z-50 flex max-w-[min(28rem,calc(100vw-2.5rem))] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-3xl border border-border bg-popover px-5 py-3 text-sm font-medium leading-snug text-text shadow-popover"
  :data-test="ui.toast.kind ? `${ui.toast.kind}-toast` : 'toast'"
  >
  <span>{{ ui.toast.message }}</span>
  <button
  v-for="(action, i) in ui.toast.actions ?? []"
  :key="action.label"
  class="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
  :class="i === 0 ? 'bg-brand text-on-brand' : 'text-text-muted hover:text-text'"
  :data-test="action.testId ?? (i === 0 ? 'toast-action-primary' : 'toast-action-secondary')"
  @click="action.run()"
  >
  {{ action.label }}
  </button>
  </div>
  </Transition>

  <!-- The global alarm banner (ADR-0093 change note 2026-10-19): one
       Stop affordance while a timer RINGS, on every non-fullscreen
       surface. role="alert" — a ringing alarm is assertive, unlike the
       polite toast status. Sits in the toast's slot but yields upward
       (bottom-40) while a toast is showing, so the two never stack.
       Stop = the timer's own Clear verb, observed by the host exactly
       like a strip tap — no new alarm state (ADR-0093 §1). -->
  <Transition name="toast">
  <div
  v-if="alarmRinging"
  role="alert"
  data-test="alarm-banner"
  class="fixed left-1/2 z-30 flex max-w-[min(28rem,calc(100vw-2.5rem))] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-3xl border border-border bg-popover px-5 py-3 text-sm font-medium leading-snug text-text shadow-popover"
  :class="ui.toast ? 'bottom-40' : 'bottom-24'"
  >
  <span data-test="alarm-banner-text">Time's up — still ringing: {{ alarmNames }}</span>
  <button
  type="button"
  data-test="alarm-banner-stop"
  class="rounded-full bg-brand px-3 py-1 text-xs font-bold uppercase tracking-wide text-on-brand"
  :aria-label="`Stop the alarm for ${alarmNames}`"
  @click="stopAlarms()"
  >Stop</button
  >
  </div>
  </Transition>

  <!-- ADR-0067: the bar is roasted-espresso chrome in BOTH themes — the
       chrome-* foreground family is LITERAL (never flips), while the bar
       itself deepens espresso → espresso-dark in dark mode. ADR-0016's
       measured Pixel 7 fit (82px/tab) is untouched: same bar height,
       same five labelled tabs, same hit areas. -->
  <nav
  v-if="!isFullscreenMode && !isHome"
  class="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-chrome-border bg-espresso"
  aria-label="Main navigation"
  >
  <div class="mx-auto flex w-full max-w-app">
  <!-- Active state keys on the ROUTE NAME (tab ids are the route names),
  never on `route.path === tab.to`: the canonical URLs are the
  slash forms (/recipes/ is what Cloudflare 308s to and nginx serves as
  the directory index), and a strict path comparison leaves the tab
  unmarked — and aria-current missing — for everyone arriving from
  search, a sitemap entry, a bookmark or a reload. -->
  <button
  v-for="tab in TABS"
  :key="tab.id"
  class="nav-tab flex min-h-14 flex-1 flex-col items-center justify-center gap-1 pt-1.5 text-label-md transition-colors"
  :class="route.name === tab.id ? 'text-chrome-accent' : 'text-chrome-muted'"
  :aria-current="route.name === tab.id ? 'page' : undefined"
  @click="router.push(tab.to)"
  >
  <!-- A tinted icon BACKPLATE marks the active tab (DESIGN.md
  Navigation): a colour change alone is too quiet, and the
  backplate never resizes the tab or moves the label. The LITERAL
  chrome-backplate (cream) — the flipping brand-tint would turn
  near-espresso in dark mode and vanish against the bar. -->
  <span
  class="flex h-8 w-14 items-center justify-center rounded-full transition-colors"
  :class="route.name === tab.id ? 'bg-chrome-backplate' : ''"
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
  <ChangelogModal v-if="ui.changelogOpen" @close="ui.changelogOpen = false" />
  <!-- ADR-0063: tap the chip, meet the room. `count` is the relay's live
       headcount (the badge's number); `members` is the PEOPLE list (null
       = an old relay has not told us — degrade to the plain count, never
       a fake list); `selfId` marks this device's own row. -->
  <RosterSheet
  v-if="rosterOpen && roomChip"
  :count="room.peers"
  :members="room.members"
  :self-id="room.joinedProfileId || identity.id || null"
  :code="room.code"
  @close="rosterOpen = false"
  />
  <!-- ADR-0084: THE confirm surface, hosted ONCE. The single reactive
       slot in the ui store keeps one-mount == one-open (AppModal's
       assumption); every end path funnels back into settleConfirm. -->
  <ConfirmModal v-if="ui.confirm" :prompt="ui.confirm" @close="ui.settleConfirm" />
</template>
