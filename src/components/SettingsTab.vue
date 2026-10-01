<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Download, Link, Dices, Minus, Plus, Upload, Utensils } from 'lucide-vue-next'
import { applyBackup, backupFileName, buildBackupZip } from '../lib/backup'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
import { MAX_SERVINGS, MIN_SERVINGS } from '../lib/servings'
import { useShareRoomLink } from '../composables/useShareRoomLink'
import { useRoomStore } from '../stores/room'
import { useUiStore } from '../stores/ui'

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
const { shareRoomLink, shareableCode } = useShareRoomLink()

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

const canFewerDefault = computed(() => ui.defaultServings > MIN_SERVINGS)
const canMoreDefault = computed(() => ui.defaultServings < MAX_SERVINGS)

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
const canSaveRoom = computed(() => normalizeRoomCode(roomInput.value) !== '')
/** The live room differs from the saved one, so adopting it is meaningful. */
const adoptableRoom = computed(() =>
  room.inRoom && room.code && room.code !== ui.householdRoom ? room.code : null,
)

/** Roll a fresh three-word code into the field (ADR-0021). */
function newRoomCode() {
  roomTyping = false
  roomInput.value = generateRoomCode()
  // The rolled code exists NOWHERE yet: Join must CREATE it on the relay
  // instead of joining (qodo 4128519644).
  rolledNewCode.value = true
}

/** The live room, else the saved setting — whichever we can share. */
const shareableCodeText = computed(() => shareableCode())

function saveHouseholdRoom(joinNow: boolean) {
  roomTyping = false
  const code = normalizeRoomCode(roomInput.value)
  if (!code) {
  ui.showToast('Room codes look like amber-falcon-lantern', { kind: 'error' })
  return
  }
  // Capture before clearing: a freshly ROLLED code is CREATED on the
  // relay, not joined. Since ADR-0026 a join would establish the room
  // too — but it would also silently ADOPT an existing room if the
  // rolled code collided with a live one, whereas `create` answers
  // `code_taken` and we re-roll (qodo 4128519644).
  const isNewCode = rolledNewCode.value
  rolledNewCode.value = false
  ui.setHouseholdRoom(code)
  roomInput.value = code
  if (joinNow) {
  if (isNewCode) room.create(code)
  else room.join(code)
  // The toast carries the share action: joining and sharing are the
  // same two-phone moment (ADR-0023).
  ui.showToast(`Joining household ${code}…`, {
  kind: 'household',
  actions: [{ label: 'Share link', run: () => void shareRoomLink(code) }],
  duration: 6000,
  })
  } else {
  ui.showToast(`Household room ${code} saved — sync starts on next launch`)
  }
}

/** Point the persistent setting at the room we're already in. */
/**
 * True while roomInput holds a freshly ROLLED (not typed) code — see
 * newRoomCode / saveHouseholdRoom (qodo 4128519644).
 */
const rolledNewCode = ref(false)

function adoptCurrentRoom() {
  const code = adoptableRoom.value
  if (!code) return
  roomTyping = false
  rolledNewCode.value = false
  roomInput.value = code
  ui.setHouseholdRoom(code)
  ui.showToast(`Household sync active — ${code}`, { kind: 'household' })
}

function clearHouseholdRoom() {
  roomTyping = false
  rolledNewCode.value = false
  ui.setHouseholdRoom('')
  roomInput.value = ''
  ui.showToast('Household sync turned off')
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
</script>

<template>
  <section class="space-y-4 pb-4">
  <h2 class="text-lg font-bold tracking-tight">Settings</h2>

  <!-- Default servings (ADR-0037): the remembered starting count. Set it
  once here, or just change servings on any recipe and this follows. -->
  <div class="space-y-2 rounded-xl bg-surface p-3" data-test="default-servings-card">
  <span class="text-sm font-bold tracking-tight">Default servings</span>
  <p class="text-xs">
  New recipes, generated plans and re-planned meals start at this number. Change servings while cooking a recipe and this
  remembers it for next time.
  </p>
  <div
  class="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2"
  data-test="default-servings-row"
  >
  <span class="flex min-w-0 items-center gap-2 text-sm font-medium">
  <Utensils :size="16" aria-hidden="true" class="shrink-0 text-text-muted" />
  Servings per recipe
  </span>
  <div class="flex shrink-0 items-center rounded-lg border">
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
  class="w-8 text-center text-sm font-semibold tabular-nums"
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
  <p class="text-xs text-text-muted" data-test="default-servings-note">
  Recipes already in your plan keep the servings they were added with.
  </p>
  </div>

  <!-- Household sync: set a room code once and this device re-joins it
  on every launch, so the other phone needs no share link. The room
  itself is unchanged (ephemeral relay, LWW state, ADR-0006/0011) —
  this is only a persisted default join target (ADR-0019). -->
  <div class="space-y-2 rounded-xl bg-surface p-3" data-test="household-card">
  <span class="text-sm font-bold tracking-tight">Household sync</span>
  <p class="text-xs">
  Sync your plan, grocery checks, extras and recipe filters with the other phone. Set the room code once — this device joins it automatically every time the app opens.
  </p>
  <p
  v-if="householdCode"
  class="text-xs font-semibold text-text"
  data-test="household-room-status"
  >
  Household sync active — {{ householdCode }}
  </p>
  <!-- Always rendered, never behind a saved-room condition: the note
  on the History tab points here, and a member in a Plan-tab
  room (or with no household code yet) must still be able to
  opt out. The control only means anything once a room exists,
  which the surrounding card says out loud. -->
  <div
  class="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2"
  data-test="history-sharing-row"
  >
  <label class="flex min-w-0 flex-1 items-start gap-2 text-xs">
  <input
  v-model="ui.shareCookedHistory"
  type="checkbox"
  class="mt-0.5 size-4 shrink-0"
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
  class="h-11 min-w-0 flex-1 rounded-xl border bg-surface-raised px-3 text-sm outline-none focus:border-brand-text"
  />
  <button
  class="h-11 rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand active:bg-brand-strong disabled:opacity-50"
  data-test="household-room-save"
  aria-label="Save household room code"
  :disabled="!canSaveRoom"
  @click="saveHouseholdRoom(false)"
  >
  Save
  </button>
  <button
  class="h-11 rounded-xl border px-3 text-sm font-medium disabled:opacity-50"
  data-test="household-room-join"
  aria-label="Save household room code and join now"
  :disabled="!canSaveRoom"
  @click="saveHouseholdRoom(true)"
  >
  Join now
  </button>
  </div>
  <div class="flex flex-wrap gap-2">
  <button
  class="h-11 rounded-lg border px-3 text-xs font-medium disabled:opacity-50"
  data-test="share-room"
  :disabled="!shareableCodeText"
  :aria-label="`Share the join link for household room ${shareableCodeText}`"
  @click="shareRoomLink()"
  >
  <Link :size="14" aria-hidden="true" class="mr-1 inline" />
  Share room link
  </button>
  <button
  class="h-11 rounded-lg border px-3 text-xs font-medium"
  data-test="household-room-new"
  aria-label="Generate a new three-word room code"
  @click="newRoomCode"
  >
  <Dices :size="14" aria-hidden="true" class="mr-1 inline" />
  New code
  </button>
  <button
  v-if="adoptableRoom"
  class="h-11 rounded-lg border px-3 text-xs font-medium"
  data-test="household-room-adopt"
  :aria-label="`Use live room ${adoptableRoom} as the household room`"
  @click="adoptCurrentRoom"
  >
  Sync with live room {{ adoptableRoom }}
  </button>
  <button
  v-if="householdCode"
  class="h-11 rounded-lg border px-3 text-xs font-medium"
  data-test="household-room-clear"
  aria-label="Turn off household sync"
  @click="clearHouseholdRoom"
  >
  Turn off
  </button>
  </div>
  </div>

  <!-- Backup & restore: ALWAYS rendered (restoring a backup is precisely
  what a fresh device needs, and this view is reachable on one). -->
  <div class="space-y-2 rounded-xl bg-surface p-3">
  <span class="text-sm font-bold tracking-tight">Backup &amp; restore</span>
  <p class="text-xs">
  Save everything (plan, groceries, history, favourites, settings) to a file — or restore one. Works fully offline.
  </p>
  <div class="flex gap-2">
  <button
  class="flex h-11 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand active:bg-brand-strong"
  data-test="export-settings"
  aria-label="Download backup file"
  @click="downloadBackup"
  >
  <Download :size="16" aria-hidden="true" class="mr-1 inline" />
  Export backup
  </button>
  <button
  class="flex h-11 flex-1 items-center justify-center rounded-xl border px-4 text-sm font-medium"
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

  <p class="px-1 text-xs text-text-muted">
  Everything lives on this device — the app never talks to a server about your data, so a backup file is the
  only way to move it.
  </p>

  <!-- Import-backup confirm dialog -->
  <div
  v-if="backupConfirmOpen"
  class="fixed inset-0 z-50 flex items-center justify-center bg-surface-dark/50 p-4"
  @click.self="cancelBackupImport"
  >
  <div
  class="w-full max-w-md space-y-3 rounded-2xl bg-surface-raised p-4 shadow-xl"
  role="dialog"
  aria-label="Confirm backup restore"
  >
  <h3 class="text-sm font-bold tracking-tight">Restore this backup?</h3>
  <p class="text-xs">
  This overwrites your current plan, checked items, cooked history, favourites, custom ingredients and settings with the backup’s contents. Recipe ratings are merged instead — a rating you set after the backup was taken is kept.
  </p>
  <p class="truncate text-xs">
  {{ pendingBackup?.name }}
  </p>
  <div class="flex gap-2">
  <button
  class="h-11 flex-1 rounded-xl border text-sm font-medium"
  data-test="import-settings-cancel"
  aria-label="Cancel restore"
  @click="cancelBackupImport"
  >
  Cancel
  </button>
  <button
  class="h-11 flex-1 rounded-xl bg-brand text-sm font-semibold text-on-brand active:bg-brand-strong"
  data-test="import-settings-confirm"
  aria-label="Restore backup"
  @click="confirmBackupImport"
  >
  Restore
  </button>
  </div>
  </div>
  </div>
  </section>
</template>
