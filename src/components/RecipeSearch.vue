<script setup lang="ts">
import { onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { ChevronDown, X } from 'lucide-vue-next'
import { searchVariantIds, suggest } from '../lib/search'

/** The search control, extracted from RecipesTab (ADR-0064): the input,
 *  the clear button, the suggest dropdown, the tips disclosure and both
 *  debounce pipelines. It is the search CONTROL — facets, sort and the
 *  results grid stay in RecipesTab, which reads `searchResults` /
 *  `searchPending` back off this component's exposed refs.
 *
 *  The query's single source of truth is RecipesTab's own ref, handed
 *  down with v-model: the model writes through, the query is never
 *  copied into a second ref here (DRY — one query, two watchers). */

const query = defineModel<string>({ required: true })

/** The search input itself: Enter blurs it so the mobile on-screen
 *  keyboard closes and the results become visible (ADR-0064 §4). */
const input = useTemplateRef<HTMLInputElement>('input')

/* ---------- Async search results pipeline ---------- */

/** Async search results: null means no active search (show all). */
const searchResults = ref<{ primary: number[]; fallback: number[] } | null>(null)
/** True while a debounced search is in flight — hides the empty state so
 *  a new query never flashes "No recipes match" before results land. */
const searchPending = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** Run the search for `current` now. The stale-response guard (a
 *  response for a query the user has since changed is discarded) lives
 *  here so BOTH callers — the 200 ms debounce and Enter's flush — share
 *  it verbatim. */
async function runSearch(current: string) {
  // Guard the async boundary: an earlier request (including the cold
  // index fetch) finishing after the query changed must never
  // overwrite the newer state.
  const r = await searchVariantIds(current).catch((e) => { void e; return null })
  if (query.value.trim() !== current) return
  searchResults.value = r
  searchPending.value = false
}

watch(query, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    searchResults.value = null
    searchPending.value = false
    return
  }
  searchPending.value = true
  searchTimer = setTimeout(() => void runSearch(trimmed), 200)
})

/** Enter flushes the 200 ms search debounce (ADR-0064 §4): the results
 *  are on screen when the keyboard finishes closing, not 200 ms later. */
function flushSearch() {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  const trimmed = query.value.trim()
  if (!trimmed) {
    searchResults.value = null
    searchPending.value = false
    return
  }
  searchPending.value = true
  void runSearch(trimmed)
}

/* ---------- AutoSuggest dropdown state ---------- */

/** Set after committing a suggestion so the suggest watcher skips its
 *  next fetch — otherwise the dropdown pops back up over the results. */
let suppressNextSuggest = false
const suggestions = ref<string[]>([])
const suggestSelected = ref(-1)
let suggestTimer: ReturnType<typeof setTimeout> | null = null
watch(query, (q) => {
  if (suggestTimer) clearTimeout(suggestTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    suggestions.value = []
    suggestSelected.value = -1
    return
  }
  // The user just committed a suggestion: the query is already the full
  // text they chose, so offering completions of it again only pops the
  // dropdown back up over the results.
  if (suppressNextSuggest) {
    suppressNextSuggest = false
    suggestions.value = []
    suggestSelected.value = -1
    return
  }
  suggestTimer = setTimeout(async () => {
    const current = trimmed
    const results = await suggest(current)
    if (query.value.trim() !== current) return // stale response
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
  if (suggestions.value.length > 0 && suggestSelected.value >= 0) {
  const picked = suggestions.value[suggestSelected.value]!
  // Same no-op guard as selectSuggestion: a flag set on an unchanged
  // query would kill the next real edit's suggestions.
  if (query.value !== picked) {
    suppressNextSuggest = true
    query.value = picked
  }
  }
  suggestions.value = []
  suggestSelected.value = -1
  flushSearch()
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
  suggestions.value = []
  suggestSelected.value = -1
  break
  }
}

function selectSuggestion(s: string) {
  // Only suppress when the assignment actually CHANGES the query: picking
  // a suggestion equal to the current text never fires the watcher, and a
  // stale flag would silently swallow the user's NEXT real edit.
  if (query.value !== s) {
    suppressNextSuggest = true
    query.value = s
  }
  suggestions.value = []
  suggestSelected.value = -1
}

/* ---------- Search-tips disclosure ---------- */

/** Search-tips disclosure: closed by default, user-toggled. The toggle
 *  state is device-local (never a household preference — ADR-0027). The
 *  panel starts closed so first paint shows results, not help, on mobile. */
const showTips = ref(false)

/* RecipesTab reads the results pipeline off this component (ADR-0064 §3):
 * exposed refs are unwrapped reactively by the expose proxy, so the
 * parent's computeds track them as ordinary state. */
defineExpose({ searchResults, searchPending })

onUnmounted(() => {
  // A KeepAlive'd parent does not unmount on tab switches, so these only
  // fire on final teardown — but a pending timer outliving its component
  // would write into dead refs. Clear both.
  if (searchTimer) clearTimeout(searchTimer)
  if (suggestTimer) clearTimeout(suggestTimer)
})
</script>

<template>
  <!-- space-y-3 keeps the section's original rhythm: these three blocks
  sat between the section's direct children, so the wrapper reproduces
  the same gaps internally (the section's own space-y-3 continues below). -->
  <div class="space-y-3">
  <div class="relative">
  <input
  ref="input"
  v-model="query"
  type="search"
  enterkeyhint="search"
  placeholder="Search recipes or ingredients…"
  class="h-11 w-full rounded-xl border px-4 pr-10 text-sm outline-none focus:border-brand-text"
  aria-label="Search recipes or ingredients"
  :aria-expanded="suggestions.length > 0"
  :aria-controls="'search-suggest'"
  :aria-activedescendant="suggestSelected >= 0 ? 'search-suggest-item-' + suggestSelected : undefined"
  @keydown="onSuggestKey"
  />
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
  <div
  v-if="suggestions.length > 0"
  id="search-suggest"
  data-test="search-suggest"
  role="listbox"
  class="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border bg-surface-raised shadow-lg"
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

  <div class="flex w-full justify-end">
  <button
    data-test="search-tips-toggle"
    :aria-expanded="showTips"
    aria-controls="search-tips-panel"
    class="flex items-center gap-1 py-2 text-xs text-text-muted transition-transform"
    :class="showTips ? 'rotate-180' : ''"
    @click="showTips = !showTips"
  >
    Search tips
    <ChevronDown :size="14" aria-hidden="true" class="transition-transform" />
  </button>
  </div>

  <div
    v-if="showTips"
    id="search-tips-panel"
    data-test="search-tips-panel"
    class="rounded-xl border bg-surface-raised px-4 py-3 text-xs text-text-muted space-y-1"
  >
    <div><code>word word</code> — all words (AND)</div>
    <div><code>rice OR quinoa</code> — either word</div>
    <div><code>"tomato soup"</code> — exact phrase</div>
    <div><code>-word</code> — exclude</div>
    <div><code>word*</code> — starts with</div>
    <div><code>soup (rice OR quinoa) -cream</code> — combine them</div>
  </div>
  </div>
</template>
