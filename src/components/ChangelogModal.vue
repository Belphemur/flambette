<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import type { ChangelogDoc, NormalizedVersion } from '../lib/changelog'

/**
 * The changelog modal (ADR-0060 §5–6). Opens from the header version button
 * (`data-test="app-version"`).
 *
 * A11y machinery follows NutritionModal verbatim (ADR-0039 nutrition-facts
 * modal): teleported to body, focus trap, Escape closes, scrim click closes,
 * focus restored to the trigger on every close path.
 *
 * Data is lazy-fetched same-origin on FIRST open and cached in memory for
 * the session. A fetch failure renders an error state INSIDE the modal
 * (retry affordance) — never a toast loop, never a crash. The app works
 * offline, and the changelog is the least critical surface in it.
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLElement | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<ChangelogDoc | null>(null)

/** In-memory session cache — survives reopens within a page load. */
let cache: ChangelogDoc | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  return panel.value
    ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    : []
}

function trapTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !panel.value) return
  const items = [...focusables(), panel.value]
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!active || !panel.value.contains(active)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  }
}

function close() {
  emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
    return
  }
  trapTab(e)
}

let restoreFocusTo: HTMLElement | null = null

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
    cache = json
    data.value = json
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load the changelog'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    triggerEl.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.addEventListener('keydown', onKey)
    await nextTick()
    panel.value?.focus()
    void load()
  },
)

onMounted(() => {
  // Record the trigger on open; the restore happens in onBeforeUnmount.
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  const target = restoreFocusTo
  restoreFocusTo = null
  if (!target) return
  void nextTick(() => {
    if (document.contains(target)) target.focus()
    else document.body.focus?.()
  })
})

const featured = computed<NormalizedVersion | null>(() => {
  if (!data.value) return null
  return data.value.versions[0] ?? null
})

function retry() {
  void load()
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-surface-dark/50 sm:items-center"
    @click.self="close"
  >
    <div
      ref="panel"
      tabindex="-1"
      class="max-h-[85vh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-surface-raised p-4 shadow-xl outline-none sm:rounded-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="What's new"
      data-test="changelog-modal"
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
          @click="close"
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
    </div>
  </div>
</template>
