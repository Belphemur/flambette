# ADR-0029: One bundled icon stack (Lucide), no glyph characters

**Status:** Accepted (2026-09-30)
**Extends:** ADR-0016 (settings tab / five-tab nav fit). First icon
decision in the project; it did not previously have one.

## Context

There was no icon library. Every icon in the app was either a
hand-rolled inline `<svg>` or a text glyph typed straight into the
markup: `✕ ★ ☆ − + ✓ ▸ ▾ ＋` as controls, and `🍽 🛒 🔍 🥗 ☀️ 🌙 🔗 🎲 ⬇ ⬆ 🔥 ⏱ 🧂 🍳 😵 ⏳ ⏺ 🎉` as decoration and
nav. That is a real defect, not a style preference:

- **Rendering is device-dependent.** `▸` and `▾` and `＋` are fullwidth
  forms: they fall back to whatever CJK-capable font the device has, at
  a different weight and baseline, and `☀️`/`🌙` are colour emoji whose
  presentation the OS owns.
- **`★` vs `☆` as a control.** The favourite toggle's whole state lived
  in a glyph swap, which is unreadable to a screen reader and untestable
  without matching a character.
- **Nothing is inspectable.** There is no way to give an icon a size, a
  stroke weight or a single styling hook.

## Decision

**`lucide-vue-next` is the icon stack, bundled at build time.**

- Imported per component (`import { Star, X } from 'lucide-vue-next'`).
  The package is ESM with `sideEffects: false`, so Rollup tree-shakes
  it: the production bundle grows by roughly the icons actually used
  (~11 kB), not by the 3,400-icon catalogue.
- **No CDN, no icon font, no runtime fetch of any kind.** The app is
  offline-first and e2e blocks every external request; an icon font from
  a CDN would fail CI by design. `bun add` puts it in `bun.lock` and it
  ships in `dist/assets/`.
- **Decorative icons are `aria-hidden="true"`; interactive ones carry a
  real `aria-label`.** Where a glyph used to be the state (the step
  timer's play/pause, a section header's collapse chevron), the state is
  now carried by something queryable: the timer's `aria-label` and
  `aria-expanded`. The specs assert those instead of a character.
- **The recipe placeholder in `src/lib/images.ts` keeps its inline
  `svg`.** It is a 1×1 `data:` URL, not an icon — swapping it would mean
  shipping a raster file to replace a baked-in constant.
- **`TABS[].icon` is a `Component`, not a string.** The five bottom-tab
  labels, their order and their measured Pixel 7 fit are untouched
  (ADR-0016): icons changed, the layout did not.

## Consequences

- New icons come from the library, never from a glyph or a hand-rolled
  path. `grep` for the old characters over `src/` is the check.
- Stroke-based icons inherit `currentColor`, so a chip's active state
  still drives its icon.
- The dependency is a real one. It is bundled, tree-shaken and pinned by
  `bun.lock`; the offline rule is unaffected.

## Alternatives considered

- **An icon font (Material Symbols / Font Awesome).** Rejected: it needs
  a network request or a large committed binary, and brings a second
  rendering path next to the app's own text.
- **Keep glyphs, normalise them.** Rejected: it cannot fix
  device-dependent rendering or make icon state queryable, which is what
  the specs needed.
- **Hand-rolled SVGs, tidied.** Rejected: every icon becomes a bespoke
  path to review, and there were already a dozen.
