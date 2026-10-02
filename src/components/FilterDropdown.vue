<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
import { useListboxMenu } from '../composables/useListboxMenu'
import HueIcon from './HueIcon.vue'
import type { IconRole } from '../lib/palette'

/**
 * The ONE dropdown for the Recipes filter bar (ADR-0045). Until this
 * component the bar spoke three visual languages for one kind of control:
 * cook time was a native `<select>` (OS-drawn popup), while sort and meal
 * type were hand-written `role="listbox"` popups — the same ~70 lines of
 * focus bookkeeping duplicated, and the markup (where the look lives)
 * forked three ways.
 *
 * This component owns the whole affordance ONCE: the `h-11` trigger (icon
 * slot + selected label + chevron, `aria-haspopup`/`aria-expanded`) and
 * the popup shell (`ul role="listbox"` of `button role="option"` rows
 * with the `Check`-or-spacer alignment that stops labels shifting,
 * `aria-selected`, roving `tabindex`), wired on top of the EXISTING
 * `useListboxMenu` — the focus bookkeeping ADR-0043 extracted is not
 * re-implemented here, it is consumed a third time, which is what makes
 * that extraction a real shared component rather than a two-caller
 * helper.
 *
 * Options are DATA (`{ value, label, ariaLabel?, count?, icon?,
 * iconRole? }`), not markup, so the component derives the selected index,
 * the selected label on the closed trigger and the `Any` row without the
 * parent re-deriving any of it. Slots are used only where the three
 * controls genuinely differ — the trigger's leading icon (clock vs
 * `ArrowUpDown` vs the meal hue).
 *
 * The `data-test` contract is passed in VERBATIM (ADR-0045 §3):
 * `triggerTest` / `menuTest` / `optionTest` carry the exact selectors the
 * specs assert (`cook-time-filter`, `sort-button`, `sort-menu`,
 * `sort-option-<value>`, `mealtype-button`, `mealtype-menu`,
 * `mealtype-option-<label>`); a refactor that renames them would have to
 * edit every spec and buys nothing.
 *
 * Grid footprint (ADR-0027 WS1, unchanged): the root takes `w-full` in
 * the 2-column phone grid and `sm:w-auto` above it, exactly like the
 * meal-type trigger before it — no control is orphaned on its own line.
 */
export interface FilterDropdownOption {
  /** Stable identity and the value `@select` emits. */
  value: string
  /** The row's text; also the closed trigger's label for the selection. */
  label: string
  /** Accessible name of the option row; defaults to `label`. */
  ariaLabel?: string
  /** Trailing build-time count badge (the meal type's "N recipes"). */
  count?: number
  /** Bare leading glyph for this row (e.g. Sparkles for an "Any" row). */
  icon?: Component
  /** Categorical hue for this row (a meal occasion, ADR-0043); wins over `icon`. */
  iconRole?: IconRole | null
}

const props = withDefaults(
  defineProps<{
    options: FilterDropdownOption[]
    /** Index of the selected option in `options` (always valid here). */
    selectedIndex: number
    /** Accessible name for the trigger AND the popup. */
    label: string
    triggerTest: string
    menuTest: string
    /** Full `data-test` value for an option row, verbatim from the contract. */
    optionTest: (option: FilterDropdownOption) => string
    /** The selection is non-default: tint the trigger like the meal-type one. */
    active?: boolean
    /** Popup width utility (the shell's only per-control difference). */
    menuWidth?: string
    /** Stretch to the filter-bar grid cell (`w-full sm:w-auto`). The
     *  Auto-Plan sheet's `justify-between` rows pass `false` so the
     *  trigger stays compact beside its row label (ADR-0046 §2.2). */
    fullWidth?: boolean
  }>(),
  {
    active: false,
    menuWidth: 'w-48',
    fullWidth: true,
  },
)

const emit = defineEmits<{ select: [value: string] }>()

/** The currently selected row; drives the closed trigger's label. */
const selected = computed(() => props.options[props.selectedIndex] ?? null)

/**
 * The shared focus bookkeeping (arrows, Home/End, Escape + refocus, Tab,
 * click-away) — consumed, not copied. Options are static per control, so
 * the option count captured at setup is the count for the control's life.
 */
const menu = useListboxMenu(props.options.length, () => props.selectedIndex)

function choose(option: FilterDropdownOption) {
  emit('select', option.value)
  menu.closeMenu({ refocus: true })
}
</script>

<template>
  <!-- `w-full` in the phone grid cell, `sm:w-auto` in the wrapping flex
  row (WS1) — the same footprint the meal-type trigger already had.
  `fullWidth: false` (Auto-Plan sheet rows) drops the width utilities
  only; the Recipes call sites render byte-identically. -->
  <div :ref="menu.wrapEl" class="relative" :class="fullWidth ? 'w-full sm:w-auto' : ''">
    <button
    :ref="menu.triggerEl"
    type="button"
    class="flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors"
    :class="active ? 'border-brand-text bg-brand-tint text-brand-text' : ''"
    aria-haspopup="listbox"
    :aria-expanded="menu.open.value"
    :aria-label="label"
    :data-test="triggerTest"
    @click="menu.open.value ? menu.closeMenu({ refocus: true }) : menu.openMenu()"
    >
      <slot name="icon" />
      <span class="truncate">{{ selected?.label ?? label }}</span>
      <ChevronDown :size="16" class="shrink-0 opacity-60" aria-hidden="true" />
    </button>
    <ul
    v-if="menu.open.value"
    class="absolute right-0 z-30 mt-1 overflow-hidden rounded-xl bg-surface-raised py-1 shadow-lg ring-1"
    :class="menuWidth"
    role="listbox"
    :aria-label="label"
    :data-test="menuTest"
    @keydown="menu.onMenuKeydown"
    >
      <li v-for="(option, index) in options" :key="option.value" role="none">
        <button
        :ref="(el) => menu.setOptionEl(el as Element | null, index)"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        role="option"
        :tabindex="index === menu.focusIndex.value ? 0 : -1"
        :aria-selected="index === selectedIndex"
        :aria-label="option.ariaLabel ?? option.label"
        :data-test="optionTest(option)"
        @click="choose(option)"
        >
          <!-- The check-or-spacer keeps every label on the same column:
          the selected row's check occupies the spacer's exact width. -->
          <Check
          v-if="index === selectedIndex"
          :size="16"
          class="shrink-0 text-brand"
          aria-hidden="true"
          />
          <span v-else class="w-4 shrink-0" aria-hidden="true" />
          <HueIcon v-if="option.iconRole" :role="option.iconRole" :size="16" />
          <component
          :is="option.icon"
          v-else-if="option.icon"
          :size="16"
          aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          <span
          v-if="option.count !== undefined"
          class="shrink-0 text-xs tabular-nums text-text-muted"
          >
            {{ option.count }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>