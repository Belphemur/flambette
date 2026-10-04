<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { STORE_SECTIONS } from '../lib/sections'
import FilterDropdown from './FilterDropdown.vue'
import type { FilterDropdownOption } from './FilterDropdown.vue'
import { nameKey } from '../lib/grocery'
import {
  suggestIngredients,
  type IngredientSuggestion,
} from '../lib/ingredientSuggestions'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { useAddGroceryItem } from '../lib/useAddGroceryItem'

/**
 * Grocery add-item input with ingredient autocomplete (ADR-0012/0014):
 *
 * - typing >= 2 chars opens a listbox whose FIRST row is always the
 *  typed text itself with a "+" affix — picking it (or Enter with
 *  nothing highlighted) adds the item IMMEDIATELY, then clears the
 *  input while it keeps focus (row mousedown is prevented), so a run
 *  of adds is ~1 tap per item ("banana" → +; "milk 2%" → +; …). The
 *  flow never closes itself mid-run (ADR-0014); Escape collapses the
 *  dropdown, a second Escape empties the input.
 * - every row carries its store category — index match from the baked
 *  ingredient index, remembered category for a "mine" row, and "Other"
 *  for unknown typed text — visible BEFORE anything is committed.
 * - keyboard nav: ArrowDown/ArrowUp move the highlight (row 0 = the
 *  typed "+" row); Enter adds the highlighted row, or the raw typed
 *  text when nothing is highlighted.
 * - the category select stays an explicit override for the NEXT add; it
 *  wins over the row's own category and resets after every add.
 */

defineProps<{
  /** Row layout (single input + suggestions) vs legacy wide form. */
  compact?: boolean
}>()

const emit = defineEmits<{
  /** Fired after a row was added (e.g. for counter updates). */
  added: [payload: { name: string; category: string }]
}>()

const customIngredients = useCustomIngredientsStore()
const addGroceryItem = useAddGroceryItem()

const query = ref('')
const suggestions = ref<IngredientSuggestion[]>([])
const open = ref(false)
/** -1 = none highlighted: Enter adds the raw typed text. */
const activeIndex = ref(-1)
/** Explicit category override for the NEXT add (empty = use row's own). */
const category = ref<string>('')
/** The category popup is open: the ingredient suggestions stand down
 *  (they are drawn over the control and would swallow its clicks). */
const categoryMenuOpen = ref(false)
const wrapper = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listboxId = `ingredient-listbox-${Math.random().toString(36).slice(2, 8)}`

const showCategory = computed(() => query.value.trim().length > 0)
const canSubmit = computed(() => query.value.trim().length > 0)

/**
 * Category options for the shared dropdown (ADR-0050 §8). The empty-value
 * "Pick a store category" placeholder is the FIRST entry so "no override
 * yet" stays expressible and the trigger reads as unset by default; the
 * rest comes from the canonical `STORE_SECTIONS` constant (no second copy
 * of the taxonomy).
 */
const CATEGORY_PLACEHOLDER = 'Pick a store category'
const categoryOptions = computed<FilterDropdownOption[]>(() => [
  { value: '', label: CATEGORY_PLACEHOLDER },
  ...STORE_SECTIONS.map((s) => ({ value: s, label: s })),
])
const categorySelectedIndex = computed(() =>
  Math.max(0, categoryOptions.value.findIndex((o) => o.value === category.value)),
)

/** The persistent "add this exact text" row — always row 0 (ADR-0014). */
const typedRow = computed<IngredientSuggestion | null>(() => {
  const trimmed = query.value.trim()
  if (trimmed.length < 2) return null
  return {
  name: trimmed,
  nameKey: `typed:${nameKey(trimmed)}`,
  // Unknown names keep the bucketless "Other" live feedback; an exact
  // index/custom match corrects it below via rowAt().
  category: 'Other',
  mine: false,
  }
})

/**
 * Index/custom entry exactly matching the typed text (nameKey level).
 * The + row adopts its category/unit/mine flags so the live feedback
 * reflects the known ingredient, not the bare "Other" bucket.
 */
function matchFor(trimmed: string): IngredientSuggestion | null {
  const key = nameKey(trimmed)
  return (
  suggestions.value.find((s) => s.nameKey === key) ??
  (customIngredients.find(trimmed)
  ? { ...customIngredients.find(trimmed)!, mine: true }
  : null)
  )
}

/** The effective row rendered at list position `i`. */
function rowAt(i: number): IngredientSuggestion | undefined {
  const row = rows.value[i]
  if (!row || row !== typedRow.value) return row
  const match = matchFor(query.value.trim())
  return match ? { ...match, name: row.name, nameKey: row.nameKey } : row
}

/** Rows in the listbox: the typed + row FIRST, then the ranked matches
 *  (an exact match of the typed text is folded into the + row). */
const rows = computed<IngredientSuggestion[]>(() => {
  const typed = typedRow.value
  if (!typed) return suggestions.value
  const key = nameKey(typed.name)
  return [typed, ...suggestions.value.filter((s) => s.nameKey !== key)]
})

let suggestToken = 0
async function refreshSuggestions() {
  const token = ++suggestToken
  const trimmed = query.value.trim()
  if (trimmed.length < 2) {
  suggestions.value = []
  open.value = false
  activeIndex.value = -1
  return
  }
  const result = await suggestIngredients(trimmed, customIngredients.list)
  if (token !== suggestToken) return // a newer keystroke already won
  suggestions.value = result
  activeIndex.value = -1
  // The typed + row keeps the listbox open past 2 chars even with zero
  // catalog matches (unknown names stay addable + labeled).
  open.value = true
}

/** Real user typing only — programmatic value sets never fire input. */
function onInput(event: Event) {
  // A new keystroke invalidates any pending category override.
  category.value = ''
  query.value = (event.target as HTMLInputElement).value
  void refreshSuggestions()
}

/**
 * Add a row NOW (ADR-0014 immediate-add loop): the shared action persists
 * the item, remembers it and toasts "Added to <Category>" (duplicates are
 * silent), then the input clears and the flow stays open.
 */
function addRow(s: IngredientSuggestion) {
  const chosen = category.value || s.category
  const ok = addGroceryItem(s.name, chosen)
  if (ok) emit('added', { name: s.name, category: chosen })
  query.value = ''
  category.value = ''
  suggestions.value = []
  open.value = false
  activeIndex.value = -1
  // The input keeps focus after programmatic value changes so the
  // bulk-add loop never loses the keyboard (ADR-0014).
  inputEl.value?.focus()
}

function optionId(index: number): string {
  return `${listboxId}-opt-${index}`
}

function onKeydown(event: KeyboardEvent) {
  if (open.value && rows.value.length > 0) {
  if (event.key === 'ArrowDown') {
  event.preventDefault()
  activeIndex.value = (activeIndex.value + 1) % rows.value.length
  return
  }
  if (event.key === 'ArrowUp') {
  event.preventDefault()
  activeIndex.value =
  activeIndex.value <= 0 ? rows.value.length - 1 : activeIndex.value - 1
  return
  }
  if (event.key === 'Enter' && activeIndex.value >= 0) {
  const row = rowAt(activeIndex.value)
  if (row) {
  event.preventDefault()
  addRow(row)
  return
  }
  }
  }
  if (event.key === 'Enter') {
  if (canSubmit.value) {
  // Nothing highlighted: Enter adds the raw typed text (+ row).
  event.preventDefault()
  addRow(typedRow.value!)
  }
  return
  }
  if (event.key === 'Escape') {
  event.preventDefault()
  if (open.value) {
  // First Escape: collapse the dropdown, keep the typed text.
  open.value = false
  activeIndex.value = -1
  } else {
  // The flow is an always-present form: "closing" = emptying it.
  query.value = ''
  category.value = ''
  }
  }
}

/** Explicit Add button: same immediate-add as the + row / Enter. */
function onSubmit() {
  if (canSubmit.value) addRow(typedRow.value!)
}

function onBlurOut(event: FocusEvent) {
  if (!wrapper.value?.contains(event.relatedTarget as Node)) {
  open.value = false
  activeIndex.value = -1
  }
}

/** Hand the keyboard back to the input after a surface swap. */
defineExpose({
  focus: () => inputEl.value?.focus(),
})

function onGlobalPointer(event: Event) {
  if (!wrapper.value?.contains(event.target as Node)) {
  open.value = false
  activeIndex.value = -1
  }
}

onMounted(() => document.addEventListener('pointerdown', onGlobalPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onGlobalPointer))

const ariaLabel = 'Add a custom grocery item'
</script>

<template>
  <div ref="wrapper" class="relative" data-test="add-bar" @focusout="onBlurOut">
  <form
  class="flex gap-2"
  :class="compact ? 'mx-auto max-w-sm' : ''"
  data-test="add-item-form"
  @submit.prevent="onSubmit"
  >
  <input
  ref="inputEl"
  :value="query"
  type="text"
  maxlength="80"
  placeholder="Add an item not in the recipes…"
  :aria-label="ariaLabel"
  role="combobox"
  :aria-expanded="open && rows.length > 0"
  aria-autocomplete="list"
  :aria-controls="open && rows.length > 0 ? listboxId : undefined"
  :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
  class="h-11 w-full rounded-xl border px-4 text-sm outline-none focus:border-brand-text"
  data-test="add-bar-input"
  @input="onInput"
  @keydown="onKeydown"
  />
  <button
  type="submit"
  class="h-11 shrink-0 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand active:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
  :disabled="!canSubmit"
  data-test="ingredient-submit"
  >
  Add
  </button>
  </form>

  <!-- Category chooser: explicit override for the NEXT add; resets on
  every add so the row categories stay authoritative afterwards. It is
  the SHARED FilterDropdown (ADR-0045), consumed here for the first time
  outside a filter bar: `fullWidth: false` because this is a stacked
  full-width row under the input, not a grid cell (ADR-0046 2.2
  precedent). The component clamps/flips its popup, which is what makes
  it usable at the bottom of a phone viewport. -->
  <div v-if="showCategory" class="mt-2">
  <FilterDropdown
  :options="categoryOptions"
  :selected-index="categorySelectedIndex"
  label="Store category for this item"
  trigger-test="ingredient-category"
  menu-test="ingredient-category-menu"
  :option-test="(o) => `ingredient-category-option-${o.value || 'none'}`"
  :full-width="false"
  :active="category !== ''"
  menu-width="w-full"
  @select="(v) => (category = v)"
  @open="categoryMenuOpen = $event"
  />
  </div>

  <ul
  v-if="open && !categoryMenuOpen && rows.length > 0"
  :id="listboxId"
  role="listbox"
  aria-label="Ingredient suggestions"
  class="absolute z-30 left-0 right-0 mt-1 overflow-hidden rounded-xl bg-surface-raised shadow-lg ring-1 ring-border"
  data-test="ingredient-suggestions"
  >
  <li
  v-for="(row, i) in rows"
  :id="optionId(i)"
  :key="row.nameKey"
  role="option"
  :aria-selected="i === activeIndex"
  :aria-label="`Add '${rowAt(i)!.name}' — ${rowAt(i)!.category}`"
  class="flex hovercap:cursor-pointer items-center gap-2 px-4 py-2 text-sm"
  :class="i === activeIndex ? 'bg-brand/10' : ''"
  :data-test="i === 0 ? 'add-suggestion-first' : 'add-suggestion-row'"
  @mousedown.prevent
  @click="addRow(rowAt(i)!)"
  >
  <span
  class="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand-text"
  aria-hidden="true"
  ><Plus :size="14" /></span
  >
  <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
  <span
  v-if="rowAt(i)!.mine"
  class="shrink-0 rounded-full bg-brand/15 px-1.5 py-px text-[10px] font-semibold text-brand-text"
  data-test="mine-badge"
  aria-label="Remembered from your own adds"
  >mine</span
  >
  <span v-if="rowAt(i)!.unit" class="shrink-0 text-xs text-text-muted">{{ rowAt(i)!.unit }}</span>
  <!-- Live category feedback (ADR-0014): visible on every row and
  folded into the row's accessible name (not decorative). -->
  <span
  class="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-text-muted"
  data-test="suggestion-category"
  >{{ rowAt(i)!.category }}</span
  >
  </li>
  </ul>
  </div>
</template>
