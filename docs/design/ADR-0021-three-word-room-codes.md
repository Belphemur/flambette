# ADR-0021: Room codes are three words, and legacy codes still join

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0004 (share URLs and rooms), ADR-0006 (relay), ADR-0019
(persistent household room). The room protocol, the shared state, the
relay's storage model and the LWW semantics are unchanged — only the
*shape of the code*.

## Context

A room code was 6 characters of Crockford base32 minus vowels
(`K7H2BQ`). It had one virtue — it could not spell anything — and one
serious defect: **transcription**. Reading `K7H2BQ` aloud, typing it on a
second phone, or reading it from a screenshot to a partner fails
constantly. Every support path for the two-phone household flow
(ADR-0019) still has the user typing that code once.

The code is a *join key*, not a secret and not high-entropy: it names a
room, and the relay holds the state for 12 h idle. Nothing about the
protocol needs it to be unpronounceable.

## Decision

1. **A code is three lowercase words joined by hyphens** —
   `amber-falcon-lantern`. Word lists are curated in
   `src/lib/roomWords.ts`: a color, an animal and a place/object, 64+
   entries each, all lowercase ASCII, 3–10 letters, no profanity or
   otherwise sensitive terms. 64³ ≈ 262,144 combinations, which is ample
   for "one household among a few hundred", and the lists are readable,
   which is the whole point.

2. **The code is rolled CLIENT-side.** The relay honours a free
   three-word code sent with `create` and answers `code_taken`
   otherwise; the client then re-rolls (up to three times) and finally
   falls back to letting the relay mint a legacy code. Rolling on the
   client is what makes the code *shareable*: the user can read it off
   their own screen before anyone tries to join.

3. **Legacy codes remain valid input — the accepted format is the
   UNION.** `WORD_ROOM_CODE_RE` (`/^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/`)
   or `LEGACY_ROOM_CODE_RE` (`/^[A-Z0-9]{4,12}$/`), the exact pre-ADR
   shape. An existing ADR-0019 household keeps its persisted code and its
   room across the upgrade; nothing is invalidated. The relay normalizes
   both shapes on join, so a peer may send either in any spelling.

4. **Input normalization is forgiving; storage is canonical.** `Amber
   Falcon-Lantern`, `amber_falcon lantern`, `AMBER-FALCON-LANTERN` and
   `amberfalconlantern` all normalize to `amber-falcon-lantern`; a legacy
   code is upper-cased exactly as ADR-0019 stored it. A run-together
   token is only split when the parts are real entries of the curated
   lists, and only when that split is unique — guessing letter offsets
   would invent words. A **partial** word code (`amber-falcon`) is
   refused rather than coerced: joining the wrong room is worse than an
   error message.

5. **Settings gets a "New code" affordance.** It fills the field with a
   fresh three-word code; Save/Join now normalize what was typed. The
   field lost `maxlength="12"` and the uppercase styling.

## Alternatives considered

- **Keep the alphanumeric code, add a nickname.** Rejected: two names
  for one room doubles the states and the errors; the code itself was
  never the problem to keep.
- **Random words with no curation** (like `docker run --name`). Rejected
  for a household app: with ~262k combinations, uncurated sampling hits
  awkward or unfortunate strings often enough to matter, and generated
  code *shape* is also what the input parser has to accept.
- **Randomly ordered lists (word-word-word).** Rejected: fixed order
  makes a mistyped code recognisable at a glance ("that's a color in
  the middle") and makes the generator trivial to unit-test.
- **Reject legacy codes on write.** Rejected: it would silently break
  every persisted ADR-0019 household on upgrade for no security gain.
- **Longer words / four words.** Rejected: typing cost grows linearly and
  3 words already give ≈262k. Note the format accepts 3–10 letters per
  word, so the lists can grow without a format change.

## Consequences

- A code can be read aloud, dictated, or re-typed correctly on the first
  attempt; this is the single biggest reduction in support burden for the
  two-phone flow.
- **Collisions are tolerated by design.** A `code_taken` re-roll is
  invisible to the user; a *wrong* code joins an empty room, which shows
  an empty plan and a "Sync with live room CODE" affordance, and the
  user re-rolls. This is safe because a room carries no secrets and its
  state is trivially re-seeded by whoever still has it.
- Persisted `householdRoom` values are unchanged for existing users; new
  codes are lower-case and hyphenated everywhere they are displayed.
- The relay keeps both code shapes; its `normalizeCode` mirrors
  `normalizeRoomCode` on the client, and the two are covered by unit
  tests plus e2e cases that join a legacy room end-to-end.
