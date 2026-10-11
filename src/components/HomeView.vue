<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, Lock, UserX, Users } from 'lucide-vue-next'
import AppModal from './AppModal.vue'
import { generateRoomCode } from '../lib/roomWords'
import { useShareRoomLink } from '../composables/useShareRoomLink'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'

/**
 * The home hero (ADR-0078). `/` is a statement of what the app is — no
 * account, household planning over a three-word code, 2,500+ hand-curated
 * recipes — built on the Warm Culinary Paper tokens (Stitch screen
 * "Flambette — Home Page Hero"; raw render hexes mapped to DESIGN.md
 * tokens, never a raw hex in source). The hero route has NO bottom nav
 * (the app header STAYS — Q2), keeps the app-shell default head (canonical
 * `/`), and is deliberately NOT in the KeepAlive include list — it is
 * stateless and cheap to re-render.
 *
 * Rejected render fictions stay rejected: the render's own header row
 * (the real app shell is the ONLY header), the sample room code
 * `olive-basin-saffron` (the modal shows the REAL rolled code), presence
 * avatars and a `live` pill in the illustration card (a static
 * illustration never pretends a room is live — the card is a static
 * MARKETING demo with a redacted code that never reads the device's real
 * room state, ADR-0078 Decision 5), and any exact recipe count (the
 * literal "2,500+" is an owner ruling).
 *
 * ONE filled intent per surface (ADR-0072): "Start planning" is THE
 * tomato on the hero; "Create a household" is outlined. Inside the
 * household modal the ONE filled intent is "Browse recipes"; the copy
 * action demotes to outlined.
 */

const router = useRouter()
const room = useRoomStore()
const ui = useUiStore()
const { shareRoomLink } = useShareRoomLink()

/** ADR-0078 Decision 3: the hero's primary route into the catalog. */
function startPlanning() {
  void router.push({ name: 'recipes' })
}

/**
 * The hero's household button has ONE branch point with three outcomes —
 * a device standing in a room, a device with a saved household, and a
 * stranger — "Create a household" only for the last. ONE source of truth
 * (`hasHousehold`) drives both label and press.
 *
 * The press never rolls a code while the device holds a room: a create
 * rolls CLIENT-side (ADR-0021) so the modal IS the confirmation surface
 * (Decision 7, which is why the freshJoin landing watcher never
 * navigates away from `/`); a re-join adopts the saved code
 * synchronously. A create that fails is reported by App.vue's room-error
 * toast (ADR-0019: toast, never block); this view only closes the modal
 * again so a dead attempt cannot read as success. Nothing here awaits a
 * room operation on the render path.
 */
const modalOpen = ref(false)
const creating = ref(false)

/**
 * ONE source of truth for "this device belongs to a household": the room
 * the device is STANDING IN (`room.inRoom`) OR the persisted ADR-0019
 * setting. The persisted setting alone lags reality — it is written by
 * the confirm watcher below, by App.vue's link-join adoption and by
 * Settings, never by a Plan-tab room or a session resume — so a device
 * live in a room whose code was never persisted would otherwise read
 * (and press) as a stranger. The label and the press read the same
 * computed, so the affordance can never say one thing and do another.
 */
const hasHousehold = computed(() => room.inRoom || ui.householdRoom !== '')

/**
 * The code this press ASKED the relay for — a fresh roll (create) or a
 * saved re-join; null when the press found a live room (no dial at all).
 */
const askedCode = ref<string | null>(null)

/**
 * True while this press's dial (create or saved re-join) is UNANSWERED:
 * the modal shows the asked code as pending and sharing stays disabled
 * until the relay confirms — a `code_taken` re-roll means the room the
 * device ends up in is not the one it asked for, and a link copied
 * before the answer would name a code nobody can join.
 */
const dialing = ref(false)

function createHousehold() {
  if (creating.value) return
  creating.value = true
  // ONE branch point, three outcomes — the LIVE room wins. Standing in a
  // room IS membership: the press never rolls and never re-dials (a
  // re-roll would orphan the room the device is in), the modal shows
  // `room.code` as-is, and the code is adopted as the household room so
  // the next launch re-joins it (ADR-0019) — the same save-and-confirm
  // Settings does for a device already live in its room.
  if (room.inRoom && room.code) {
    askedCode.value = null
    dialing.value = false
    ui.setHouseholdRoom(room.code)
    modalOpen.value = true
    return
  }
  const saved = ui.householdRoom
  if (saved) {
    // Already has a saved household: a deliberate re-join, never a
    // re-roll. `join()` sets `room.code` synchronously; a deliberate
    // join is safe here because the freshJoin landing watcher never
    // navigates away from `/` (ADR-0078 Decision 7).
    askedCode.value = saved
    dialing.value = true
    room.join(saved)
  } else {
    // A create rolls the code CLIENT-side (ADR-0021) so the modal IS the
    // confirmation surface (Decision 7, which is why the freshJoin
    // landing watcher never navigates away from `/`). The roll persists
    // immediately (same shape as Settings' join flow) and the confirm
    // watcher below adopts whatever code the relay actually honoured —
    // a `code_taken` re-roll lands in a DIFFERENT room than the roll.
    const rolled = generateRoomCode()
    askedCode.value = rolled
    dialing.value = true
    ui.setHouseholdRoom(rolled)
    room.create(rolled)
  }
  modalOpen.value = true
}

/**
 * The code the modal displays. The relay's confirmed answer always wins
 * — the live room's code, which also covers a `code_taken` re-roll. A
 * dial in flight shows the code we asked for, marked pending by
 * `dialing` (and NOT shareable — see `canShare`).
 */
const displayCode = computed(() => {
  if (room.status === 'live' && room.code) return room.code
  return askedCode.value ?? ''
})

/**
 * Sharing is a promise about the room this device actually JOINED, so it
 * unlocks only on the confirmed live code — never on an unanswered roll
 * or a refused one.
 */
const canShare = computed(() => !dialing.value && room.status === 'live' && !!room.code)

// A failed create (relay down, refused) closes the modal; the toast came
// from the store's error watcher (ADR-0019: toast, never block). The
// retry is a fresh press.
watch(
  () => room.status,
  (status) => {
    if (status === 'error') {
      dialing.value = false
      if (modalOpen.value) modalOpen.value = false
    }
  },
)

// The dial's answer. A LIVE frame confirms the code this device actually
// ended up in (create or re-join, re-rolls included): sharing unlocks,
// pending clears, and the household room is adopted so the next launch
// re-joins the room we are standing in (ADR-0019) — a hero-created
// household must not evaporate at the first page load. `error`/`idle`
// end the wait with no code to adopt (the status watcher above closed
// the modal on `error`).
watch(
  () => [room.status, room.code] as const,
  ([status, code]) => {
    if (!dialing.value) return
    if (status === 'live' && code) {
      dialing.value = false
      askedCode.value = null
      if (ui.householdRoom !== code) ui.setHouseholdRoom(code)
    } else if (status === 'error' || status === 'idle') {
      dialing.value = false
    }
  },
)
watch(modalOpen, (open) => {
  if (!open) creating.value = false
})

/** ADR-0023: the share link ONLY through useShareRoomLink's verified
 *  write — never a raw clipboard call, never navigator.share. */
function copyRoomLink() {
  void shareRoomLink(displayCode.value)
}

function browseRecipes() {
  modalOpen.value = false
  void router.push({ name: 'recipes' })
}
</script>

<template>
  <div data-test="home-hero" class="px-4 pb-20 pt-10 lg:pt-16">
    <!-- HERO: two-column split on desktop, stacked on phones -->
    <section class="mb-16 grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-14">
      <!-- LEFT: statement + CTAs -->
      <div class="flex flex-col items-start lg:col-span-7">
        <span
          class="mb-4 rounded border border-border bg-surface-raised px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wider text-text-muted"
        >
          Meal planning for your household
        </span>

        <h1
          class="mb-6 max-w-[16ch] text-4xl font-bold leading-tight tracking-tight text-brand-text lg:text-5xl"
        >
          Plan dinner together.
          <span class="text-brand">No account needed.</span>
        </h1>

        <p class="mb-8 max-w-[55ch] text-lg leading-relaxed text-text-muted">
          Flambette runs right in your browser. Pick from over 2,500 hand-curated recipes,
          build a waste-aware plan and one grocery list — and share it with your household
          using a three-word code. No sign-up, no email, nothing to remember.
        </p>

        <!-- Mobile: the two CTAs stack FULL-WIDTH (Stitch mobile spec);
             from sm they sit side-by-side again. -->
        <div class="mb-5 flex w-full flex-col items-stretch gap-4 sm:w-auto sm:flex-row sm:items-center">
          <button
            type="button"
            data-test="hero-start-planning"
            class="inline-flex h-12 w-full items-center justify-center rounded-xl bg-brand px-7 text-[15px] font-semibold text-on-brand transition-all hover:bg-brand-strong active:scale-[0.98] motion-reduce:active:scale-100 sm:w-auto"
            aria-label="Start planning"
            @click="startPlanning()"
          >
            Start planning
          </button>
          <button
            type="button"
            data-test="hero-create-household"
            class="inline-flex h-12 w-full items-center justify-center rounded-xl border border-border bg-transparent px-7 text-[15px] font-semibold text-text transition-colors hover:bg-surface-raised active:scale-[0.98] motion-reduce:active:scale-100 sm:w-auto"
            :aria-label="hasHousehold ? 'Join your household' : 'Create a household'"
            @click="createHousehold()"
          >
            {{ hasHousehold ? 'Join your household' : 'Create a household' }}
          </button>
        </div>

        <div class="flex items-center gap-2 text-sm text-text-muted">
          <Lock :size="16" aria-hidden="true" />
          <span
            >Your data stays on your devices. Only a household room syncs —
            your plan, through your own three-word code.</span
          >
        </div>
      </div>

      <!-- RIGHT: the stacked two-card composition. An illustration of the
           FEATURE — the household room-code affordance — never fake live
           state: the code chip is a STATIC redacted demo code that never
           reads the device's real room (ADR-0078 Decision 5). -->
      <div class="relative flex items-center justify-center py-6 lg:col-span-5">
        <div class="relative w-full max-w-[400px]">
          <!-- BACK CARD — recipe-card illustration -->
          <div
            class="absolute -top-6 -right-3 w-[92%] rotate-[2.5deg] rounded-xl border border-border bg-surface-raised p-3 sm:-right-5"
          >
            <div
              class="mb-3 flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg bg-surface-sunken"
            >
              <!-- The hero recipe-card illustration: a real food photograph
                   from the Stitch screen, shipped as webp (repo image norm). -->
              <img
                src="/img/hero/recipe-card.webp"
                alt="Sheet-pan halloumi and roasted vegetables"
                class="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </div>
            <div class="px-1 pb-1">
              <h3 class="text-[15px] font-semibold leading-snug text-brand-text">
                Sheet-pan halloumi &amp; peppers
              </h3>
              <p class="mt-1 font-mono text-xs font-medium text-text-muted">35 min · 6 servings</p>
            </div>
          </div>

          <!-- FRONT CARD — the household room-code affordance. This is a
             MARKETING illustration of the feature: a fake code with the
             first word redacted and two static presence dots. It must
             NOT read the device's real room and MUST NOT claim a room is
             "live" — the real code is only ever produced by the modal's
             room.create(). ADR-0078 Decision 5. -->
          <div
            data-test="hero-household-card"
            class="relative z-10 mt-24 w-[94%] -rotate-[1.5deg] rounded-xl border border-border bg-surface-raised p-5 shadow-lg transition-transform duration-300 hover:rotate-0 sm:mt-28 motion-reduce:transition-none"
          >
            <div class="mb-4 border-b border-border pb-3.5">
              <div class="flex items-center gap-2.5">
                <span class="text-base font-semibold text-brand-text"
                  >Your household</span
                >
                <!-- Two static illustrative presence dots (NOT live state). -->
                <div class="flex -space-x-1.5">
                  <span
                    class="flex size-5 items-center justify-center rounded-full border-2 border-surface text-[10px] font-bold text-text-muted"
                    aria-label="Alex"
                    title="Alex"
                    >A</span
                  >
                  <span
                    class="flex size-5 items-center justify-center rounded-full border-2 border-surface text-[10px] font-bold text-brand-text"
                    aria-label="Sam"
                    title="Sam"
                    >S</span
                  >
                </div>
              </div>
            </div>

            <div class="my-3 text-center">
              <div
                data-test="hero-demo-code"
                class="inline-block rounded-lg border border-border bg-surface-sunken px-4 py-3 font-mono text-lg font-semibold tracking-tight text-brand-text select-all"
              >
                <!-- Demo code: first word redacted with a unicode block,
                     the other two illustrative (not a real room). The modal
                     shows the REAL code from room.create(). -->
                <span aria-hidden="true">██████████</span>-basin-saffron
              </div>
            </div>

            <p class="mt-2.5 text-center text-[13px] text-text-muted">
              A sample, not a real room — Create a household to get yours.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- VALUE STRIP -->
    <section class="grid grid-cols-1 gap-6 pt-4 md:grid-cols-3">
      <div class="rounded-xl border border-border bg-surface-raised p-6">
        <div
          class="mb-4 flex size-9 items-center justify-center rounded-full border border-border bg-surface"
        >
          <UserX :size="20" aria-hidden="true" class="text-text" />
        </div>
        <h2 class="mb-2 text-base font-bold text-brand-text">No account. Ever.</h2>
        <p class="text-sm leading-relaxed text-text-muted">
          Open the app and start. Nothing to register, nothing tracked.
        </p>
      </div>

      <div class="rounded-xl border border-border bg-surface-raised p-6">
        <div
          class="mb-4 flex size-9 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Users :size="20" aria-hidden="true" class="text-text" />
        </div>
        <h2 class="mb-2 text-base font-bold text-brand-text">One household, one plan</h2>
        <p class="text-sm leading-relaxed text-text-muted">
          A three-word code syncs the plan, grocery list and cooked history live.
        </p>
      </div>

      <div class="rounded-xl border border-border bg-surface-raised p-6">
        <div
          class="mb-4 flex size-9 items-center justify-center rounded-full border border-border bg-surface"
        >
          <BookOpen :size="20" aria-hidden="true" class="text-text" />
        </div>
        <h2 class="mb-2 text-base font-bold text-brand-text">2,500+ hand-curated recipes</h2>
        <p class="text-sm leading-relaxed text-text-muted">
          A real editor picked every recipe. The catalog ships with the app — browsing works
          even with no connection.
        </p>
      </div>
    </section>

    <!-- HOUSEHOLD MODAL (Decision 3). Component state — transient UI, not
         persisted: no store, no STORE_SLICES entry. The ONE filled intent
         inside is "Browse recipes"; the copy action demotes to outlined. -->
    <AppModal
      v-if="modalOpen"
      dialog-label="Your household room"
      overlay-class="z-40 flex items-center justify-center modal-scrim px-6"
      panel-class="w-full max-w-sm space-y-4 rounded-2xl bg-surface-raised p-6 text-center"
      overlay-test="household-modal"
      panel-test="household-modal-dialog"
      @close="modalOpen = false"
    >
      <Users :size="32" aria-hidden="true" class="mx-auto text-brand" />
      <h2 class="text-lg font-bold tracking-tight text-brand-text">Your household room</h2>
      <p class="text-sm text-text-muted">
        Share this code or link — anyone who joins sees the same plan.
      </p>
      <p
        data-test="household-code"
        class="select-all break-all rounded-xl bg-surface-sunken px-3 py-3 font-mono text-lg font-semibold tracking-tight text-brand-text"
      >
        {{ displayCode }}
      </p>
      <!-- Pending dial: the code above is what we ASKED for, not what the
           relay honoured yet — a code_taken re-roll can still change it,
           so the share affordance stays disabled until the live frame. -->
      <p v-if="dialing" data-test="household-pending" class="text-xs text-text-muted">
        Connecting to the relay…
      </p>
      <button
        type="button"
        data-test="household-copy-link"
        class="h-11 w-full rounded-xl border border-border bg-transparent px-3 text-sm font-semibold text-text transition-colors enabled:hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Copy room link"
        :disabled="!canShare"
        @click="copyRoomLink()"
      >
        Copy room link
      </button>
      <button
        type="button"
        data-test="household-browse-recipes"
        class="h-11 w-full rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-strong active:bg-brand-strong"
        aria-label="Browse recipes"
        @click="browseRecipes()"
      >
        Browse recipes
      </button>
    </AppModal>
  </div>
</template>