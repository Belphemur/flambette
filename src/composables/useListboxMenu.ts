/**
 * A `role="listbox"` popup for a compact filter trigger (ADR-0027, ADR-0043).
 *
 * The Recipes tab grew a SECOND popup — the meal-type dropdown (ADR-0043)
 * — and it must behave exactly like the sort menu that was already there:
 * arrow keys walk the options, Home/End jump, Escape closes and returns
 * focus to the trigger, Tab ends the interaction, and a pointer-down
 * outside dismisses. That is ~70 lines of focus bookkeeping, and a second
 * hand-written copy is how the two menus would drift apart (one with a
 * focus bug, one without a click-away).
 *
 * So the behaviour lives ONCE, here, parameterised by the option count and
 * "which option is selected right now". The trigger keeps its own label
 * and aria wiring; the popup markup stays in the view, so the
 * `data-test` contract each spec asserts is unchanged.
 *
 * Each instance registers its own document listeners and each listener
 * returns immediately unless ITS menu is open, so N menus cost N cheap
 * no-op handlers rather than one handler that has to know about all of
 * them.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export interface ListboxMenu {
  /** Whether the popup is mounted. */
  open: Ref<boolean>
  /** Wrapper element (trigger + popup); a pointer-down inside keeps it open. */
  wrapEl: Ref<HTMLElement | null>
  /** The trigger button, refocused on an Escape-style close. */
  triggerEl: Ref<HTMLElement | null>
  /** Index of the option that currently holds DOM focus. */
  focusIndex: Ref<number>
  /** Collect option elements: pass straight to a `:ref` in the v-for. */
  setOptionEl(el: Element | null, index: number): void
  openMenu(): void
  closeMenu(opts?: { refocus?: boolean }): void
  /** Bound to the popup's `@keydown`. */
  onMenuKeydown(e: KeyboardEvent): void
}

export function useListboxMenu(count: number, selectedIndex: () => number): ListboxMenu {
  const open = ref(false)
  const wrapEl = ref<HTMLElement | null>(null)
  const triggerEl = ref<HTMLElement | null>(null)
  const focusIndex = ref(0)
  const optionEls = ref<HTMLElement[]>([])

  function setOptionEl(el: Element | null, index: number) {
    if (el instanceof HTMLElement) optionEls.value[index] = el
  }

  function focusOption(index: number) {
    // Modulo, not clamp: ArrowUp on the first option wraps to the last,
    // which is what a listbox does (and what the sort menu already did).
    const at = (index + count) % count
    focusIndex.value = at
    optionEls.value[at]?.focus()
  }

  function openMenu() {
    open.value = true
    focusIndex.value = Math.max(0, Math.min(selectedIndex(), count - 1))
    // The listbox exists only after this tick.
    void nextTick(() => focusOption(focusIndex.value))
  }

  function closeMenu({ refocus = false } = {}) {
    open.value = false
    if (refocus) void nextTick(() => triggerEl.value?.focus())
  }

  function onMenuKeydown(e: KeyboardEvent) {
    switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      focusOption(focusIndex.value + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      focusOption(focusIndex.value - 1)
      break
    case 'Home':
      e.preventDefault()
      focusOption(0)
      break
    case 'End':
      e.preventDefault()
      focusOption(count - 1)
      break
    case 'Escape':
      e.preventDefault()
      // Stop here: the Recipes tab's own Escape handler (and anything
      // above it) must not also act on the same keystroke.
      e.stopPropagation()
      closeMenu({ refocus: true })
      break
    case 'Tab':
      // Tabbing out ends the interaction rather than stranding focus.
      closeMenu()
      break
    }
  }

  /** Click-away closes; the trigger itself is inside the wrapper. */
  function onPointerDown(e: PointerEvent) {
    if (!open.value) return
    const target = e.target as Node | null
    if (target && wrapEl.value?.contains(target)) return
    closeMenu()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open.value) closeMenu({ refocus: true })
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeydown)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeydown)
  })

  return { open, wrapEl, triggerEl, focusIndex, setOptionEl, openMenu, closeMenu, onMenuKeydown }
}
