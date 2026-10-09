# Design boards — Warm Culinary Paper, both themes, all surfaces

Rendered verification for the redesign (EXPERIENCE.md §9 slice 7): every
surface captured in BOTH themes at desktop 1280×800 and Pixel 7 390×844,
from the BUILT bundle (`bun run build` first). `recipes`/`plan`/`grocery`/
`shop`/`cooking` show real app state — a recipe was actually planned and
opened in the capture session; `history` and `settings` render as a fresh
context sees them (History shows its honest empty state; Settings is fully
rendered).

Regenerate with:

```bash
bun run build
node scripts/capture_design_boards.mjs   # writes these files + MANIFEST.generated.txt
```

The capture session aborts every non-localhost request (offline-first,
ADR-0029). Boards are checked-in artifacts: regenerate after a surface
changes, and REVIEW them (DESIGN.md contract §6: a screenshot saved but not
inspected is not visual verification).

## Surfaces

| Surface | Files | Notes |
| --- | --- | --- |
| Recipes (explore) | `recipes-{desktop,mobile}-{light,dark}.png` | header search well (desktop), quick-filter pills, 2/4-col photo grid, mono count |
| Plan | `plan-{desktop,mobile}-{light,dark}.png` | meal rows, mono totals strip, Auto-Plan's one filled tomato |
| Grocery | `grocery-{desktop,mobile}-{light,dark}.png` | aisle cards, N/M mono pills, extras group, Start shopping |
| Shop | `shop-{desktop,mobile}-{light,dark}.png` | fullscreen, exit bar + honest N/M (pct%) progress |
| Cooking | `cooking-{desktop,mobile}-{light,dark}.png` | chromeless 672px measure, one 20px step, timer row |
| History | `history-{desktop,mobile}-{light,dark}.png` | head + sharing note + summary strip + period pills + honest empty state |
| Settings | `settings-{desktop,mobile}-{light,dark}.png` | section cards at headline-sm, field wells, danger Leave outline |

28 files. Dark captures use the app's own theme toggle (the `.dark` flip,
ADR-0036) — no devtools emulation, so the boards show exactly what the
toggle shows.

## Contrast sweep

`node scripts/contrast_sweep.mjs` (after `bun run build`) is the measured
WCAG pass over the same surfaces/themes: computed fg/bg for every visible
text and control keyline, tints composited (2026-10-10 run quoted in the
slice-6/7 report — 0 FAIL both themes; worst text 5.05:1 light, 6.0:1 dark;
worst control keyline 3.38:1 light, 5.36:1 dark).
