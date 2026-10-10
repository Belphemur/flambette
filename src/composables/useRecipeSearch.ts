import { ref, watch } from 'vue'
import { searchVariantIds } from '../lib/search'

/**
 * The recipe query is EPHEMERAL state, not a preference (ADR-0070): one
 * module-scope singleton ref read by BOTH search mounts — the header well
 * (desktop, Recipes tab) and the in-content field below it. It is never
 * persisted (a search is a question, not a household preference —
 * ADR-0027) and never room-synced (per-device intent, not household
 * state). Switching tabs keeps the query in memory; launching the app
 * starts with an empty query.
 *
 * The ASYNC SEARCH PIPELINE also lives here: with two mount points the
 * pipeline cannot belong to a component instance (each mount would own a
 * separate debounce and a separate results ref, and the two would race).
 * One module-scope pipeline, one `searchResults`/`searchPending` pair,
 * the same stale-response guard as before.
 */
const query = ref('')
const searchResults = ref<{ primary: number[]; fallback: number[] } | null>(null)
/** True while a debounced search is in flight — hides the empty state so
 *  a new query never flashes "No recipes match" before results land. */
const searchPending = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** Armed when Enter commits a highlighted suggestion whose text differs
 *  from the model: the write lands in the module ref synchronously, but
 *  the watcher fires on the NEXT tick — reading `query` inside the same
 *  handler would still see the PRE-pick text when callers pass the value
 *  around. Instead of searching that stale read, the query watcher runs
 *  the search IMMEDIATELY on the write's arrival (ADR-0064 §4). */
let flushOnQueryWrite = false

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

/** The one pipeline watcher: registered ONCE at module scope, so it
 *  survives tab switches (KeepAlive) and mount-point moves (the field
 *  moving between the header and the content column across the lg
 *  breakpoint) without losing the in-flight request. */
watch(query, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    searchResults.value = null
    searchPending.value = false
    return
  }
  searchPending.value = true
  if (flushOnQueryWrite) {
    flushOnQueryWrite = false
    void runSearch(trimmed)
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(trimmed)
  }, 200)
})

/** Enter flushes the 200 ms search debounce (ADR-0064 §4): the results
 *  are on screen when the keyboard finishes closing, not 200 ms later.
 *  Only a PENDING debounce is flushable — once the timer has fired, the
 *  search for the current query is already in flight or landed, and
 *  kicking it again would repeat the same work for the same query. */
function flushSearch() {
  if (!searchTimer) return
  clearTimeout(searchTimer)
  searchTimer = null
  searchPending.value = true
  void runSearch(query.value.trim())
}

export function useRecipeSearch() {
  return { query, searchResults, searchPending, flushSearch, armFlush: () => (flushOnQueryWrite = true) }
}
