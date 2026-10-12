# Grocery list and extras

- **Extras (ADR-0015, superseded in part by ADR-0050)**: a free-form add
  that belongs to no planned meal is an "Extra" and lives in the
  **EXTRA ITEMS** group, which renders FIRST on the Grocery tab (above
  every store section) with the add-row anchored under its header. The
  group header itself stays static (no chevron); the categories below it
  toggle. **Sub-sectioned, never routed** (ADR-0050): BOTH the Grocery
  tab and ShopView render extras through the ONE pure `groupExtras`
  (`src/lib/extraSections.ts`) — STORE_SECTIONS order, `Uncategorized`
  LAST, empty groups omitted — so an extras `Produce` sits in the extras
  group's own sub-section and NEVER joins the recipe-derived `Produce`.
  Never add a second grouping implementation. The per-row category PILL
  is gone (the heading above the row says it); its `data-test` no longer
  exists. `Other`/missing means the `Uncategorized` bucket. Collapse
  keys are namespaced (`extraCollapseKey` / `storeCollapseKey`) because
  an extras `Produce` and a store `Produce` sit side by side.
  Auto-collapse is UNIFORM across every group on both screens, a
  ONE-item extras sub-section included (ADR-0050's addendum reversed
  ADR-0008's manual-only rule: a group reading `N/N` while its
  neighbour is collapsed reads as "not working"). The checked-sink is
  `sinkChecked` (`src/lib/sink.ts`), shared by both surfaces — never
  re-spell its sort.
- **Extras' checked keys are DERIVED and reconciled (ADR-0050)**: an
  extra's checkbox key is `extra::<lowercased name>`, defined ONCE by
  `extraCheckedKey` (`src/lib/extraCheckedKeys.ts`) — never re-spell it
  in a component or a spec. The `::` delimiter is load-bearing: line
  keys are `${nameKey}||${display}`, so a `custom||` extras prefix would
  be indistinguishable from a line key for an ingredient normalizing to
  `custom`. The key and the extra are two facts that must agree, but
  `customItems` and `checked` travel as SEPARATE payload fields, so any
  peer can send a key with no matching extra. The residue is invisible
  and harmful: it reads "already done", so re-adding that name lands in
  a sub-section the done-map calls COMPLETE and auto-collapse HIDES the
  new row. `reconcileCheckedExtras` (pure, returns `changed`) is called
  at its TWO ingress points — `room.applyRemote` and backup's
  `checked.json` writer (a `?p=` share link was a third; ADR-0051
  retired it) — never as a watcher on `customItems` (that would put the
  grocery store inside the room-synced plan store). It never touches
  recipe-derived line keys, and it MIGRATES live legacy `custom||` keys
  to the current prefix in `persist.afterHydrate`, because a plain
  RELOAD is the case the three ingress points do NOT cover and missing
  it silently unchecks every already-checked extra on the first load
  after upgrade. `GroceryTab.removeExtra` also forgets its own key: that
  is the immediate local path; the reconciler is the backstop for keys
  arriving from outside.
- **Auto-collapse (ADR-0008 + addendum)**: GroceryTab AND ShopView
  collapse a category group on the false→true done transition and
  re-expand on true→false; the header keeps its chevron and `N/N` pill.
  In ShopView the collapse watcher is `flush: 'post'`, so the collapse
  is the LAST step after the checked-sink re-sort. ShopView's extras
  group stays manual-collapse-only.
- The grocery provenance pill must stay a flex sibling OUTSIDE the
  truncating name span (inside = tooltip clipped by `overflow-hidden`),
  and it stays `cursor-help` (a tooltip target).
