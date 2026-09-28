# ADR-0016: Backup & restore moves to a fifth Settings tab

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0013 (backup JSON/zip format, `STORE_SLICES`
registry). Nothing about the format, the registry or the import
validity rules changes — only the host surface moves.

## Context

ADR-0013 put backup & restore at the bottom of the Plan tab, which
made it reachable with an empty plan (a fresh device is exactly when you
need a restore). But it is the only part of the Plan tab that is not
about the plan: it manages groceries, checked items, cooked history,
favourites, custom-ingredient memory and settings — every persisted
slice at once. Sitting under the meal list it read as a footnote to
planning, and the reference screenshot showed it as its own top-level
screen.

Adding it as a fifth bottom tab was the open question: the bar fit four
labels, and the failure modes are a truncated "Grocery", a stacked
two-line label, or a silent accessibility loss (icon-only tabs with no
accessible name).

## Decision

1. **New bottom tab** `/settings` — label "Settings", gear icon,
   `data-test`-addressable through the standard nav. It renders the
   existing backup & restore UI (Export / Import buttons, the offline
   blurb, the confirm dialog) **moved**, not duplicated: the logic
   (`buildBackupZip` / `applyBackup` / `backupFileName`) is unchanged
   and still registry-driven, so the AGENTS.md rule that every
   persisted slice is registered in `STORE_SLICES` keeps one home.
2. **The Plan tab keeps the share surface** (one-time link + live room)
   and loses the backup block entirely.
3. **All five tabs keep visible labels — measured, not assumed.** At
   Pixel 7 (412px viewport, 410px nav row) five `flex-1` tabs give
   82px each; the widest label is "Settings" at 49px ("Recipes" 48px,
   "Grocery" 47px, "History" 43px) and every button reports
   `scrollWidth == clientWidth`, i.e. no truncation, no overflow and no
   wrapping. So no label is dropped, History is NOT demoted to a
   drill-down, and there is no icon-only or `sr:`-only fallback whose
   accessible name would differ from its visible label. The fit is
   pinned by an e2e assertion so a future 6th tab cannot silently break
   it.
4. **Deep-linkable**: `/settings` is a router route, and the tab
   participates in `KeepAlive` like the other tabs.

## Consequences

- Specs that used to reach export/import through the Plan tab navigate
  to Settings instead; after an import the caller must return to the
  tab it wants to assert on (the import no longer leaves it on Plan).
- The nav now has five destinations, each 82px wide at phone width:
  adding a sixth tab requires a re-measure (the e2e guard will fail on
  the label that overflows) and probably a different navigation shape
  (a settings entry inside Settings, or a top-bar overflow).

## Alternatives considered

- **Keep it on the Plan tab** — rejected: the screenshot shows it as a
  data surface, and it is unrelated to any single meal plan.
- **Move History under Settings as a drill-down to make room for a
  label** — rejected on measurement (nothing overflowed) and on cost:
  History is a top-level destination the user reaches after cooking, not
  a sub-setting.
- **Icon-only tabs with `aria-label`s** — rejected: it degrades every
  label for a problem that does not exist, and it makes the visible
  affordance and the accessible name diverge.
