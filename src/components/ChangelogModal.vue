<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import AppModal from './AppModal.vue'
import { parseChangelog } from '../lib/changelog'
import type { ChangelogDoc, NormalizedVersion } from '../lib/changelog'

/**
 * The changelog modal (ADR-0060 §5–6). Opens from the header version button
 * (`data-test="app-version"`); the PARENT mounts it `v-if`-gated like every
 * other modal — one mount == one open, and AppModal owns the a11y machinery
 * (teleport, focus trap, Escape, scrim, focus restore).
 *
 * Data is lazy-fetched same-origin on FIRST open and cached in memory for
 * the session. A fetch failure renders an error state INSIDE the modal
 * (retry affordance) — never a toast loop, never a crash. The app works
 * offline, and the changelog is the least critical surface in it.
 */
const emit = defineEmits<{ close: [] }>()

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<ChangelogDoc | null>(null)

/** In-memory session cache — survives reopens within a page load. */
let cache: ChangelogDoc | null = null

async function load() {
  if (cache) {
    data.value = cache
    return
  }
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/data/changelog.json')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as ChangelogDoc
    // A null parse means "no valid versions" (empty/malformed artifact) —
    // render the modal's empty state, not a blank panel; cache it too so a
    // reopen doesn't re-fetch a document we already judged unusable.
    const parsed =
      parseChangelog(json) ?? { generatedAt: '', versions: [] }
    cache = parsed
    data.value = parsed
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load the changelog'
  } finally {
    loading.value = false
  }
}

// The parent mounts this component v-if-gated, so setup runs at open time.
void load()

const featured = computed<NormalizedVersion | null>(() => {
  if (!data.value) return null
  return data.value.versions[0] ?? null
})

function retry() {
  void load()
}
</script>

<template>
  <AppModal
    dialog-label="What's new"
    overlay-class="z-50 flex items-end justify-center modal-scrim sm:items-center"
    panel-class="max-h-[85vh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-surface-raised p-4 sm:rounded-2xl"
    panel-test="changelog-modal"
    @close="emit('close')"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="text-body-sm font-bold tracking-tight">What's new</h3>
        <p v-if="featured" class="text-label-md text-text-muted">
          {{ featured.version }} — {{ featured.date }}
        </p>
      </div>
      <button
        class="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-sunken"
        aria-label="Close changelog"
        data-test="changelog-modal-close"
        @click="emit('close')"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </div>

    <!-- Loading state -->
    <div v-if="loading && !data" class="mt-3 flex items-center gap-2 text-body-sm text-text-muted" data-test="changelog-loading">
      <div class="size-5 animate-spin rounded-full border-2 border-border border-t-brand" role="status">
        <span class="sr-only">Loading…</span>
      </div>
      Loading the changelog…
    </div>

    <!-- Error state with retry -->
    <div
      v-else-if="error && !data"
      class="mt-3 rounded-lg bg-warning/10 p-3 text-body-sm text-text-dark"
      data-test="changelog-error"
    >
      <p class="font-semibold">Couldn't load the changelog</p>
      <p class="text-text-muted">{{ error }}</p>
      <button
        class="mt-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand"
        data-test="changelog-retry"
        @click="retry"
      >
        Retry
      </button>
    </div>

    <!-- Empty state -->
    <div v-else-if="data && data.versions.length === 0" class="mt-3 text-body-sm text-text-muted">
      No changelog entries yet — check back after the next release.
    </div>

    <!-- Version list -->
    <div v-else-if="data" class="mt-3 space-y-3" data-test="changelog-versions">
      <div
        v-for="version in data.versions"
        :key="version.version"
        class="rounded-lg border border-border p-3"
        :data-test="`changelog-version-${version.version}`"
      >
        <p class="text-body-sm font-semibold">
          {{ version.title }}
          <span class="font-normal text-text-muted"> ({{ version.version }}, {{ version.date }})</span>
        </p>
        <p v-if="version.features?.length" class="mt-1 text-label-md text-text-muted">
          <span class="font-semibold text-brand-text">Features</span>
          <ul class="ml-4 mt-1 list-disc space-y-0.5">
            <li v-for="(entry, i) in version.features" :key="i">
              {{ entry.text }}
              <span v-if="entry.adr" class="font-normal">({{ entry.adr }})</span>
            </li>
          </ul>
        </p>
        <p v-if="version.fixes?.length" class="mt-1 text-label-md text-text-muted">
          <span class="font-semibold">Fixes</span>
          <ul class="ml-4 mt-1 list-disc space-y-0.5">
            <li v-for="(entry, i) in version.fixes" :key="i">
              {{ entry.text }}
            </li>
          </ul>
        </p>
      </div>
    </div>
  </AppModal>
</template>
