<script setup lang="ts">
import {
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CircleHelp, X } from 'lucide-vue-next'
import { suggest } from '../lib/search'
import { useRecipeSearch } from '../composables/useRecipeSearch'
import { useSearchTips } from '../composables/useSearchTips'

/**
 * THE search field (ADR-0070, migrated from RecipeSearch per ADR-0064):
 * one component, TWO mount points — the header well on desktop (≥lg, on
 * EVERY tab since Addendum 2) and the top of the Recipes content below it.
 * The query and the async results pipeline are module-scope state owned by
 * `useRecipeSearch` (never persisted, never room-synced); this component
 * is the CONTROL: the input, the clear button, the suggest dropdown and
 * the `?` tips affordance. Facets, sort and the results grid stay in
 * RecipesTab, which reads `searchResults`/`searchPending` off the same
 * composable.
 *
 * `variant="header"` renders the bare well plus the `?` affordance (the
 * tips PANEL and the wrapper rhythm belong to the panel mount);
 * `variant="panel"` renders the field itself, as the in-content mount
 * always has. The `/` affordance is desktop-only and mounted-field-only:
 * the global keydown listener lives on the instance, so exactly one input
 * answers it wherever the field currently is.
 */
const props = withDefaults(defineProps<{ variant?: 'header' | 'panel' }>(), {
  variant: 'panel',
})

const { query, flushSearch, armFlush } = useRecipeSearch()
const { toggleTips, showTips } = useSearchTips()
const router = useRouter()
const route = useRoute()

/** The search input itself: Enter blurs it so the mobile on-screen
 *  keyboard closes and the results become visible (ADR-0064 §4). */
const input = useTemplateRef<HTMLInputElement>('input')

/* ---------- AutoSuggest dropdown state ---------- */

/** Set after committing a suggestion so the suggest watcher skips its
 *  next fetch — otherwise the dropdown pops back up over the results. */
let suppressNextSuggest = false
/** Generation counter for suggest work. Every dismissal bumps it, so a
 *  pending timer or an in-flight `suggest()` response cannot write
 *  `suggestions` back and pop the dropdown up over the results after a
 *  dismissal: Enter/Escape dismiss WITHOUT changing the query, so the
 *  query-only stale guard cannot see it — the generation bump is the
 *  only witness. */
let suggestGen = 0
const suggestions = ref<string[]>([])
const suggestSelected = ref(-1)
let suggestTimer: ReturnType<typeof setTimeout> | null = null

/** Dispose the dropdown AND invalidate its pending/in-flight work. */
function dismissSuggestions() {
  if (suggestTimer) clearTimeout(suggestTimer)
  suggestTimer = null
  suggestGen++
  suggestions.value = []
  suggestSelected.value = -1
}

watch(query, (q) => {
  if (suggestTimer) clearTimeout(suggestTimer)
  suggestGen++
  const gen = suggestGen
  const trimmed = q.trim()
  // An empty query and a just-committed suggestion share one outcome:
  // the query is already the text the user wants, so offering
  // completions of it again only pops the dropdown up over the results.
  if (!trimmed || suppressNextSuggest) {
    suppressNextSuggest = false
    suggestions.value = []
    suggestSelected.value = -1
    return
  }
  suggestTimer = setTimeout(async () => {
    const current = trimmed
    const results = await suggest(current)
    // Stale response: the query moved on, OR the dropdown was dismissed
    // since the fetch started (Enter/Escape clear it without changing
    // the query — the generation bump is what invalidates those).
    if (gen !== suggestGen || query.value.trim() !== current) return
    // When the typed query IS a word the index knows (e.g. "rice"), the
    // suggester answers with the word itself plus fuzzy neighbours
    // ("rich", "ice"). Offering the word back is a no-op, and the
    // neighbours are noise — they read as "you must mean rich or ice".
    // So once an exact match exists the dropdown offers only LONGER
    // completions of the query and hides itself when none remain
    // (case-insensitive: the suggester's casing is its own).
    const key = current.toLowerCase()
    suggestions.value = results.some((s) => s.toLowerCase() === key)
      ? results.filter((s) => s.toLowerCase().startsWith(key) && s.toLowerCase() !== key)
      : results
    suggestSelected.value = -1
  }, 150)
})

function onSuggestKey(e: KeyboardEvent) {
  // Enter is handled BEFORE the dropdown-empty early-return (ADR-0064
  // §4): commit a highlighted suggestion exactly as before, then ALWAYS
  // dispose the menu and blur — on a phone the open dropdown covers the
  // results and the keyboard stays up otherwise. The open-with-nothing-
  // highlighted case that used to fall through was exactly the bug.
  if (e.key === 'Enter') {
  e.preventDefault()
  const picked =
  suggestions.value.length > 0 && suggestSelected.value >= 0
  ? suggestions.value[suggestSelected.value]!
  : null
  if (picked !== null && query.value !== picked) {
  // Same no-op guard as selectSuggestion: a flag set on an unchanged
  // query would kill the next real edit's suggestions.
  suppressNextSuggest = true
  // The composable write fires its watcher on the next flush, so the
  // flush is armed there (armFlush) instead of searching the pre-pick
  // text read here.
  armFlush()
  query.value = picked
  dismissSuggestions()
  } else {
  // Nothing highlighted, or the picked text is already the query.
  dismissSuggestions()
  flushSearch()
  }
  input.value?.blur()
  return
  }
  if (suggestions.value.length === 0) return
  switch (e.key) {
  case 'ArrowDown':
  e.preventDefault()
  suggestSelected.value = Math.min(suggestSelected.value + 1, suggestions.value.length - 1)
  break
  case 'ArrowUp':
  e.preventDefault()
  suggestSelected.value = Math.max(suggestSelected.value - 1, 0)
  break
  case 'Escape':
  dismissSuggestions()
  break
  }
}

/**
 * ADR-0070 Addendum 2: the well is PERSISTENT — it renders on every tab,
 * and the first keystroke made while the grid is not on screen ROUTES to
 * it. The grid is the only results surface, so a search typed on the
 * Plan tab has to land on Recipes; a query that merely SURVIVES a tab
 * switch (Decision 5) does not drag the reader back on its own.
 */
watch(query, (q) => {
  if (props.variant !== 'header') return
  if (route.name === 'recipes') return
  if (q.trim() === '') return
  void router.push({ name: 'recipes' })
})

/**
 * The `?` affordance beside the well opens the tips disclosure from ANY
 * tab, which means routing to the tab that mounts the panel — the
 * disclosure is content, so it only exists where its content does.
 */
function onTipsClick(): void {
  // The panel lives with the Recipes content, so pressing `?` elsewhere has
  // to route there — and it must OPEN the disclosure, never toggle it shut
  // for a reader who left the tab with tips already open.
  if (route.name !== 'recipes') {
    showTips.value = true
    void router.push({ name: 'recipes' })
    return
  }
  toggleTips()
}

function selectSuggestion(s: string) {
  dismissSuggestions()
  // Only suppress when the assignment actually CHANGES the query: picking
  // a suggestion equal to the current text never fires the watcher, and a
  // stale flag would silently swallow the user's NEXT real edit.
  if (query.value !== s) {
    suppressNextSuggest = true
    query.value = s
  }
}

/* ---------- `/` focuses the search (ADR-0070 Decision 4) ---------- */

/** `/` focuses THIS field — ignored while the user is already typing in
 *  another field (or using a modifier). The listener belongs to the
 *  mounted instance, so exactly one input answers it wherever the field
 *  currently renders, and it disappears with the mount. */
function onGlobalKey(e: KeyboardEvent) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (
    target &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT')
  )
    return
  e.preventDefault()
  input.value?.focus()
}

/**
 * `RecipesTab` is inside a `<KeepAlive>`, so leaving the tab DEACTIVATES
 * this component instead of unmounting it: a listener added at setup and
 * removed only at unmount would keep answering `/` on every other tab,
 * swallowing the keystroke and focusing an input that is not on screen. The
 * lifecycle pair is therefore activation-scoped, with unmount cleanup on top
 * (ADR-0070 §4's "exactly one input answers it" survives a cached parent).
 */
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onActivated(() => window.addEventListener('keydown', onGlobalKey))
onDeactivated(() => window.removeEventListener('keydown', onGlobalKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKey)
  // A KeepAlive'd parent does not unmount on tab switches, so these only
  // fire on final teardown — but a pending timer outliving its component
  // would write into dead refs. Clear it.
  if (suggestTimer) clearTimeout(suggestTimer)
})
</script>

<template>
  <!-- The panel variant keeps the section's original rhythm with
  space-y-3; the header variant renders the bare well (the tips block
  belongs to the content column, and the header row's own gap does the
  spacing). -->
  <div :class="variant === 'panel' ? 'space-y-3' : ''">
  <div class="relative">
  <input
  ref="input"
  v-model="query"
  type="search"
  enterkeyhint="search"
  placeholder="Search recipes or ingredients…"
  class="field w-full px-4 pr-20"
  aria-label="Search recipes or ingredients"
  :aria-expanded="suggestions.length > 0"
  :aria-controls="'search-suggest'"
  :aria-activedescendant="suggestSelected >= 0 ? 'search-suggest-item-' + suggestSelected : undefined"
  @keydown="onSuggestKey"
  />
  <!-- The desktop affordance: `/` focuses the search. kbd hint only in
  the header variant — the pointer-free affordance matters where the
  keyboard exists; on touch the field is simply there. -->
  <kbd
  v-if="variant === 'header' && !query"
  class="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono-data text-xs text-text-muted"
  aria-hidden="true"
  >/</kbd>
  <button
  v-if="query"
  type="button"
  data-test="search-clear"
  :aria-label="`Clear search (${query.length} characters)`"
  class="absolute inset-y-0 right-0 mx-2 flex h-11 w-6 items-center justify-center text-text-muted hover:text-text"
  @click.stop="() => (query = '')"
  @keydown.stop
  >
  <X :size="16" aria-hidden="true" />
  </button>
  <!-- ADR-0070 Addendum 1: the `?` affordance rides the well on EVERY
  tab. It opens the same content-level disclosure the Recipes tab's own
  toggle does, so it routes there when it is pressed elsewhere. -->
  <button
  v-if="variant === 'header'"
  type="button"
  data-test="search-tips-toggle"
  :aria-expanded="showTips"
  aria-controls="search-tips-panel"
  aria-label="Search tips"
  class="absolute inset-y-0 right-9 flex w-11 items-center justify-center text-text-muted hover:text-text"
  @click.stop="onTipsClick"
  >
  <CircleHelp :size="16" aria-hidden="true" />
  </button>
  <div
  v-if="suggestions.length > 0"
  id="search-suggest"
  data-test="search-suggest"
  role="listbox"
  class="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-border bg-popover shadow-popover"
  >
  <div
  v-for="(s, i) in suggestions"
  :key="s"
  :id="'search-suggest-item-' + i"
  :data-test="'search-suggest-item'"
  role="option"
  :aria-selected="i === suggestSelected"
  :aria-label="s"
  class="cursor-pointer px-4 py-2 text-sm"
  :class="i === suggestSelected ? 'bg-brand-tint text-brand-text' : ''"
  @click="selectSuggestion(s)"
  >
  {{ s }}
  </div>
  </div>
  </div>
  </div>
</template>
