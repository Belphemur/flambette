<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Refrigerator, Sparkles, X } from '@lucide/vue'
import { usePantryStore } from '../stores/pantry'
import FilterDropdown from './FilterDropdown.vue'
import PantryIngredientAdd from './PantryIngredientAdd.vue'

/**
 * The "Kitchen" filter dropdown (ADR-0089): the pantry as the FIRST item
 * of the Recipes-tab filter row, rendered through the ONE FilterDropdown
 * (ADR-0045) in its panel mode — the open/close/Escape/click-away
 * mechanics and the measure/clamp/flip popup shell are reused, never
 * forked.
 *
 * Trigger (inactive): plain outlined chip — kitchen glyph, "Kitchen",
 * chevron down. Trigger (active, ≥1 pantry ingredient): the repo's
 * selected-chip surface (brand tint + brand text) plus a count pill
 * (`bg-brand text-on-brand`, mono) — the render's `bg-primary
 * text-on-primary` badge, mapped through the repo token table.
 *
 * Panel: header row (glyph + "In My Kitchen" + "N items" badge + Clear
 * all) over a `border-border/70` divider; the existing removable
 * chips; the add input (PantryIngredientAdd, inline suggestions); the
 * footer line. Everything below the chip stays ADR-0087-governed — the
 * match surface, ranking, card badges and the results summary are
 * untouched.
 *
 * Render-hex → repo-token map (the render is VISUAL authority; DESIGN.md
 * tokens win — never copy a hex that duplicates a token):
 *   `bg-primary`            → `bg-brand`      (--color-brand)
 *   `text-on-primary`       → `text-on-brand` (--color-on-brand)
 *   `bg-secondary-container` + `text-primary` (active chip / N-items
 *   badge)                  → `bg-brand-tint` + `text-brand-text` (the
 *   repo's selected-chip pair)
 *   `bg-paper-surface` (popup)        → `bg-popover`
 *   `border-border-warm` (+ /70)      → `border-border` (+ /70)
 *   `bg-surface-container-lowest` (wells, suggestion rows) → `bg-surface-sunken`
 *   `text-espresso-deep`    → `text-text`
 *   `text-espresso-muted`   → `text-text-muted`
 *   Material `kitchen`/`check_circle`/`close`/`expand_less` → lucide
 *   `Refrigerator`/`CircleCheck`/`X`/`ChevronDown` (icon role registry).
 *   Material `auto_awesome` (footer) → lucide `Sparkles`, muted per the
 *   ADR's "(mono, muted, decorative glyph)" — the render's green accent
 *   is not re-adopted.
 */
const pantry = usePantryStore()

const addInput = ref<InstanceType<typeof PantryIngredientAdd> | null>(null)

/** ONE count source (ADR-0089 Decision 4): the chip badge and the
 *  panel's "N items" badge both render THIS value; nothing else in the
 *  tab derives a pantry size. */
const itemCount = computed(() => pantry.list.length)

/** The panel opens onto the input — the dropdown is an add-first flow
 *  (the render's focal element is the add field). */
function onOpen(open: boolean) {
  if (open) void nextTick(() => addInput.value?.focus())
}

/** Chip removal returns focus to the add input (ADR-0087 Decision 10,
 *  carried over unchanged). */
async function removeIngredient(nameKey: string) {
  pantry.remove(nameKey)
  await nextTick()
  addInput.value?.focus()
}

/** Clear-all lives with the row's own state, never in the global
 *  "Clear filters" funnel (that one owns query + quick filters). */
function clearAll() {
  pantry.clear()
  addInput.value?.focus()
}
</script>

<template>
  <!-- `pantry-row` stays the feature's wrapper hook (the e2e anchors
  visibility checks on it — it is now the trigger chip + panel, not a
  row); the trigger itself is `pantry-trigger`. -->
  <FilterDropdown
    data-test="pantry-row"
    :options="[]"
    :selected-index="0"
    label="In My Kitchen"
    trigger-aria-label="My kitchen — ingredients I have"
    trigger-test="pantry-trigger"
    menu-test="pantry-panel"
    :option-test="() => ''"
    menu-width="w-[calc(100vw-2rem)] max-w-[350px] sm:w-96"
    :menu-max-height="400"
    :active="pantry.active"
    @select="() => {}"
    @open="onOpen"
  >
    <template #icon>
      <Refrigerator :size="16" aria-hidden="true" />
    </template>

    <!-- The active count badge: primary fill, on-primary text, mono,
    2-digit-safe — one render of the ONE count source. -->
    <template #badge>
      <span
        v-if="pantry.active"
        data-test="pantry-trigger-badge"
        class="shrink-0 rounded-full bg-brand px-1.5 py-0.5 font-mono-data text-[11px] font-bold leading-none text-on-brand"
      >{{ itemCount }}</span>
    </template>

    <template #panel>
      <div class="flex flex-col gap-2">
        <!-- Header row + divider -->
        <div class="flex items-center justify-between border-b border-border/70 pb-2">
          <div class="flex items-center gap-1.5">
            <Refrigerator :size="16" class="text-brand" aria-hidden="true" />
            <span class="text-sm font-bold text-text">In My Kitchen</span>
            <!-- Same ONE count source, second render. -->
            <span
              class="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono-data text-[11px] font-semibold leading-none text-brand-text"
            >{{ itemCount }} item{{ itemCount === 1 ? '' : 's' }}</span>
          </div>
          <button
            type="button"
            data-test="pantry-clear"
            class="text-xs text-text-muted underline decoration-dotted transition-colors hover:text-brand-text"
            aria-label="Clear ingredients"
            @click="clearAll"
          >
            Clear all
          </button>
        </div>

        <!-- Removable chips, one per pantry ingredient (identity =
        nameKey); the existing chip anatomy carried over. -->
        <div v-if="pantry.active" class="flex flex-wrap gap-1.5">
          <button
            v-for="ingredient in pantry.list"
            :key="ingredient.nameKey"
            type="button"
            :data-test="`pantry-chip-${ingredient.nameKey}`"
            class="flex h-8 shrink-0 items-center gap-1 rounded-full border border-brand-text bg-brand-tint px-2.5 text-sm font-medium text-brand-text transition-colors"
            :aria-label="`Remove ${ingredient.name} from my kitchen`"
            @click="removeIngredient(ingredient.nameKey)"
          >
            <span class="max-w-40 truncate">{{ ingredient.name }}</span>
            <X :size="14" aria-hidden="true" />
          </button>
        </div>

        <!-- The ONE add affordance; suggestions render IN FLOW inside
        the panel (the render shows them as panel content, and an
        absolutely-positioned list inside a clamped/scrolling popup
        would clip) — same engine, same keyboard model. -->
        <PantryIngredientAdd ref="addInput" inline @added="() => {}" />

        <div class="flex items-center gap-1.5 pt-1 font-mono-data text-[11px] text-text-muted">
          <Sparkles :size="14" aria-hidden="true" />
          <span>Showing recipes that match what you already have</span>
        </div>
      </div>
    </template>
  </FilterDropdown>
</template>
