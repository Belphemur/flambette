<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Bean,
  CircleDot,
  Download,
  Dices,
  Egg,
  Fish,
  FlaskConical,
  Link,
  Milk,
  Minus,
  Nut,
  Plus,
  Scale,
  Shrimp,
  Sprout,
  TestTubeDiagonal,
  Upload,
  Utensils,
  Wheat,
  Cherry,
  type LucideIcon,
} from 'lucide-vue-next'
import { applyBackup, backupFileName, buildBackupZip } from '../lib/backup'
import { appVersion } from '../lib/appVersion'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { MAX_SERVINGS, MIN_SERVINGS } from '../lib/servings'
import { UNIT_SYSTEMS, UNIT_SYSTEM_LABEL, type UnitSystem } from '../lib/units'
import { RESTRICTIONS } from '../lib/restrictions'
import { useRestrictions } from '../composables/useRestrictions'
import { useShareRoomLink } from '../composables/useShareRoomLink'
import { getCatalog } from '../lib/catalog'
import { USER_RECIPE_ID_BASE } from '../lib/userRecipes'
import {
  matchMealimeFavourites,
  mealimeReportLines,
  parseMealimePayload,
  type MealimeMatchResult,
} from '../lib/mealimeImport'
import { mealimeBookmarkletHref } from '../lib/mealimeBookmarklet'
import { useFavouritesStore } from '../stores/favourites'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'
import { useIdentityStore } from '../stores/identity'
import PersonAvatar from './PersonAvatar.vue'
import MealimeImportModal from './MealimeImportModal.vue'

/**
 * Settings (ADR-0016): the app's data surface. Backup & restore MOVED here
 * from the bottom of the Plan tab (ADR-0013 built it as a Plan section;
 * it is a data-management concern, not a plan concern, and on the Plan tab
 * it sat below a list the user reads, not edits).
 *
 * The logic is unchanged — same registry-driven zip export
 * (`buildBackupZip`) and validation-first atomic import (`applyBackup`) —
 * only the host surface moved.
 */
const ui = useUiStore()
const room = useRoomStore()
// ADR-0063: this device's room identity — the Settings card's name field
// and avatar preview, and the rename push while connected.
const identity = useIdentityStore()
const { shareRoomLink, shareableCode } = useShareRoomLink()

/* ---------- Your name (ADR-0063) ---------- */

/**
 * The ONE clamp point: the store's `rename` runs the shared sanitizer
 * (identical to the relay's normalizeProfile), and this draft follows the
 * store the same way the room-code field follows `ui.householdRoom` —
 * what the field holds is what the store holds is what the wire carries.
 */
const nameInput = ref(identity.name)
let nameTyping = false

watch(
  () => identity.name,
  (name) => {
    if (nameTyping) return
    nameInput.value = name
  },
)

/** @input on the name field: mark the draft as user-owned until blur. */
function onNameInput() {
  nameTyping = true
}

/**
 * @blur on the name field: commit through the store (the clamp runs ONCE
 * here, on the store action) and — while connected — push the rename so
 * the roster updates immediately.
 */
function onNameBlur() {
  nameTyping = false
  const before = identity.name
  identity.rename(nameInput.value)
  nameInput.value = identity.name // the clamp's answer, echoed back
  if (identity.name !== before) room.announceProfile()
}

/* ---------- Default servings (ADR-0037) ---------- */

/**
 * Nudge the remembered default serving size.
 *
 * Every OTHER surface that changes servings (the recipe-detail stepper,
 * the plan-row stepper) writes this same store value, so this control is
 * a direct view of it rather than a second, independent setting. The
 * store clamps; these bounds just stop the buttons walking into it.
 */
function bumpDefaultServings(delta: number) {
  const next = ui.defaultServings + delta
  if (next < MIN_SERVINGS || next > MAX_SERVINGS) return
  ui.setDefaultServings(next)
}

/* ---------- Dietary restrictions (the restriction ADR) ---------- */

/** One decorative glyph per restriction (ADR-0029: lucide-vue-next, bundled).
 *  The label carries the meaning, so the icons are neutral — no new hue
 *  tokens (ADR-0036: a food-type role that does not exist in the registry
 *  is not invented for a control); selected chips tint through the chip's
 *  own class. Glyphs are distinct so the row reads apart in monochrome. */
const RESTRICTION_ICONS: Record<string, LucideIcon> = {
  'shellfish-free': Shrimp,
  'fish-free': Fish,
  'gluten-free': Wheat,
  'dairy-free': Milk,
  'peanut-free': Bean,
  'tree-nut-free': Nut,
  'soy-free': Sprout,
  'egg-free': Egg,
  'sesame-free': CircleDot,
  'mustard-free': FlaskConical,
  'sulfite-free': TestTubeDiagonal,
  'nightshade-free': Cherry,
}

const restrictionPrefs = useRestrictions()

const activeRestrictionIds = computed(() => restrictionPrefs.activeIds.value)

function isActiveRestriction(id: number): boolean {
  return activeRestrictionIds.value.includes(id)
}

/**
 * Toggle one restriction and warm the artifacts (control plane + overlay)
 * for whatever is now active — fire-and-forget; a failed load degrades to
 * the base catalog and retries on the next toggle.
 */
function toggleRestriction(id: number): void {
  const active = new Set(activeRestrictionIds.value)
  if (active.has(id)) active.delete(id)
  else active.add(id)
  ui.setDietaryRestrictionIds([...active])
  void restrictionPrefs.ensureLoaded()
}

const restrictionNote = computed(() =>
  activeRestrictionIds.value.length === 0
    ? 'No restrictions are active — the full catalog shows.'
    : `${activeRestrictionIds.value.length} restriction${activeRestrictionIds.value.length === 1 ? '' : 's'} active.`,
)

const canFewerDefault = computed(() => ui.defaultServings > MIN_SERVINGS)
const canMoreDefault = computed(() => ui.defaultServings < MAX_SERVINGS)

/* ---------- Unit system (ADR-0047) ---------- */

/**
 * The labels are the shared `UNIT_SYSTEM_LABEL` registry (the recipe-detail
 * toggle reads the same map); what each mode actually puts on screen is
 * spelled out in the card's note below.
 */

/** One line per mode: what the screen will actually read. */
const UNIT_SYSTEM_NOTE: Record<UnitSystem, string> = {
  dual: 'Showing the recipe exactly as authored: dual temperatures, cups as written.',
  metric: 'Showing g, kg, ml and °C; cups gain their volume (1 cup → 1 cup (240 ml)).',
  imperial: 'Showing oz, lb, fl oz and °F; cups gain their volume (1 cup → 1 cup (8 fl oz)).',
}

/** The one writer — the recipe-detail toggle writes the same store value. */
function setUnitSystem(system: UnitSystem) {
  ui.setUnitSystem(system)
}

/* ---------- Household sync (ADR-0019) ---------- */

/** Draft code, seeded from the persisted setting. */
const roomInput = ref(ui.householdRoom)
/**
 * True while the user is editing the field: Settings lives under
 * KeepAlive, so a backup import can change ui.householdRoom without a
 * remount. The store→draft echo is suppressed while typing so an import
 * never stomps an in-progress edit (qodo 4128519632); the flag resets on
 * blur and on every save path.
 */
let roomTyping = false

watch(
  () => ui.householdRoom,
  (code) => {
  if (roomTyping) return
  roomInput.value = code
  },
)

/** @input on the room field: mark the draft as user-owned until blur. */
function onRoomInput() {
  roomTyping = true
}

/** @blur on the room field: resume following the store on future changes. */
function onRoomBlur() {
  roomTyping = false
}

const householdCode = computed(() => ui.householdRoom)
/** Both shapes normalize (ADR-0021): three words, or a legacy code. */
const canJoinRoom = computed(() => {
  // An EMPTY field is joinable: it will roll a fresh code (ADR-0049). Only
  // a field the user has half-typed into nonsense is refused, so the
  // guard the room-words spec pins survives while the empty field became
  // a useful action instead of a dead end.
  const draft = roomInput.value.trim()
  return draft === '' || normalizeRoomCode(draft) !== ''
})
/** True while this device is actually connected to the saved room. */
const householdConnected = computed(
  () => room.status === 'live' && room.inRoom && room.code === ui.householdRoom,
)

/** Roll a fresh three-word code into the field (ADR-0021). */
function newRoomCode() {
  roomTyping = false
  roomInput.value = generateRoomCode()
  // The rolled code exists NOWHERE yet: joining must CREATE it on the
  // relay instead of joining (qodo 4128519644).
  rolledNewCode.value = true
}

/** The live room, else the saved setting — whichever we can share. */
const shareableCodeText = computed(() => shareableCode())

/**
 * The card's single mutation entry point (ADR-0049).
 *
 * One button, not three. `Save` and `Join now` used to differ only in
 * *when* the sync started, which is a choice nobody wants to make twice
 * for a kitchen surface; and `Adopt` existed only to point the setting at
 * a room this device was already in. All three collapse here:
 *
 *  - empty field          → roll a code into it and CREATE it
 *  - rolled here          → CREATE it (a collision re-rolls rather than
 *                           silently adopting a stranger's room)
 *  - a parseable code     → JOIN it (join-or-create, ADR-0026)
 *  - nonsense             → the button is disabled, so it cannot be pressed
 *  - already live here    → save + confirm, WITHOUT dropping the socket
 */
function joinHouseholdRoom() {
  roomTyping = false
  const draft = roomInput.value.trim()
  // Empty is not an error here: it means "I have no code yet", and the
  // answer is to mint one rather than to scold the user.
  const rolledHere = rolledNewCode.value
  const code = draft === '' ? generateRoomCode() : normalizeRoomCode(draft)
  if (!code) {
    ui.showToast('Room codes look like amber-falcon-lantern', { kind: 'error' })
    return
  }
  const isNewCode = rolledHere || draft === ''
  rolledNewCode.value = false
  roomInput.value = code
  ui.setHouseholdRoom(code)

  // Already LIVE in THIS room: reconnecting would drop a healthy socket
  // just to re-establish it, so the setting is saved and the state
  // confirmed without touching the connection. `live` and not merely
  // `inRoom`: the store keeps the code through `error`, the reconnect
  // backoff and a latched `roomGone`, and in those states the old
  // condition short-circuited to a success toast that never retried —
  // the user had to press Leave and join again to get out of a dead room.
  if (room.status === 'live' && room.inRoom && room.code === code) {
    ui.showToast(`Household sync active — ${code}`, { kind: 'household' })
    return
  }

  // From here the card OWNS the outcome: a `code_taken` re-roll moves
  // this device into a different room than the one just saved, and the
  // watcher below adopts whatever code we actually ended up in.
  pendingHouseholdJoin = true
  if (isNewCode) room.create(code)
  else room.join(code)
  // The toast carries the share action: joining and sharing are the
  // same two-phone moment (ADR-0023).
  ui.showToast(`Joining household ${code}…`, {
    kind: 'household',
    actions: [{ label: 'Share link', run: () => void shareRoomLink(code) }],
    duration: 6000,
  })
}

/**
 * True while roomInput holds a freshly ROLLED (not typed) code — see
 * newRoomCode / joinHouseholdRoom (qodo 4128519644).
 */
const rolledNewCode = ref(false)

/**
 * True between pressing `Join now` and the store settling. It is what
 * lets the card adopt a code it did not choose: a rolled code the relay
 * already holds comes back `code_taken` and the store re-rolls
 * (ADR-0021), so the room this device ends up in is NOT the one saved a
 * moment ago — and a saved code we are not in means the next launch
 * joins a stranger's empty room.
 */
let pendingHouseholdJoin = false

watch(
  () => [room.status, room.code] as const,
  ([status, code]) => {
    if (!pendingHouseholdJoin) return
    // Any terminal answer ends the wait; only a LIVE frame has a code
    // worth adopting.
    if (status !== 'live') {
      if (status === 'error' || status === 'idle') pendingHouseholdJoin = false
      return
    }
    pendingHouseholdJoin = false
    if (!code || code === roomInput.value) return
    roomTyping = false
    roomInput.value = code
    ui.setHouseholdRoom(code)
    ui.showToast(`That code was taken — using ${code} instead`, {
      kind: 'household',
      duration: 6000,
    })
  },
)

/**
 * `New code` rolls AND joins (ADR-0049): the owner's point was that a
 * rolled code which does nothing until a second press is a dead end.
 */
function newRoomCodeAndJoin() {
  newRoomCode()
  joinHouseholdRoom()
}

/**
 * `Leave` is a FULL opt-out (ADR-0049): leaving the socket while KEEPING
 * the saved code means the household silently rejoins on the next launch,
 * which is the opposite of what pressing Leave asked for.
 */
/**
 * The danger CONFIRM (DESIGN.md: destructive is danger-outlined AND
 * confirmed). The app's confirm pattern is the non-blocking toast with
 * inline actions (the grocery-clear workflow) — a native `confirm()`
 * would freeze the tab and never match the toast surface.
 *
 * The prompt NAMES the room it will leave and the action leaves THAT one:
 * the code is captured when the prompt opens, so re-rolling or joining a
 * different code while the toast sits on screen cannot make the confirm
 * act against a room the question never mentioned. No `kind`: a kind names
 * a confirmation RESULT (data-test="<kind>-toast"), while this prompt is a
 * question whose actions carry their own hooks.
 */
function confirmLeaveHousehold() {
  const code = ui.householdRoom
  const target = code ?? null
  const question = target
    ? `Leave room ${target}? This device will not rejoin on future launches.`
    : 'Leave the household room? This device will not rejoin on future launches.'
  ui.showToast(question, {
    duration: 10_000,
    actions: [
      { label: 'Leave', run: () => leaveHouseholdCode(target) },
      { label: 'Cancel', run: () => ui.dismissToast() },
    ],
  })
}

/** Run the full opt-out against ONE code — the code the prompt named. */
function leaveHouseholdCode(code: string | null) {
  const restore = ui.householdRoom
  // Point the card at the room the prompt named, run the existing opt-out
  // (which stops the socket, clears the code and the saved join target),
  // then put the card's own field back — a device that re-rolled while the
  // toast was open must not lose the code it was about to join.
  ui.householdRoom = code ?? ''
  clearHouseholdRoom()
  ui.householdRoom = restore
}

function clearHouseholdRoom() {
  roomTyping = false
  rolledNewCode.value = false
  pendingHouseholdJoin = false
  const saved = ui.householdRoom
  // Only the room this card is ABOUT. A device that is live in a
  // Plan-tab or share-link room is holding a different socket, and
  // pressing the household card's Leave asked about the household room,
  // not about whatever else happens to be connected. With no saved code
  // there is nothing else to stop joining, so the live room IS the one
  // being left.
  const leavingHousehold = room.inRoom && (saved === '' || room.code === saved)
  if (leavingHousehold) room.leave()
  ui.setHouseholdRoom('')
  roomInput.value = ''
  ui.showToast(
    leavingHousehold
      ? 'Left the household room — it will not rejoin next launch'
      : `Stopped joining ${saved} — this device stays in the room it is in`,
  )
}

/* ---------- Backup & restore (ADR-0013) ---------- */

const backupInput = ref<HTMLInputElement | null>(null)

/** File staged for import: shown in the confirm dialog before it is applied. */
const pendingBackup = ref<File | null>(null)
const backupConfirmOpen = computed(() => pendingBackup.value !== null)

function downloadBackup(): void {
  let blob: Blob
  try {
  blob = new Blob([buildBackupZip() as BlobPart], { type: 'application/zip' })
  } catch (e) {
  // Registry-coverage violation (AGENTS.md standing rule) — fail loudly.
  ui.showToast(`Backup failed — ${e instanceof Error ? e.message : 'unknown error'}`, {
  duration: 6000,
  })
  return
  }
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
  const c = result.counts ?? { plans: 0, items: 0, history: 0, ingredients: 0, checks: 0, favourites: 0, ratings: 0 }
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

/* ---------- Import from Mealime (ADR-0058) ---------- */

/** One-shot migration: Mealime shuts down 2026-10-21. The bookmarklet on
 *  the user's bookmarks bar reads their Mealime favourites and copies a
 *  small JSON payload; the paste box below is the only ingress — the app
 *  itself NEVER contacts mealime.com (e2e-enforced). Matching is
 *  validate-first and applied atomically through the favourites store's
 *  record path (adds only, ADR-0031 semantics intact). */
const bookmarkletHref = mealimeBookmarkletHref()
const mealimeInput = ref('')
/** Non-null while the result report is on screen (success or empty run). */
const mealimeReport = ref<MealimeMatchResult & { added: number; removed: number } | null>(null)
/** Non-null while the SUCCESS modal is open: the report plus the catalog
 *  tiles (name + image) for the matched variant ids. The failure paths —
 *  malformed paste, all-miss, catalog-load failure — never open it. */
const mealimeModal = ref<
  (MealimeMatchResult & { added: number; removed: number }) & {
    catalogById: Map<number, { name: string; image: string }>
  }
| null>(null)

/** Resolve the matched variant ids against the SAME catalog slice the
 *  matcher ran on — the parent already awaits getCatalog(), so this is
 *  synchronous and cannot race; a failed load returns before any of it. */
function resolveImportCatalog(
  result: MealimeMatchResult,
  meta: ReadonlyArray<{ id: number; name: string; thumbnail_image_url: string }>,
): Map<number, { name: string; image: string }> {
  const byId = new Map(meta.map((m) => [m.id, m]))
  const tiles = new Map<number, { name: string; image: string }>()
  for (const match of result.matched) {
    const entry = byId.get(match.variantId)
    if (entry) {
      tiles.set(match.variantId, { name: entry.name, image: entry.thumbnail_image_url })
    }
  }
  return tiles
}

function clearMealimeReport() {
  mealimeReport.value = null
}

/** Dragging is the affordance; clicking on THIS page would run the
 *  bookmarklet against the wrong origin and dead-end, so say so instead. */
function onBookmarkletClick() {
  ui.showToast('Drag this button to your bookmarks bar, then click it on my.mealime.com', {
    duration: 6000,
  })
}

async function importMealimeFavourites(): Promise<void> {
  const text = mealimeInput.value
  const parsed = parseMealimePayload(text)
  if (!parsed.ok) {
    // Nothing applied; the paste stays in the box so it can be fixed.
    ui.showToast(`Couldn't import — ${parsed.error}`, { kind: 'error', duration: 6000 })
    return
  }
  let catalog
  try {
    catalog = await getCatalog()
  } catch {
    // The catalog failed to load — say so. getCatalog() memoizes the
    // rejection for this page load, so a reload (which has it back by
    // first paint anyway) is the recovery, not a retry here.
    ui.showToast("Couldn't import — the recipe catalog failed to load. Reload the page and try again.", {
      kind: 'error',
      duration: 6000,
    })
    return
  }
  // Mealime-catalog entries ONLY: a Mealime favourite must never star the
  // household's own recipes (ADR-0054, ids at or above USER_RECIPE_ID_BASE),
  // and a household recipe sharing a name must not make a Mealime name
  // match ambiguous.
  const result = matchMealimeFavourites(
    parsed.favourites,
    catalog.variantMeta.filter((m) => m.id < USER_RECIPE_ID_BASE),
  )
  const favourites = useFavouritesStore()
  // Override discipline (ADR-0058 amended): the override replaces the set
  // with the RESOLVED payload. A payload where NOTHING matched is a
  // match-layer failure, not a user opinion — the matching never guesses
  // (ADR-0058 §3), so it must never be allowed to tombstone the whole
  // set either. Favourites stay intact and the misses are reported.
  if (result.matched.length > 0) {
    const { added, removed } = favourites.importFavourites(result.matched.map((m) => m.variantId))
    mealimeInput.value = ''
    mealimeReport.value = { ...result, added, removed }
    // Success modal (ADR-0058 amendment): the applied import gets the
    // preview — including the honest zero, where the headline says the
    // favourites already match. All-miss never reaches this branch.
    mealimeModal.value = {
      ...result,
      added,
      removed,
      catalogById: resolveImportCatalog(result, catalog.variantMeta),
    }
  } else {
    mealimeReport.value = { ...result, added: 0, removed: 0 }
  }
}
</script>

<template>
  <section class="space-y-4 pb-4">
  <!-- Page head (EXPERIENCE.md §7): what the tab is, before the
       sections. The sections carry their own heads at the same step. -->
  <header class="space-y-1">
  <h1 class="text-headline-sm">Settings</h1>
  <p class="text-body-sm text-text-muted">
  How this device behaves — its identity, its household, its display and its data.
  </p>
  </header>

  <!-- Unit system (ADR-0047): how quantities, grocery lines and oven
  temperatures READ on this device. The catalog stays canonical; only the
  display converts, so nothing stored ever changes. `dual` — the default —
  is the catalog exactly as authored. -->
  <!-- ADR-0068 level 1: every section is an index card — paper fill,
       1px keyline, 12px radius, NO shadow (the old flat `bg-surface`
       block became the raised card). -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="unit-system-card">
  <h2 class="text-headline-sm">Unit system</h2>
  <p class="text-body-sm text-text-muted">
  Convert ingredient amounts, grocery lines and oven temperatures on this device. Your recipes, plan and checked items are
  stored in metric and stay that way.
  </p>
  <div
  class="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2"
  data-test="unit-system-row"
  role="group"
  aria-label="Unit system"
  >
  <span class="flex min-w-0 items-center gap-2 text-sm font-medium">
  <Scale :size="16" aria-hidden="true" class="shrink-0 text-text-muted" />
  Measure in
  </span>
  <div class="flex shrink-0 items-center rounded-lg border border-border-strong">
  <button
  v-for="system in UNIT_SYSTEMS"
  :key="system"
  class="px-3 py-2 text-sm font-semibold"
  :class="
  ui.unitSystem === system
    ? 'rounded-lg bg-brand-tint text-brand-text'
    : 'text-text-muted'
  "
  :aria-pressed="ui.unitSystem === system"
  :aria-label="`${UNIT_SYSTEM_LABEL[system]} units`"
  :data-test="`unit-system-${system}`"
  @click="setUnitSystem(system)"
  >
  {{ UNIT_SYSTEM_LABEL[system] }}
  </button>
  </div>
  </div>
  <p class="text-body-sm text-text-muted" data-test="unit-system-note">
  {{ UNIT_SYSTEM_NOTE[ui.unitSystem] }}
  </p>
  </div>

  <!-- Default servings (ADR-0037): the remembered starting count. Set it
  once here, or just change servings on any recipe and this follows. -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="default-servings-card">
  <h2 class="text-headline-sm">Default servings</h2>
  <p class="text-body-sm text-text-muted">
  New recipes, generated plans and re-planned meals start at this number. Changing servings on a recipe or on a planned meal
  remembers it here for next time.
  </p>
  <div
  class="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2"
  data-test="default-servings-row"
  >
  <span class="flex min-w-0 items-center gap-2 text-sm font-medium">
  <Utensils :size="16" aria-hidden="true" class="shrink-0 text-text-muted" />
  Servings per recipe
  </span>
  <div class="flex shrink-0 items-center rounded-lg border border-border-strong">
  <button
  class="flex size-11 items-center justify-center"
  :disabled="!canFewerDefault"
  aria-label="Fewer default servings"
  data-test="default-servings-fewer"
  @click="bumpDefaultServings(-1)"
  >
  <Minus :size="16" aria-hidden="true" />
  </button>
  <span
  class="w-8 text-center font-mono-data text-sm font-semibold tabular-nums"
  aria-label="Default servings"
  data-test="default-servings-value"
  >{{ ui.defaultServings }}</span
  >
  <button
  class="flex size-11 items-center justify-center"
  :disabled="!canMoreDefault"
  aria-label="More default servings"
  data-test="default-servings-more"
  @click="bumpDefaultServings(1)"
  >
  <Plus :size="16" aria-hidden="true" />
  </button>
  </div>
  </div>
  <p class="text-body-sm text-text-muted" data-test="default-servings-note">
  Recipes already in your plan keep the servings they were added with.
  </p>
  </div>

  <!-- Dietary restrictions (the restriction ADR): upstream's own verdicts.
  A restricted recipe is REMOVED from discovery (recipes, search,
  Auto-Plan) and every surviving recipe displays upstream's own substituted
  ingredients. Recipes already in the plan stay. Not synced to the
  household room (deliberately deferred). -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="dietary-restrictions">
  <h2 class="text-headline-sm">Dietary restrictions</h2>
  <p class="text-body-sm text-text-muted">
  Recipes containing these are hidden from Recipes, search and Auto-Plan, and ingredients are swapped to restriction-safe substitutes the way Mealime itself does it. Recipes already in your plan stay.
  </p>
  <div
  class="flex flex-wrap gap-2"
  role="group"
  aria-label="Dietary restrictions"
  data-test="restriction-chips"
  >
  <button
  v-for="restriction in RESTRICTIONS"
  :key="restriction.id"
  class="flex items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-semibold"
  :class="
  isActiveRestriction(restriction.id)
    ? 'border-brand bg-brand-tint text-brand-text'
    : 'border-border bg-surface text-text-muted'
  "
  :aria-pressed="isActiveRestriction(restriction.id)"
  :aria-label="`${restriction.label} restriction`"
  :data-test="`restriction-chip-${restriction.slug}`"
  @click="toggleRestriction(restriction.id)"
  >
  <component
  :is="RESTRICTION_ICONS[restriction.slug]"
  :size="16"
  aria-hidden="true"
  />
  {{ restriction.label }}
  </button>
  </div>
  <p class="text-body-sm text-text-muted" data-test="dietary-restrictions-note">
  {{ restrictionNote }}
  </p>
  </div>

  <!-- Household sync: set a room code once and this device re-joins it
  on every launch, so the other phone needs no share link. The room
  itself is unchanged (ephemeral relay, LWW state, ADR-0006/0011) —
  this is only a persisted default join target (ADR-0019). -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="household-card">
  <h2 class="text-headline-sm">Household sync</h2>
  <p class="text-body-sm text-text-muted">
  Sync your plan, grocery checks, extras and recipe filters with the other phone. Join once — this device re-joins the room automatically every time the app opens.
  </p>
  <!-- Status is shown only while CONNECTED (ADR-0049): "active" while the
       socket is down would be a claim the relay has not made. The headcount
       is the relay's number, and `null` (not told yet) is worded as
       absence rather than as one person. -->
  <p
  v-if="householdConnected"
  class="text-body-sm font-semibold text-text"
  data-test="household-room-status"
  >
  Household sync active — <span class="font-mono-data">{{ householdCode }}</span><template v-if="room.peers"> · <span class="font-mono-data tabular-nums">{{ room.peers }}</span> in room</template>
  </p>
  <!-- ADR-0063: THIS device's identity — the avatar preview hashes the
       same display name the room sees, and the rename clamps exactly
       like the relay (one shared sanitizer on the store action) then
       pushes a `profile` frame while connected. Editing never touches
       the id. The input is the ONE field class (ADR-0065). -->
  <div class="flex items-center gap-3">
  <PersonAvatar :name="identity.displayName" data-test="identity-avatar" />
  <label class="min-w-0 flex-1 text-body-sm">
  <span class="mb-1 block font-medium">Your name</span>
  <input
  v-model="nameInput"
  type="text"
  inputmode="text"
  :maxlength="40"
  :placeholder="identity.displayName"
  aria-label="Your display name in the household room"
  data-test="identity-name-input"
  class="field w-full px-3"
  @input="onNameInput"
  @blur="onNameBlur"
  @keydown.enter="($event.target as HTMLInputElement).blur()"
  />
  <span class="mt-1 block text-text-muted">Shown to the others in your room. Changes update everyone live.</span>
  </label>
  </div>
  <!-- Always rendered, never behind a saved-room condition: the note
  on the History tab points here, and a member in a Plan-tab
  room (or with no household code yet) must still be able to
  opt out. The control only means anything once a room exists,
  which the surrounding card says out loud. -->
  <!-- ADR-0032's toggle in its keylined row (ADR-0068 level 1): the
       checklist box takes the shared 20px `.check-box` language — the
       tick is the theme-flipped tomato. -->
  <div
  class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5"
  data-test="history-sharing-row"
  >
  <label class="flex min-w-0 flex-1 items-start gap-2.5 text-body-sm">
  <input
  v-model="ui.shareCookedHistory"
  type="checkbox"
  class="check-box mt-0.5"
  aria-label="Share cooked history with the household room"
  data-test="share-cooked-history"
  />
  <span>
  Sync <strong>cooked history</strong> with the household.
  <span class="block">
  On by default — everyone in the room shares one cooking log, and histories merge rather than replace.
  Turn this off to stop sharing new cooks: this device will no longer send its history to the room, and future snapshots won't include it. Cooks shared earlier stay in the room — sharing only controls what goes out from here.
  </span>
  </span>
  </label>
  </div>
  <div class="flex gap-2">
  <input
  v-model="roomInput"
  type="text"
  inputmode="text"
  maxlength="40"
  placeholder="amber-falcon-lantern"
  aria-label="Household room code"
  data-test="household-room-input"
  @input="onRoomInput"
  @blur="onRoomBlur"
  class="field min-w-0 flex-1 px-3"
  />
  <button
  class="h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong disabled:opacity-50"
  data-test="household-room-join"
  aria-label="Save this household room code and join it now"
  :disabled="!canJoinRoom"
  @click="joinHouseholdRoom"
  >
  Join now
  </button>
  </div>
  <div class="flex flex-wrap gap-2">
  <!-- Outlined secondaries on raised paper (ADR-0068): the card's ONE
       filled tomato is `Join now` — `New code` rolls AND joins, so it is
       a secondary path to the same action, never a second tomato. -->
  <button
  class="h-11 rounded-lg border border-border-strong bg-surface-raised px-3 text-xs font-semibold text-text active:bg-surface-sunken disabled:opacity-50"
  data-test="share-room"
  :disabled="!shareableCodeText"
  :aria-label="`Share the join link for household room ${shareableCodeText}`"
  @click="shareRoomLink()"
  >
  <Link :size="14" aria-hidden="true" class="mr-1 inline" />
  Share room link
  </button>
  <button
  class="h-11 rounded-lg border border-border-strong bg-surface-raised px-3 text-xs font-semibold text-text active:bg-surface-sunken"
  data-test="household-room-new"
  aria-label="Generate a new three-word room code and join it"
  @click="newRoomCodeAndJoin"
  >
  <Dices :size="14" aria-hidden="true" class="mr-1 inline" />
  New code
  </button>
  <!-- Destructive: the DANGER OUTLINE (DESIGN.md Selection and actions);
       the confirm arrives as the shared non-blocking toast actions, not
       a native confirm() — same workflow the grocery clear uses. -->
  <button
  v-if="householdCode || room.inRoom"
  class="h-11 rounded-lg border border-danger bg-surface-raised px-3 text-xs font-semibold text-danger active:bg-surface-sunken"
  data-test="household-room-clear"
  aria-label="Leave the household room and stop joining it on future launches"
  @click="confirmLeaveHousehold()"
  >
  Leave
  </button>
  </div>
  </div>

  <!-- Backup & restore: ALWAYS rendered (restoring a backup is precisely
  what a fresh device needs, and this view is reachable on one). -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border">
  <h2 class="text-headline-sm">Backup &amp; restore</h2>
  <p class="text-body-sm text-text-muted">
  Save everything (plan, groceries, history, favourites, settings) to a file — or restore one. Works fully offline.
  </p>
  <div class="flex gap-2">
  <button
  class="flex h-11 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong"
  data-test="export-settings"
  aria-label="Download backup file"
  @click="downloadBackup"
  >
  <Download :size="16" aria-hidden="true" class="mr-1 inline" />
  Export backup
  </button>
  <button
  class="flex h-11 flex-1 items-center justify-center rounded-xl border border-border-strong bg-surface-raised px-4 text-sm font-semibold text-text active:bg-surface-sunken"
  data-test="import-settings"
  aria-label="Choose a backup file to restore"
  @click="backupInput?.click()"
  >
  <Upload :size="16" aria-hidden="true" class="mr-1 inline" />
  Import backup
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

  <!-- Import from Mealime (ADR-0058): a one-shot migration before
  Mealime shuts down (2026-10-21). The bookmarklet link is dragged to the
  user's bookmarks bar and clicked on my.mealime.com, where it copies the
  favourites payload to the clipboard; the paste box here is the only
  ingress — this app never contacts mealime.com. -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="mealime-import-section">
  <h2 class="text-headline-sm">Import from Mealime</h2>
  <p class="text-body-sm font-semibold" data-test="mealime-import-notice">
  Mealime closes on 21 October 2026 — import your favourites before then. They sync to your
  household like any favourites you star here.
  </p>
  <ol class="list-decimal space-y-1 pl-4 text-body-sm text-text-muted" aria-label="How to import your Mealime favourites">
  <li>
  Show your browser's bookmarks bar
  <span class="opacity-80">(Ctrl + Shift + B, or Command + Shift + B on Mac)</span>.
  </li>
  <li>
  Drag this button to the bookmarks bar:
  <a
  :href="bookmarkletHref"
  class="mt-1 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs font-semibold text-brand-text"
  data-test="mealime-bookmarklet-link"
  aria-label="Flambette: copy my favourites — drag this to your bookmarks bar, then click it on my.mealime.com"
  @click.prevent="onBookmarkletClick"
  >Flambette: copy my favourites</a>
  </li>
  <li>
  Log in at
  <a
  href="https://my.mealime.com"
  target="_blank"
  rel="noopener noreferrer"
  class="font-medium underline underline-offset-2"
  aria-label="Open my.mealime.com in a new tab to log in"
  data-test="mealime-login-link"
  >my.mealime.com</a>.
  </li>
  <li>
  On the Mealime site, click the bookmark — it copies your favourites. Come back here and paste:
  </li>
  </ol>
  <textarea
  v-model="mealimeInput"
  class="field w-full px-3 py-2 text-xs"
  placeholder='Paste here — the text the bookmark copied (starts with {"source":…}).'
  aria-label="Paste your copied Mealime favourites here"
  data-test="mealime-import-input"
  @input="clearMealimeReport"
  ></textarea>
  <button
  class="h-11 w-full rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong"
  data-test="mealime-import-button"
  aria-label="Import the pasted Mealime favourites"
  @click="importMealimeFavourites"
  >
  Import favourites
  </button>
  <!-- The wording lives in `mealimeReportLines` — the success modal
  (ADR-0058 amendment) repeats it, so both surfaces render ONE source. -->
  <p
  v-if="mealimeReport"
  class="text-xs"
  data-test="mealime-import-report"
  aria-live="polite"
  >
  <template v-for="(line, i) in mealimeReportLines(mealimeReport)" :key="i">
  {{ line }}<br v-if="i < mealimeReportLines(mealimeReport).length - 1" />
  </template>
  </p>
  </div>

  <p class="px-1 text-body-sm text-text-muted">
  Everything lives on this device — the app never talks to a server about your data, so a backup file is the
  only way to move it.
  </p>

  <!-- About (the render's closing section, reconciled to the REPO's
       real data): the build's version (ADR-0039), the offline-first
       guarantee and the catalog's real size. The version chip is a
       LABEL, not a control — the changelog lives on the header's
       version button (ADR-0060), which this card points to in words
       rather than faking a second trigger. -->
  <div class="space-y-2.5 rounded-xl bg-surface-raised p-4 ring-1 ring-border" data-test="about-card">
  <div class="flex flex-wrap items-center gap-2">
  <h2 class="text-headline-sm">About Flambette</h2>
  <span
  class="rounded-full border border-border bg-surface px-2 py-0.5 font-mono-data text-xs font-semibold text-text"
  data-test="about-version"
  >{{ appVersion }}</span>
  </div>
  <p class="text-body-sm text-text-muted">
  100% offline-first — the whole catalog, its photos and this device's settings stay on this
  device and never reach a server. Household sync is the one exception you choose: joining a room
  shares your plan, grocery list and preferences through the room relay so the other devices see
  them. The header's version tells you what is running; tapping it opens the changelog.
  </p>
  </div>

  <!-- Import-backup confirm dialog -->
  <div
  v-if="backupConfirmOpen"
  class="fixed inset-0 z-50 flex items-center justify-center modal-scrim p-4"
  @click.self="cancelBackupImport"
  >
  <!-- ADR-0068: a settings section is a level-1 card — paper fill,
       1px keyline, 12px radius, NO shadow. -->
  <div
  class="w-full max-w-md space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-border"
  role="dialog"
  aria-label="Confirm backup restore"
  >
  <h3 class="text-headline-sm">Restore this backup?</h3>
  <p class="text-body-sm text-text-muted">
  This overwrites your current plan, checked items, cooked history, favourites, custom ingredients and settings with the backup’s contents. Recipe ratings are merged instead — a rating you set after the backup was taken is kept.
  </p>
  <p class="truncate text-body-sm">
  {{ pendingBackup?.name }}
  </p>
  <div class="flex gap-2">
  <button
  class="h-11 flex-1 rounded-xl border border-border-strong bg-surface-raised text-sm font-semibold text-text active:bg-surface-sunken"
  data-test="import-settings-cancel"
  aria-label="Cancel restore"
  @click="cancelBackupImport"
  >
  Cancel
  </button>
  <button
  class="h-11 flex-1 rounded-xl bg-brand text-sm font-semibold text-on-brand transition-[background-color,transform] hover:bg-brand-strong active:scale-[0.98] active:bg-brand-strong"
  data-test="import-settings-confirm"
  aria-label="Restore backup"
  @click="confirmBackupImport"
  >
  Restore
  </button>
  </div>
  </div>
  </div>

  <!-- Import-from-Mealime SUCCESS modal (ADR-0058 amendment): the
  applied import gets the preview. v-if-gated MOUNT, so one mount == one
  open and the focus restore runs on unmount (NutritionModal's pattern). -->
  <MealimeImportModal
  v-if="mealimeModal"
  :result="mealimeModal"
  :catalog-by-id="mealimeModal.catalogById"
  @close="mealimeModal = null"
  />
  </section>
</template>
