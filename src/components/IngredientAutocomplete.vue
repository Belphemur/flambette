<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { STORE_SECTIONS } from '../lib/sections'
import {
  suggestIngredients,
  type IngredientSuggestion,
} from '../lib/ingredientSuggestions'
import { useCustomIngredientsStore } from '../stores/customIngredients'

/**
 * Grocery add-item input with ingredient autocomplete (ADR-0012):
 *
 * - typing >= 2 chars opens a listbox of suggestions from the baked
 *   ingredient index + device-local remembered names ("mine");
 * - picking a suggestion fills the name AND defaults the category
 *   dropdown (still overridable before submit);
 * - Enter always submits what is typed — unknown items stay addable
 *   (they are remembered for future suggestions);
 * - keyboard nav: ArrowDown/ArrowUp move the highlight, Enter picks the
 *   highlighted suggestion (or submits raw when none is highlighted),
 *   Escape closes the dropdown.
 */

const props = defineProps<{
  /** Row layout (inline category select) vs stacked (category under input). */
  compact?: boolean
}>()

const emit = defineEmits<{
  /** Submit: name as typed/picked, chosen category (may be overridden). */
  add: [payload: { name: string; category: string }]
}>()

const customIngredients = useCustomIngredientsStore()

const query = ref('')
const suggestions = ref<IngredientSuggestion[]>([])
const open = ref(false)
const activeIndex = ref(-1)
const category = ref<string>('')
const listboxId = `ingredient-listbox-${Math.random().toString(36).slice(2, 8)}`
const wrapper = ref<HTMLElement | null>(null)

/** Category select is hidden until there is an ingredient to categorize. */
const showCategory = computed(() => query.value.trim().length > 0)
const canSubmit = computed(() => query.value.trim().length > 0)

let suggestToken = 0
/** Programmatic query change (picking a suggestion) must not re-open the dropdown. */
let suppressNext = false
watch(
  () => query.value,
  async (q) => {
    const token = ++suggestToken
    if (suppressNext) {
      suppressNext = false
      return
    }
    const trimmed = q.trim()
    if (trimmed.length < 2) {
      suggestions.value = []
      open.value = false
      return
    }
    const result = await suggestIngredients(trimmed, customIngredients.list)
    if (token !== suggestToken) return // a newer keystroke already won
    suggestions.value = result
    activeIndex.value = -1
    open.value = result.length > 0
  },
)

function choose(s: IngredientSuggestion) {
  suppressNext = true
  query.value = s.name
  category.value = s.category
  open.value = false
  activeIndex.value = -1
}

function optionId(index: number): string {
  return `${listboxId}-opt-${index}`
}

/** Category for a submitted ingredient: explicit override > index match. */
function effectiveCategory(): string {
  if (category.value) return category.value
  const match = suggestions.value.find((s) => s.name === query.value.trim())
  return match?.category ?? 'Other'
}

function submit() {
  const name = query.value.trim()
  if (!name) return
  emit('add', { name, category: effectiveCategory() })
  query.value = ''
  category.value = ''
  suggestions.value = []
  open.value = false
  activeIndex.value = -1
}

function onKeydown(event: KeyboardEvent) {
  if (open.value && suggestions.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeIndex.value =
        activeIndex.value <= 0 ? suggestions.value.length - 1 : activeIndex.value - 1
      return
    }
    if (event.key === 'Enter' && activeIndex.value >= 0) {
      event.preventDefault()
      choose(suggestions.value[activeIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      open.value = false
      activeIndex.value = -1
      return
    }
  }
  if (event.key === 'Escape' && query.value) {
    query.value = ''
    category.value = ''
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    submit()
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

const ariaLabel = 'Add a custom grocery item'
</script>

<template>
  <div ref="wrapper" class="relative" @focusout="onBlurOut">
    <form
      class="flex gap-2"
      :class="compact ? 'mx-auto max-w-sm' : ''"
      data-test="add-item-form"
      @submit.prevent="submit"
    >
      <input
        v-model="query"
        type="text"
        maxlength="80"
        :placeholder="'Add an item not in the recipes…'"
        :aria-label="ariaLabel"
        role="combobox"
        :aria-expanded="open && suggestions.length > 0"
        aria-autocomplete="list"
        :aria-controls="open && suggestions.length > 0 ? listboxId : undefined"
        :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
        class="h-11 w-full rounded-xl border dark:border-stone-700 dark:bg-stone-900 px-4 text-sm outline-none focus:border-primary"
        data-test="ingredient-input"
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

    <!-- Category chooser: defaults from the picked suggestion, overrides
         remember with the row. Kept outside the truncating form row. -->
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
      v-if="open && suggestions.length > 0"
      :id="listboxId"
      role="listbox"
      aria-label="Ingredient suggestions"
      class="absolute z-30 left-0 right-0 mt-1 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700"
      data-test="ingredient-suggestions"
    >
      <li
        v-for="(s, i) in suggestions"
        :id="optionId(i)"
        :key="s.nameKey"
        role="option"
        :aria-selected="i === activeIndex"
        class="flex cursor-pointer items-center justify-between gap-2 px-4 py-2 text-sm"
        :class="i === activeIndex ? 'bg-primary/10 dark:bg-primary/20' : ''"
        data-test="ingredient-suggestion"
        @mousedown.prevent
        @click="choose(s)"
      >
        <span class="min-w-0 flex-1 truncate">{{ s.name }}</span>
        <span
          v-if="s.mine"
          class="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold text-primary-dark dark:bg-primary/20 dark:text-primary"
          data-test="mine-badge"
          aria-label="Remembered from your own adds"
          >mine</span
        >
        <span v-if="s.unit" class="shrink-0 text-xs text-stone-400">{{ s.unit }}</span>
      </li>
    </ul>
  </div>
</template>
