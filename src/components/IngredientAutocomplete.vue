<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { STORE_SECTIONS } from '../lib/sections'
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
 *   typed text itself with a "+" affix — picking it (or Enter with
 *   nothing highlighted) adds the item IMMEDIATELY, then clears the
 *   input while it keeps focus (row mousedown is prevented), so a run
 *   of adds is ~1 tap per item ("banana" → +; "milk 2%" → +; …). The
 *   flow never closes itself mid-run (ADR-0014); Escape collapses the
 *   dropdown, a second Escape empties the input.
 * - every row carries its store category — index match from the baked
 *   ingredient index, remembered category for a "mine" row, and "Other"
 *   for unknown typed text — visible BEFORE anything is committed.
 * - keyboard nav: ArrowDown/ArrowUp move the highlight (row 0 = the
 *   typed "+" row); Enter adds the highlighted row, or the raw typed
 *   text when nothing is highlighted.
 * - the category select stays an explicit override for the NEXT add; it
 *   wins over the row's own category and resets after every add.
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
const wrapper = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listboxId = `ingredient-listbox-${Math.random().toString(36).slice(2, 8)}`

const showCategory = computed(() => query.value.trim().length > 0)
const canSubmit = computed(() => query.value.trim().length > 0)

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
        class="h-11 w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 px-4 text-sm outline-none focus:border-primary"
        data-test="add-bar-input"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        type="submit"
        class="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-semibold text-white active:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canSubmit"
        data-test="ingredient-submit"
      >
        Add
      </button>
    </form>

    <!-- Category chooser: explicit override for the NEXT add; resets on
         every add so the row categories stay authoritative afterwards. -->
    <select
      v-if="showCategory"
      v-model="category"
      aria-label="Store category for this item"
      data-test="ingredient-category"
      class="mt-2 h-9 w-full rounded-lg border dark:border-stone-700 dark:bg-stone-900 px-2 text-xs text-stone-500 dark:text-stone-400"
    >
      <option value="" disabled>Pick a store category</option>
      <option v-for="s in STORE_SECTIONS" :key="s" :value="s">{{ s }}</option>
    </select>

    <ul
      v-if="open && rows.length > 0"
      :id="listboxId"
      role="listbox"
      aria-label="Ingredient suggestions"
      class="absolute z-30 left-0 right-0 mt-1 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700"
      data-test="ingredient-suggestions"
    >
      <li
        v-for="(row, i) in rows"
        :id="optionId(i)"
        :key="row.nameKey"
        role="option"
        :aria-selected="i === activeIndex"
        :aria-label="`Add '${rowAt(i)!.name}' — ${rowAt(i)!.category}`"
        class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm"
        :class="i === activeIndex ? 'bg-primary/10 dark:bg-primary/20' : ''"
        :data-test="i === 0 ? 'add-suggestion-first' : 'add-suggestion-row'"
        @mousedown.prevent
        @click="addRow(rowAt(i)!)"
      >
        <span
          class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary-dark dark:bg-primary/20 dark:text-primary"
          aria-hidden="true"
          >＋</span
        >
        <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
        <span
          v-if="rowAt(i)!.mine"
          class="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold text-primary-dark dark:bg-primary/20 dark:text-primary"
          data-test="mine-badge"
          aria-label="Remembered from your own adds"
          >mine</span
        >
        <span v-if="rowAt(i)!.unit" class="shrink-0 text-xs text-stone-400">{{ rowAt(i)!.unit }}</span>
        <!-- Live category feedback (ADR-0014): visible on every row and
             folded into the row's accessible name (not decorative). -->
        <span
          class="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-400"
          data-test="suggestion-category"
          >{{ rowAt(i)!.category }}</span
        >
      </li>
    </ul>
  </div>
</template>
