# ADR-0060: Build-time changelog module — git-derived, committed artifact, header modal

Status: accepted (2026-10-07)

## Context

The header shows the build-time app version (`__APP_VERSION__`, ADR-0039;
`data-test="app-version"` in `src/App.vue`), but nothing tells a user WHAT
changed between the version they run and the one before it. The repo's release
model gives us everything a changelog needs, in one place:

- **A `v*` tag IS the release** — no GitHub Release objects exist, so the
  tag list is the complete version space (census 2026-10-07: **34 tags**,
  `v0.1.0` … `v2.2.0`).
- **Conventional Commits are the house style**, and squash-merged PRs land
  as single conventional subjects carrying their own provenance:
  `feat(favourites): import from Mealime via bookmarklet (ADR-0058) (#53)`,
  `feat(units): measured rounding vocabulary — proper fractions, linear
  seasonings, mm conversion (ADR-0054) (#51)`. The trailing `(#NN)` is the
  PR, `(ADR-NNNN)` the design record; both are parseable from the subject.

Constraints that shape the design:

- **The app is offline-first and e2e-enforces zero external requests.** Any
  runtime source must be same-origin and shipped in the repo.
- **The Docker build context has NO git metadata.** The release image is
  built from a tarball context where the only version fact is the
  `APP_VERSION` build-arg (ADR-0039, review #7) — a changelog derived from
  git AT BUILD TIME would be EMPTY in every self-hosted image while working
  in the CI/Cloudflare builds. That asymmetry, not convenience, decides
  where the artifact lives.
- The changelog is read rarely (a modal open), not on every launch — so
  payload should be lazy-loaded, not bundled into the JS.

## Decision

1. **The changelog artifact is COMMITTED and generated, not derived at
   build time.** `public/data/changelog.json` is produced by
   `scripts/build_changelog.py` (stdlib-only, house generator style) from
   the repo's git history. The Docker path (no `.git` in context) serves
   the committed file unchanged, so a self-hosted user and a
   flambette.app user see the same changelog. This is the same
   committed-artifact stance as every `public/data/*.json` in the repo.

2. **Source of truth: `git tag` + conventional-commit subjects between
   tags.** For each `v*` tag, `git log <prev>..<tag>` (repo start for the
   first tag) is partitioned by the conventional type: `feat` →
   `features`, `fix` → `fixes`. Merge commits are skipped (squash merges
   carry the subject already). `chore`/`docs`/`refactor`/`test`/`ci` are
   EXCLUDED — the changelog is user-facing, and dependency bumps and
   compose-version bumps are not what a household opens a changelog for.
   Subject post-processing extracts, into separate fields: the scope
   (`feat(units): …`), trailing `(ADR-NNNN)` references, and the trailing
   `(#NN)` PR reference — leaving the human-readable text. A subject that
   parses to no entry type is skipped, not invented into a bucket.

3. **Each version has an AUTHORED title; derivation is only the fallback.**
   A title table inside the generator carries the editorial title per
   version ("Import favourites from Mealime" for v2.2.0, …). Prepopulated
   for all 34 existing tags in the same change that adds the generator.
   An unlisted version falls back to the first `feat` subject (first
   `fix` when there is no feat, "Maintenance release" when neither) — a
   fallback is a placeholder the next release procedure replaces, never
   an override (authored > derived, the repo's standing precedence).

4. **Artifact shape is additive and validated at the edge.**

   ```json
   {
     "generatedAt": "2026-10-07T…",
     "versions": [
       {
         "version": "v2.2.0",
         "date": "2026-10-06",
         "title": "Import favourites from Mealime",
         "features": [{"text": "…", "scope": "favourites", "pr": 53, "adr": "ADR-0058"}],
         "fixes": [{"text": "…", "scope": null, "pr": 52, "adr": null}]
       }
     ]
   }
   ```

   Newest first; `date` is the tag's commit date; `pr`/`adr`/`scope` are
   optional. `src/lib/changelog.ts` validates and normalizes the fetched
   JSON defensively (same stance as backup import: an artifact is untrusted
   input), unit-tested in `src/lib/changelog.test.ts`.

5. **The header version becomes the trigger.** The version span
   (`data-test="app-version"`) becomes a `<button>` that opens
   `ChangelogModal.vue`. The modal follows the NutritionModal pattern
   (ADR-0039-nutrition-facts-modal): teleported to `body`, focus trap,
   Escape closes, scrim click closes, focus restored to the trigger on
   every close path. The ADR-0055 hover tooltip on the version survives —
   the button hosts the same `TooltipBubble`, so keyboard and pointer
   affordances stack instead of replacing each other.

6. **Data is lazy-fetched same-origin on first open and cached in memory
   for the session.** `fetch('/data/changelog.json')` — covered by the
   catalog's own cache rule (`/data/*` `max-age=300, must-revalidate` in
   `public/_headers`, "content-addressed per release, revalidated not
   pinned"). A fetch failure renders an error state INSIDE the modal
   (retry affordance), never a toast loop and never a crash — the app
   works offline, and the changelog is the least critical surface in it.

7. **Gates, wired where the other generated artifacts' gates live.**

   - `bun run data:changelog` regenerates the artifact (package.json).
   - `scripts/test_build_changelog.py` — goldens on parsing (feat/fix
     split, scope/PR/ADR extraction, chore exclusion, merge skipping) —
     joins `bun run test:data`.
   - `--check` exits 1 when the committed artifact is stale against a
     fresh derivation, and joins the CI staleness block in `ci.yml`
     beside `extract_ingredients.py --check`. CI checks out
     `fetch-depth: 0`, so the gate always has the real tag space.
   - The release procedure gains one step: after a release PR
     squash-merges, run `bun run data:changelog` BEFORE tagging — the new
     tag makes the committed artifact stale, and `--check` on the next
     main build fails until it is regenerated. The gate is the forcing
     function; the ADR is the reminder.

8. **No new runtime dependencies; nothing persisted** — no store slice, no
   `STORE_SLICES` entry, no pinia key.

## Consequences

- Every self-hosted image and the Cloudflare worker ship an identical,
  reviewable changelog; a release forgetting to regenerate is caught by
  CI, not by a user noticing a missing entry.
- The artifact grows one small entry per release (34 versions ≈ a few KB
  gzipped) and is fetched once per session at most, only when the user
  opens the modal — no bundle growth, no startup cost.
- A version's title is editorial work done at release time (one line in
  the generator's table), which is the point: the title says what the
  release MEANT, which no commit parser can derive.
- Changelog entries can only describe what git history records — a
  deliberately invisible fix (never committed with `fix:`) is invisible
  here too. That is the same "the generator emits what the corpus
  contains" honesty the other derived artifacts live by.

## Alternatives considered

- **Derive at vite build from git (CI/preview only).** Breaks the Docker
  self-host image (no `.git` — empty changelog) and makes PR preview
  builds advertise unreleased entries. Rejected on the asymmetry.
- **Bundle the JSON into the app via `import`.** Cost every visitor their
  whole changelog on every load for a surface most sessions never open.
  The catalog already established lazy same-origin fetch for rarely-read
  bulk data; the modal follows it.
- **GitHub Releases API.** No release objects exist (a `v*` tag IS the
  release), and a runtime call to github.com would violate the offline
  enforcement outright.
- **Hand-maintained `CHANGELOG.md`.** The generated-list rule (ADR-0053's
  lesson): a prose file enumerating per-release entries drifts the first
  time someone forgets to edit it. Git + conventional commits are the
  single source; the artifact is derived from it, and the goldens keep
  the parser honest.
- **Auto-generated titles from the dominant commit.** A title is an
  editorial claim ("what this release meant"), not a summary of the
  largest diff. Authored table with a derived fallback keeps the intent
  and still never blocks a release.
