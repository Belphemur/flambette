<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { X } from '@lucide/vue'
import { usePantryStore } from '../stores/pantry'
import PantryIngredientAdd from './PantryIngredientAdd.vue'

/**
 * The "In my kitchen" chip row (ADR-0087 Decisions 1/2/10): a sibling of
 * the quick-filter chip rows in the Recipes-tab filter area. Selected
 * pantry ingredients render as removable chips; the add affordance with
 * autocomplete; a count label and a `Clear ingredients` action.
 *
 * With ZERO pantry ingredients the row collapses to just the add
 * affordance (Decision 1) — default browse stays byte-identical in
 * behaviour and visual weight to today's tab.
 */
const pantry = usePantryStore()

const addInput = ref<InstanceType<typeof PantryIngredientAdd> | null>(null)

/** Chip removal returns focus to the add input (Decision 10). */
async function removeIngredient(nameKey: string) {
  pantry.remove(nameKey)
  await nextTick()
  addInput.value?.focus()
}

function clearAll() {
  pantry.clear()
  addInput.value?.focus()
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2" data-test="pantry-row">
    <!-- Count label (Decision 2), hidden while the row is collapsed. -->
    <span
      v-if="pantry.active"
      class="text-sm font-medium text-text-muted"
      data-test="pantry-count"
    >
      In my kitchen ({{ pantry.list.length }})
    </span>

    <!-- Removable chips, one per pantry ingredient (identity = nameKey). -->
    <button
      v-for="ingredient in pantry.list"
      :key="ingredient.nameKey"
      type="button"
      :data-test="`pantry-chip-${ingredient.nameKey}`"
      class="flex h-11 shrink-0 items-center gap-1 rounded-full border border-brand-text bg-brand-tint px-3 text-sm font-medium text-brand-text transition-colors"
      :aria-label="`Remove ${ingredient.name} from my kitchen`"
      @click="removeIngredient(ingredient.nameKey)"
    >
      <span class="max-w-40 truncate">{{ ingredient.name }}</span>
      <X :size="14" aria-hidden="true" />
    </button>

    <!-- The ONE add affordance: present in both states so the row never
    grows a second editor for the same state (ADR-0087 Rejected elements). -->
    <PantryIngredientAdd ref="addInput" class="w-full sm:w-56" @added="() => {}" />

    <!-- Clear-all lives with the row's own state, never in the global
    "Clear filters" funnel (that one owns query + quick filters). -->
    <button
      v-if="pantry.active"
      type="button"
      data-test="pantry-clear"
      class="text-sm text-brand-text underline"
      aria-label="Clear ingredients"
      @click="clearAll"
    >
      Clear ingredients
    </button>
  </div>
</template>
