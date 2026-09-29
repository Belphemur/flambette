<script setup lang="ts">
import { computed, ref } from 'vue'
import { applyBackup, backupFileName, buildBackupZip } from '../lib/backup'
import { generateRoomCode, normalizeRoomCode } from '../lib/roomWords'
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

/* ---------- Household sync (ADR-0019) ---------- */

/** Draft code, seeded from the persisted setting. */
const roomInput = ref(ui.householdRoom)

const householdCode = computed(() => ui.householdRoom)
/** Both shapes normalize (ADR-0021): three words, or a legacy code. */
const canSaveRoom = computed(() => normalizeRoomCode(roomInput.value) !== '')
/** The live room differs from the saved one, so adopting it is meaningful. */
const adoptableRoom = computed(() =>
  room.inRoom && room.code && room.code !== ui.householdRoom ? room.code : null,
)

/** Roll a fresh three-word code into the field (ADR-0021). */
function newRoomCode() {
  roomInput.value = generateRoomCode()
}

/** The live room, else the saved setting — whichever we can share. */
const shareableCodeText = computed(() => shareableCode())

function saveHouseholdRoom(joinNow: boolean) {
  const code = normalizeRoomCode(roomInput.value)
  if (!code) {
    ui.showToast('Room codes look like amber-falcon-lantern', { kind: 'error' })
    return
  }
  ui.setHouseholdRoom(code)
  roomInput.value = code
  if (joinNow) {
    room.join(code)
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
function adoptCurrentRoom() {
  const code = adoptableRoom.value
  if (!code) return
  roomInput.value = code
  ui.setHouseholdRoom(code)
  ui.showToast(`Household sync active — ${code}`, { kind: 'household' })
}

function clearHouseholdRoom() {
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
</script>

<template>
  <section class="space-y-4 pb-4">
    <h2 class="text-lg font-bold tracking-tight">Settings</h2>

    <!-- Household sync: set a room code once and this device re-joins it
         on every launch, so the other phone needs no share link. The room
         itself is unchanged (ephemeral relay, LWW state, ADR-0006/0011) —
         this is only a persisted default join target (ADR-0019). -->
    <div class="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-950" data-test="household-card">
      <span class="text-sm font-bold tracking-tight">Household sync</span>
      <p class="text-xs dark:text-stone-400">
        Sync your plan, grocery checks and extras with the other phone. Set the room code once — this device joins it automatically every time the app opens.
      </p>
      <p
        v-if="householdCode"
        class="text-xs font-semibold text-green-700 dark:text-green-400"
        data-test="household-room-status"
      >
        Household sync active — {{ householdCode }}
      </p>
      <div class="flex gap-2">
        <input
          v-model="roomInput"
          type="text"
          inputmode="text"
          maxlength="40"
          placeholder="amber-falcon-lantern"
          aria-label="Household room code"
          data-test="household-room-input"
          class="h-11 min-w-0 flex-1 rounded-xl border bg-white px-3 text-sm outline-none focus:border-primary dark:border-stone-700 dark:bg-stone-900"
        />
        <button
          class="h-11 rounded-xl bg-primary px-3 text-sm font-semibold text-white active:bg-primary-dark disabled:opacity-50"
          data-test="household-room-save"
          aria-label="Save household room code"
          :disabled="!canSaveRoom"
          @click="saveHouseholdRoom(false)"
        >
          Save
        </button>
        <button
          class="h-11 rounded-xl border dark:border-stone-700 px-3 text-sm font-medium dark:text-stone-300 dark:hover:bg-stone-800 disabled:opacity-50"
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
          class="h-9 rounded-lg border px-3 text-xs font-medium dark:border-stone-700 dark:text-stone-300 disabled:opacity-50"
          data-test="share-room"
          :disabled="!shareableCodeText"
          :aria-label="`Share the join link for household room ${shareableCodeText}`"
          @click="shareRoomLink()"
        >
          🔗 Share room link
        </button>
        <button
          class="h-9 rounded-lg border px-3 text-xs font-medium dark:border-stone-700 dark:text-stone-300"
          data-test="household-room-new"
          aria-label="Generate a new three-word room code"
          @click="newRoomCode"
        >
          🎲 New code
        </button>
        <button
          v-if="adoptableRoom"
          class="h-9 rounded-lg border px-3 text-xs font-medium dark:border-stone-700 dark:text-stone-300"
          data-test="household-room-adopt"
          :aria-label="`Use live room ${adoptableRoom} as the household room`"
          @click="adoptCurrentRoom"
        >
          Sync with live room {{ adoptableRoom }}
        </button>
        <button
          v-if="householdCode"
          class="h-9 rounded-lg border px-3 text-xs font-medium dark:border-stone-700 dark:text-stone-300"
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

    <p class="px-1 text-xs text-stone-400">
      Everything lives on this device — the app never talks to a server about your data, so a backup file is the
      only way to move it.
    </p>

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
  </section>
</template>
