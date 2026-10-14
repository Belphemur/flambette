<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Plus } from '@lucide/vue'
import { aisleIcon } from '../lib/aisleRole'
import {
  isSuggestionListVisible,
  suggestIngredients,
  type IngredientSuggestion,
} from '../lib/ingredientSuggestions'
import { useCustomIngredientsStore } from '../stores/customIngredients'
import { usePantryStore } from '../stores/pantry'

/**
 * The pantry add input (ADR-0087 Decision 8): a THIN prop-free variant
 * of the grocery add-bar's autocomplete. The suggestion logic is NOT
 * duplicated — rows come from `ingredientSuggestions.ts` (the one
 * suggestion source of truth, index + "mine" custom names + fuzzy tier),
 * real categories from `ingredients.json` (Decision 9), and the listbox
 * existence rule is the shared `isSuggestionListVisible`. What this
 * component mirrors is the KEYBOARD MODEL (ArrowDown/ArrowUp navigate,
 * Enter adds the highlighted row or the raw typed text, Escape
 * collapses then empties) — the grocery component itself cannot be
 * reused directly because its add action is the grocery funnel
 * (`useAddGroceryItem`), while a pantry add must go to the pantry store.
 */

const emit = defineEmits<{
  /** Fired after a pantry ingredient was added (name as typed). */
  added: [name: string]
}>()

const pantry = usePantryStore()
const customIngredients = useCustomIngredientsStore()

const query = ref('')
const suggestions = ref<IngredientSuggestion[]>([])
const open = ref(false)
/** -1 = none highlighted: Enter adds the raw typed text. */
const activeIndex = ref(-1)
const wrapper = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listboxId = `pantry-listbox-${Math.random().toString(36).slice(2, 8)}`

const ariaLabel = 'Add an ingredient you have'
const canSubmit = computed(() => query.value.trim().length > 0)

/** Suggestion rows, minus ingredients already in the pantry. */
const rows = computed<IngredientSuggestion[]>(() => {
  const typed = query.value.trim()
  const typedRow: IngredientSuggestion | null =
    typed.length >= 2
      ? {
          name: typed,
          nameKey: `typed:${typed.toLowerCase()}`,
          category: 'Other',
          mine: false,
        }
      : null
  const ranked = suggestions.value.filter((s) => !pantry.keys.has(s.nameKey))
  if (!typedRow) return ranked
  return [typedRow, ...ranked.filter((s) => s.nameKey !== `typed:${typed.toLowerCase()}`)]
})

const suggestionsVisible = computed(() =>
  isSuggestionListVisible({
    open: open.value,
    categoryMenuOpen: false,
    rowCount: rows.value.length,
  }),
)

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
  open.value = true
}

function onInput(event: Event) {
  query.value = (event.target as HTMLInputElement).value
  void refreshSuggestions()
}

/** Add NOW: the pantry store dedups by nameKey; the input clears and
 *  keeps focus so a run of adds is one tap per ingredient. */
function addRow(row: IngredientSuggestion) {
  if (pantry.add(row.name)) emit('added', row.name)
  query.value = ''
  suggestions.value = []
  open.value = false
  activeIndex.value = -1
  // The input keeps focus after programmatic value changes (ADR-0014
  // bulk-add loop, applied to the pantry row).
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
      const row = rows.value[activeIndex.value]
      if (row) {
        event.preventDefault()
        addRow(row)
        return
      }
    }
  }
  if (event.key === 'Enter') {
    if (canSubmit.value) {
      // Nothing highlighted: Enter adds the raw typed text.
      event.preventDefault()
      addRow({ name: query.value.trim(), nameKey: `typed:`, category: 'Other', mine: false })
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
      // The flow is an always-present affordance: closing = emptying it.
      query.value = ''
    }
  }
}

function onBlurOut(event: FocusEvent) {
  if (!wrapper.value?.contains(event.relatedTarget as Node)) {
    open.value = false
    activeIndex.value = -1
  }
}

function onGlobalPointer(event: Event) {
  if (!wrapper.value?.contains(event.target as Node)) {
    open.value = false
    activeIndex.value = -1
  }
}

onMounted(() => document.addEventListener('pointerdown', onGlobalPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onGlobalPointer))

/** Hand the keyboard back to the input after a chip removal (ADR-0087
 *  Decision 10). */
defineExpose({
  focus: () => inputEl.value?.focus(),
})
</script>

<template>
  <div ref="wrapper" class="relative" data-test="pantry-add" @focusout="onBlurOut">
    <input
      ref="inputEl"
      :value="query"
      type="text"
      maxlength="80"
      placeholder="Add an ingredient you have…"
      :aria-label="ariaLabel"
      role="combobox"
      :aria-expanded="suggestionsVisible"
      aria-autocomplete="list"
      :aria-controls="suggestionsVisible ? listboxId : undefined"
      :aria-activedescendant="suggestionsVisible && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      class="field h-11 w-full px-4"
      data-test="pantry-add-input"
      @input="onInput"
      @keydown="onKeydown"
    />

    <ul
      v-if="suggestionsVisible"
      :id="listboxId"
      role="listbox"
      aria-label="Ingredient suggestions"
      class="absolute z-30 left-0 right-0 mt-1 overflow-hidden rounded-xl bg-popover shadow-popover ring-1 ring-border"
      data-test="pantry-suggestions"
    >
      <li
        v-for="(row, i) in rows"
        :id="optionId(i)"
        :key="`${row.nameKey}-${i}`"
        role="option"
        :aria-selected="i === activeIndex"
        :aria-label="`Add '${row.name}'${row.category ? ` — ${row.category}` : ''}`"
        class="flex hovercap:cursor-pointer items-center gap-2 px-4 py-2 text-sm"
        :class="i === activeIndex ? 'bg-brand/10' : ''"
        :data-test="i === 0 ? 'pantry-suggestion-first' : 'pantry-suggestion-row'"
        @mousedown.prevent
        @click="addRow(row)"
      >
        <span
          class="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand-text"
          aria-hidden="true"
        ><Plus :size="14" /></span>
        <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
        <span
          v-if="row.mine"
          class="shrink-0 rounded-full bg-brand/15 px-1.5 py-px text-[10px] font-semibold text-brand-text"
          data-test="pantry-mine-badge"
          aria-label="Remembered from your own adds"
        >mine</span>
        <!-- Real categories only (ADR-0087 Decision 9): the index's own
        category field, shown on every row that has one. -->
        <span
          v-if="row.category && row.category !== 'Other'"
          class="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-text-muted"
          data-test="pantry-suggestion-category"
        >
          <component
            :is="aisleIcon(row.category)!.glyph"
            v-if="aisleIcon(row.category)"
            :size="12"
            :class="aisleIcon(row.category)!.className"
            aria-hidden="true"
          />
          {{ row.category }}
        </span>
      </li>
    </ul>
  </div>
</template>
