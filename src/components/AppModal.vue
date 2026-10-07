<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'

/**
 * THE modal surface (coding-philosophy DRY — one copy of the machinery).
 *
 * Every dialog in the app once carried its own copy of the same a11y
 * machinery: teleport, overlay, dialog panel, focus trap, focus restore,
 * Escape handling. Four copies had already DRIFTED — the kody review fix to
 * the tab trap (the panel is the wrap TARGET, never appended as a tab stop —
 * `tabindex="-1"` makes it a stop the user can never be on, which silently
 * defeated the forward wrap) lived only in JoinCongratsModal while the other
 * three kept the unfixed variant. AppModal owns the machinery ONCE; the
 * consumers own their content, their visuals (full class lists come in as
 * props — Tailwind scans the caller's literal strings) and their own close
 * control.
 *
 * Focus MANAGEMENT, not just focus placement (a11y: `aria-modal="true"` is a
 * promise). Three rules, all here because every consumer mounts `v-if`-gated
 * so one mount == one open:
 *
 *  1. remember the trigger (`document.activeElement`) before focus moves
 *     in, and restore it on EVERY close path — unmount covers the close
 *     button, Escape, the scrim and a parent-driven close alike;
 *  2. TRAP Tab inside the panel: without this Tab walks into the app behind
 *     the backdrop;
 *  3. the panel itself is the wrap TARGET when focus is on it or outside it
 *     (the state a modal opens in), never a member of the stop list — it
 *     carries `tabindex="-1"`.
 *
 * `dismissable: false` (JoinCongratsModal) removes the Escape and scrim
 * dismissal — the only way out is the caller's own control — while the focus
 * machinery stays, because `aria-modal="true"` is a promise either way.
 */
const props = withDefaults(
  defineProps<{
    /** Accessible name for the dialog (the panel's `aria-label`). */
    dialogLabel: string
    /** Scrim click + Escape close the modal (default). */
    dismissable?: boolean
    /** FULL overlay class list — layout, z-index and surface stay the caller's visual identity. */
    overlayClass: string
    /** FULL panel class list — shape, size and surface stay the caller's visual identity. */
    panelClass: string
    /** `data-test` for the overlay, if the specs pin one. */
    overlayTest?: string
    /** `data-test` for the dialog panel, if the specs pin one. */
    panelTest?: string
  }>(),
  { dismissable: true, overlayTest: undefined, panelTest: undefined },
)

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

let restoreFocusTo: HTMLElement | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  return panel.value
    ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    : []
}

/**
 * Keep Tab (and Shift+Tab) inside the panel.
 *
 * The trap walks `focusables()` — the CONTROLS — and never the panel
 * itself: the panel carries `tabindex="-1"`, so it is not a tab stop,
 * and appending it made `last` a node the user can never be on, which
 * silently defeated the forward wrap (review kody). The panel is instead
 * the wrap TARGET when focus is on it or outside it, which is the state
 * it is actually opened in.
 */
function trapTab(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !panel.value) return
  const stops = focusables()
  if (stops.length === 0) {
    // Nothing to reach: keep focus on the panel rather than letting it go.
    e.preventDefault()
    panel.value.focus()
    return
  }
  const first = stops[0]
  const last = stops[stops.length - 1]
  const active = document.activeElement
  if (!active || active === panel.value || !panel.value.contains(active)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.dismissable) {
    e.stopPropagation()
    emit('close')
    return
  }
  trapTab(e)
}

function onScrim() {
  if (props.dismissable) emit('close')
}

onMounted(() => {
  restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKey)
  void nextTick(() => panel.value?.focus())
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  const target = restoreFocusTo
  restoreFocusTo = null
  if (!target) return
  void nextTick(() => {
    if (document.contains(target)) target.focus()
    else document.body.focus?.()
  })
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0"
      :class="overlayClass"
      :data-test="overlayTest"
      @click.self="onScrim"
    >
      <div
        ref="panel"
        tabindex="-1"
        class="outline-none"
        :class="panelClass"
        role="dialog"
        aria-modal="true"
        :aria-label="dialogLabel"
        :data-test="panelTest"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
