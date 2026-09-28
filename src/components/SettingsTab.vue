<script setup lang="ts">
import { computed, ref } from 'vue'
import { applyBackup, backupFileName, buildBackupZip } from '../lib/backup'
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
