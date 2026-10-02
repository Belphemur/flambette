/**
 * One shared pointer hit-test for icon tooltips (ADR-0044).
 *
 * WHY THIS EXISTS: `HueIcon`'s host is `pointer-events-none` so the browse
 * card's stretched link keeps its click path — and a pointer-transparent
 * element can never match `:hover`. CSS therefore cannot scope the tooltip
 * to the icon, so the hit-test happens here, in JS: each subscriber
 * registers an element and is told whether the pointer is inside it.
 *
 * DRY: up to 60 cards × 2 icons render on the Recipes tab. A per-icon
 * `mouseenter` would be ~120 handlers doing identical work; there is ONE
 * `pointermove` listener on `window` for the whole app, installed when the
 * first subscriber mounts and removed when the last one unmounts. Between
 * moves it is a cheap no-op, and it is `passive` so it can never block
 * scrolling. The reveal itself is still gated by `@media (hover: hover)`
 * in the component (ADR-0040), so a touch device never reaches this path.
 *
 * SOLID — the rect cache is load-bearing: `getBoundingClientRect()` per
 * subscriber per mouse-move would force layout on every move (the classic
 * scroll-jank bug), so each subscriber caches its rect. The cache is
 * INVALIDATED on `scroll` and `resize` (passive) and after `nextTick` —
 * a stale rect would open the tooltip for an icon that has scrolled away,
 * which is a correctness bug, not a refinement. The invalidation marks the
 * cache dirty and the next animation frame re-measures once, so scrolling
 * costs at most one layout read per frame, never per event.
 *
 * KISS escape hatch (recorded in ADR-0044): if a future change ever makes
 * this conditional, delete it back to a per-icon `mouseenter`.
 */
import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'

interface Subscription {
  /** The element whose rect is hit-tested. */
  el: Ref<HTMLElement | null>
  /** Written with the hit verdict; drives the bubble's reveal class. */
  inside: Ref<boolean>
  /** Cached rect; null while the element is unmounted. */
  rect: DOMRect | null
}

const subscriptions = new Set<Subscription>()

let raf = 0
let pointerX = 0
let pointerY = 0
/** False until the first `pointermove`, and false again if the pointer
 *  leaves the window — an absence of movement is not evidence of hovering. */
let pointerSeen = false
/** The cached rects are stale and must be re-measured before the next hit-test. */
let rectsDirty = true

/** Re-read every subscriber's rect. Called at most once per frame. */
function measure() {
  for (const sub of subscriptions) {
    const el = sub.el.value
    sub.rect = el ? el.getBoundingClientRect() : null
  }
  rectsDirty = false
}

/** The rAF callback: re-measure if dirty, then hit-test every subscriber. */
function flush() {
  raf = 0
  if (subscriptions.size === 0) return
  if (rectsDirty) measure()
  for (const sub of subscriptions) {
    const rect = sub.rect
    const hit =
      pointerSeen &&
      rect !== null &&
      pointerX >= rect.left &&
      pointerX <= rect.right &&
      pointerY >= rect.top &&
      pointerY <= rect.bottom
    if (sub.inside.value !== hit) sub.inside.value = hit
  }
}

function schedule() {
  if (raf === 0 && subscriptions.size > 0) raf = requestAnimationFrame(flush)
}

function onPointerMove(event: PointerEvent) {
  pointerX = event.clientX
  pointerY = event.clientY
  pointerSeen = true
  schedule()
}

/** Scroll events do not bubble, but they DO reach `window` during the
 *  capture phase — one capturing listener covers every scroll container. */
function onScroll() {
  rectsDirty = true
  // Re-run the hit-test even with a stationary pointer: the icon may have
  // scrolled out from under it.
  schedule()
}

function onResize() {
  rectsDirty = true
  schedule()
}

function onPointerOut(event: PointerEvent) {
  // `relatedTarget` is null exactly when the pointer left the document.
  if (event.relatedTarget === null) {
    pointerSeen = false
    schedule()
  }
}

function install() {
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onResize, { passive: true })
  window.addEventListener('pointerout', onPointerOut, { passive: true })
}

function uninstall() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('scroll', onScroll, { capture: true })
  window.removeEventListener('resize', onResize)
  window.removeEventListener('pointerout', onPointerOut)
  if (raf !== 0) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

/**
 * Subscribe ONE element to the shared hit-test. `inside` is flipped to
 * `true` while the pointer is within the element's (cached) rect and back
 * to `false` when it leaves — including when the element scrolls away or
 * the pointer leaves the window. Everything is torn down on unmount.
 */
export function useIconHoverTarget(el: Ref<HTMLElement | null>, inside: Ref<boolean>): void {
  const subscription: Subscription = { el, inside, rect: null }

  onMounted(() => {
    subscriptions.add(subscription)
    rectsDirty = true
    if (subscriptions.size === 1) install()
    schedule()
    // After this tick the DOM has settled (the element may have moved or
    // mounted late), so measure fresh.
    void nextTick(() => {
      rectsDirty = true
      schedule()
    })
  })

  onBeforeUnmount(() => {
    subscriptions.delete(subscription)
    inside.value = false
    if (subscriptions.size === 0) uninstall()
  })
}