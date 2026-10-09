# ADR-0066: Typography — self-hosted Plus Jakarta Sans + JetBrains Mono

**Status:** Accepted (2026-10-09)
**Supersedes:** the system-ui-only type rule implicit in DESIGN.md v1
**Companions:** ADR-0065 (chrome/fields), ADR-0067 (colour adoption), `docs/EXPERIENCE.md` §4

## Context

The v2 experience ("Warm Culinary Paper", rendered in the Stitch project
"Flambette Recipe App") sets type in **Plus Jakarta Sans** (headlines, body,
labels) and reserves **JetBrains Mono** as the DATA voice — quantities, cook
times, dates, counts, room codes, aisle indices, versions. The owner reviewed
the Stitch renders and accepted the pairing. The repo's offline-first rule
(no runtime request to any external host, enforced by e2e) rules out CDN font
loading, and ADR-0029 already establishes that runtime fetches of presentation
assets fail e2e by design.

## Decision

1. Both families ship **self-hosted**: subset WOFF2 files committed in-repo,
   loaded via `@font-face` with `font-display: swap`. Zero network requests;
   OFL licences ship alongside the files. Offline-first is satisfied by
   possession, not by the absence of fonts.
2. The type ladder adopts Stitch's scale as named utilities in the
   `@theme` block of `src/style.css`: `display-lg` 48/56, `headline-lg`
   36/44, `headline-md` 24/32, `headline-sm` 20/28, `body-lg/md/sm`
   18/16/14, `label-md` 14/600, `label-sm` (JetBrains Mono 12/500,
   +0.04em) and `mono-data` (JetBrains Mono 13/18). A dedicated
   `headline-lg-mobile` 28/36 step serves phones. The cooking view keeps
   its measured 20px/1.6 step (ADR-0009's 672px reading measure untouched).
3. Mono is a ROLE, not a decoration: numbers, dates, durations, room codes,
   device ids, versions, aisle indices. Prose never renders in mono.
4. Components consume semantic classes only (`font-mono-data`,
   `text-headline-*`); raw `font-family` declarations in components are
   not allowed. Tailwind scans literal class names — same discipline as
   the hue classes (ADR-0036).

## Consequences

- Bundled WOFF2 adds ~60–120 KB per family subset — acceptable against the
  offline-first guarantee; subsets stay latin-only.
- FOUT is possible on first paint; `swap` + metric-compatible fallbacks
  (system-ui, ui-monospace) keep CLS tolerable. e2e does not assert fonts.
- DESIGN.md's Typography section is rewritten as part of DESIGN.md v2 and
  its YAML front-matter mirrors the ladder; the DTCG export refreshes with
  it. `palette.test.ts` parity is untouched (colour families only).
- Any future icon/glyph need stays with `lucide-vue-next` (ADR-0029);
  typography and icons do not mix.
