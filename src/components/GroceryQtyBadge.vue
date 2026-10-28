<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Minus, Pencil, Plus } from '@lucide/vue'
import { useQtyOverridesStore } from '../stores/groceryQtyOverrides'
import { lineKeyIdentity } from '../lib/grocery'
import { normalizeQtyOverrideAmount, stepQtyOverrideAmount } from '../lib/qtyOverrideValue'

/**
 * The grocery quantity badge (ADR-0100).
 *
 * On the GROCERY TAB the badge is the EDIT affordance: an AT-reachable
 * button ("Change quantity of X") that reads as editable — dashed
 * underline (muted at rest, primary on hover/focus) beside a small
 * pencil glyph — pressed to open the INLINE editor anchored under it.
 * On SHOPVIEW the same badge renders the override value READ-ONLY
 * (shopping mode has no editing), so the read-only pass through this
 * one component keeps both surfaces' badge markup identical.
 *
 * The badge is a right-aligned flex sibling of the row label and stops
 * its own click (`@click.stop`): its hit area can never swallow the
 * label's tap-to-open area and the checkbox keeps its own edge.
 *
 * The inline editor is a popover ANCHORED under the badge: a stepper
 * pill (minus / value / plus) in the mono data voice at the 44px touch
 * height, a Reset link that drops the override back to the derived
 * amount, and Done to commit. The committed value normalizes ONCE
 * through `normalizeQtyOverrideAmount` — the store write and the
 * display share that one spelling (ADR-0037's clamp-once).
 */

const props = defineProps<{
  /** Display name of the ingredient the line renders (for the AT labels). */
  name: string
  /** The line's raw checked key — the identity is derived from it. */
  lineKey: string
  /** Current badge text, override applied (the render pipeline's `text`). */
  text: string
  /** The un-overridden rendering — the Reset anchor. */
  derivedText?: string
  /** The line's canonical unit token — a bare amount inherits it. */
  fallbackUnit?: string
  /** Editing exists on the Grocery tab only (ADR-0100). */
  editable?: boolean
  /** Muted (checked) styling for the badge text. */
  checked?: boolean
}>()

const overrides = useQtyOverridesStore()
const identity = computed(() => lineKeyIdentity(props.lineKey))
/** The line's canonical unit — a bare draft inherits it (ADR-0100). */
const fallbackUnit = computed(() => props.fallbackUnit ?? '')

/* ---------- ONE open editor across every row ---------- */

/**
 * Module-scope... no — a parent-gated model: GroceryTab owns ONE
 * `openQtyKey` ref and hands it down, so opening row A closes row B by
 * construction and no module state survives unmounts.
 */
const openKey = defineModel<string | null>('openKey', { default: null })

const isOpen = computed(() => props.editable && openKey.value === props.lineKey)

/* ---------- Draft ---------- */

/**
 * The local draft: opened seeded from the CURRENT badge text (the
 * override when one exists, else the derived rendering — the shopper
 * edits what they read), typed freely, stepped by ±, committed on Done.
 */
const draft = ref('')

const triggerRef = ref<HTMLElement | null>(null)
const editorStyle = ref<Record<string, string>>({})
let stopReposition: (() => void) | null = null

/**
 * The inline editor is Teleport-ed to <body> and position:fixed (template) so
 * it floats OVER the grocery rows instead of being clipped by their
 * overflow-hidden cards — the last-row editor was invisible before this fix
 * (ADR-0100).
 */
function positionEditor(): void {
  const el = triggerRef.value
  if (!el) {
    editorStyle.value = {}
    return
  }
  const r = el.getBoundingClientRect()
  editorStyle.value = {
    position: 'fixed',
    top: `${r.bottom + 8}px`,
    right: `${window.innerWidth - r.right}px`,
    zIndex: '50',
  }
}

watch(
  isOpen,
  async (open) => {
    if (open) {
      draft.value = props.text
      await nextTick(positionEditor)
      if (!stopReposition) {
        const onViewportChange = () => {
          if (isOpen.value) positionEditor()
        }
        window.addEventListener('scroll', onViewportChange, { passive: true })
        window.addEventListener('resize', onViewportChange)
        stopReposition = () => {
          window.removeEventListener('scroll', onViewportChange)
          window.removeEventListener('resize', onViewportChange)
        }
      }
    } else {
      stopReposition?.()
      stopReposition = null
      editorStyle.value = {}
    }
  },
  { immediate: true },
)

/** Reset: drop the override; the draft snaps back to the derived text. */
function resetToDerived(): void {
  overrides.clear(identity.value)
  draft.value = props.derivedText ?? ''
}

function step(direction: 1 | -1): void {
  draft.value = stepQtyOverrideAmount(draft.value, direction, fallbackUnit.value)
}

/** Done: COMMIT — one clamp (the normalize), then the store write. */
function commit(): void {
  const value = normalizeQtyOverrideAmount(draft.value, fallbackUnit.value)
  if (!value) overrides.clear(identity.value)
  else overrides.set(identity.value, value)
  closeEditor()
}

function closeEditor(): void {
  if (openKey.value === props.lineKey) openKey.value = null
}

function toggle(): void {
  openKey.value = isOpen.value ? null : props.lineKey
}
</script>

<template>
  <span class="relative inline-flex shrink-0" @click.stop>
    <!-- The edit affordance: an AT-reachable button that still shows the
         exact text the read-only badge shows. -->
    <button
      v-if="editable"
      ref="triggerRef"
      type="button"
      class="group/qty flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand"
      data-test="grocery-qty-edit"
      :aria-label="`Change quantity of ${name}`"
      :aria-expanded="isOpen"
      @click="toggle"
    >
      <span
        class="border-b border-dashed border-border-strong font-mono-data text-label-sm tabular-nums transition-colors group-focus-visible/qty:border-brand group-focus-visible/qty:text-brand-text group-hover/qty:border-brand group-hover/qty:text-brand-text"
        :class="checked ? 'text-text-muted' : 'text-text'"
        data-test="grocery-qty"
        >{{ text }}</span
      >
      <Pencil
        :size="11"
        aria-hidden="true"
        class="shrink-0 text-text-muted transition-colors group-hover/qty:text-brand-text group-focus-visible/qty:text-brand-text"
      />
    </button>
    <span
      v-else
      class="rounded-md bg-surface-sunken px-2 py-1 font-mono-data text-label-sm tabular-nums"
      :class="checked ? 'text-text-muted' : 'text-text'"
      data-test="grocery-qty"
      >{{ text }}</span
    >
    <!-- The inline editor, anchored under the badge. Teleport to <body> +
    position:fixed so an ancestor's overflow-hidden (the grocery row cards)
    cannot clip it on the last row — it floats over the whole page (ADR-0100). -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        :style="editorStyle"
        class="z-50 flex w-fit min-w-32 items-center gap-1 whitespace-nowrap rounded-xl bg-surface-raised p-1 shadow-popover ring-1 ring-border"
        data-test="grocery-qty-editor"
        @click.stop
      >
      <button
        type="button"
        class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
        aria-label="Decrease quantity"
        data-test="grocery-qty-minus"
        @click="step(-1)"
      >
        <Minus :size="16" aria-hidden="true" />
      </button>
      <input
        ref="valueInput"
        v-model="draft"
        type="text"
        inputmode="decimal"
        class="h-11 w-20 rounded-lg bg-transparent text-center font-mono-data text-label-md tabular-nums text-text outline-none"
        :aria-label="`Quantity for ${name}`"
        data-test="grocery-qty-value"
        @keydown.enter="commit"
        @keydown.esc="closeEditor"
        @click.stop
      />
      <button
        type="button"
        class="flex size-11 shrink-0 items-center justify-center rounded-lg text-text transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
        aria-label="Increase quantity"
        data-test="grocery-qty-plus"
        @click="step(1)"
      >
        <Plus :size="16" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-11 shrink-0 items-center rounded-lg px-3 text-label-sm font-medium text-text-muted transition-colors hover:text-text"
        data-test="grocery-qty-reset"
        aria-label="Reset to the derived amount"
        @click="resetToDerived"
      >
        Reset
      </button>
      <button
        type="button"
        class="flex h-11 shrink-0 items-center rounded-lg bg-brand px-3 text-label-sm font-semibold text-on-brand transition-colors hover:bg-brand-strong active:bg-brand-strong"
        data-test="grocery-qty-done"
        @click="commit"
      >
        Done
      </button>
      </div>
    </Teleport>
  </span>
</template>
