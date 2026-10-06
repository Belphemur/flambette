# ADR-0058: Mealime favourites import via bookmarklet (recipe_id-first matching)

Status: accepted (2026-10-06)

> **Change note (2026-10-08):** an applied import now also opens a SUCCESS
> MODAL in Settings — the preview tiles (image + title, resolved through
> the same `imageSrc`/`onImgError` pair every other tile uses), the
> headline counts ("52 favourites imported — 48 by id, 4 by name"; the
> honest zero reads "Your favourites already match — N recipes"), and the
> same missing/duplicates/removed sentences the inline report renders
> (one shared `mealimeReportLines` helper, so the two surfaces cannot
> drift). The failure paths — malformed paste, all-miss, catalog-load
> failure — never open it. This is presentation only: decision §4's
> apply semantics are untouched.

## Context

Mealime announced it will discontinue the service on **2026-10-21**; personal
data is deleted at shutdown and there is no official export (the company was
acquired; recipes move into a grocery-chain app that is not ours). That makes
favourites import a ONE-SHOT migration window, not an ongoing integration.

The app is offline-first and e2e-enforces zero runtime requests to any
`mealime.com` host, so the app itself can never call the Mealime API. The
household's favourites live only in each user's Mealime account, reachable
through `POST api.mealime.com/api/v2/get_builder_data` with
`Authorization: Token token=<token>` — the same RPC the catalog archiver used
(`scripts/sync_catalog.py`).

Live census (2026-10-06, one account, one fresh pull — all numbers measured,
not assumed):

- **Variant ids are re-issued on every API call.** The fresh pull overlapped
  our frozen catalog 0/2759 on both `feasible_variants` and `variant_data`
  keys — confirming ADR-0054's finding live. Baking "all Mealime variant ids"
  into the catalog is impossible in principle: there is no enumerable,
  stable id space to bake.
- **`recipe_id` is the stable key.** The fresh and frozen `recipe_id` sets
  overlap 2759/2759 (zero drift either way), and `recipe_id` ↔ frozen
  variant id is a strict 1:1 bijection. It is ALREADY committed in
  `variant_meta[].recipe_id` — no catalog change is needed; the import is a
  pure runtime lookup.
- The response's `favourites[]` rows carry `{id, recipe_variant_id, name,
  image_url}`. The **thumbnail folder number** in `image_url`
  (`cdn-uploads.mealime.com/uploads/recipe/thumbnail/<N>/...`) equals the
  `recipe_id` — verified 54/54 agreement, 0 disagreements.
- **54/56 favourites matched** our catalog by this bridge. The 2 misses are
  recipes that LEFT Mealime's feasible catalog (their ids exist in neither
  the fresh nor the frozen set) — unresolvable by any data change; an
  importer can only report them.
- `recipe_history` speaks the same `recipe_id` space (18/18 entries in the
  frozen set) — a future cooked-history import rides the same bridge.
- The session cookie `auth_token` on my.mealime.com is `httpOnly: false,
  secure: true`: readable by same-origin JavaScript on the Mealime page
  itself, useless to our cross-origin app (no CORS grant for us — only the
  my-web origin the app itself uses).

## Decision

1. **Transport: a bookmarklet the user runs on my.mealime.com.** One drag to
   the bookmarks bar, one click while logged in. The snippet runs in the
   Mealime page's own origin: it reads `auth_token` from `document.cookie`,
   POSTs `get_builder_data` (the API already whitelists the my-web origin),
   extracts `favourites[]`, maps the thumbnail folder number to `recipe_id`,
   and produces a small JSON payload `{source, generatedAt, favourites:
   [{recipe_id, name}]}` copied to the clipboard. No token, cookie, or
   password ever reaches Flambette, no proxy exists, and the app's
   zero-mealime-requests rule is untouched — ingestion is a PASTE, the same
   trust boundary as backup import (ADR-0013).
2. **Settings → "Import from Mealime"** entry (the `/settings` tab,
   ADR-0016) carrying: short instructions, the DRAGGABLE bookmarklet link
   (an `href="javascript:..."` anchor the user drops on their bookmarks
   bar), and a paste box that validates first and applies atomically.
3. **Matching: `recipe_id` FIRST, normalized-name fallback.** The id bridge
   is primary because it is the only stable key. The name fallback exists
   for rows whose id does not resolve — dietary-restriction re-authoring
   (ADR-0056's profile axis) and catalog drift re-author recipe names —
   matching on the same normalization the catalog already uses. Every row
   resolves to exactly one of: matched-by-id, matched-by-name, or MISSING,
   and the import reports all three counts. Rows are never silently
   dropped, and a miss is never guessed into a wrong recipe.
4. **Landing zone: the ADR-0031 favourites records — FULL OVERRIDE.** The
   import REPLACES the favourited set: after a successful import the set
   is EXACTLY the payload. Every payload id is starred at a FRESH stamp
   (the import is a new opinion; an already-starred id is re-stamped,
   never left with its old record), and every currently-starred id NOT in
   the payload is un-starred via a FRESH tombstone — never a silent
   delete, and never a silent wipe. The tombstones are load-bearing:
   household peers reconcile PER KEY and an absent key means "don't
   touch" (ADR-0031), so a plain wipe (`replaceAll`) would remove the
   recipes locally while every other device kept them forever. Fresh
   tombstones at a newer stamp propagate through ordinary room sync.
   This includes the first-run Mealime seed
   (`favourited_feasible_variants`) and any local stars: only the
   imported set remains. Records that are already tombstones stay
   untouched (re-tombstoning adds no information), and the public set is
   materialized synchronously as with every store write. No new store
   slice; nothing new in `STORE_SLICES`. One boundary: the override
   replaces the set with the RESOLVED payload — a payload where NOTHING
   matched is a match-layer failure, not a user opinion (matching never
   guesses, point 3), so an all-miss import does not touch the set at
   all; the favourites stay intact and the misses are reported. An empty
   or wholly-malformed payload is refused by validation before any of
   this is reached, so the set can never be emptied by accident.
5. The thumbnail-folder-equals-`recipe_id` identity is measured on one
   account and one pull. The importer therefore keeps the name fallback
   armed for id misses and counts both bridges in its report, rather than
   trusting the identity blindly.

## Consequences

- The flow only works until Mealime's shutdown deletes the accounts
  (2026-10-21). The Settings entry should say so.
- Ratings are NOT in `get_builder_data` (`get_user.recipe_ratings` is, keyed
  by the same stable `recipe_id`): a ratings import is a deliberate v2 of
  the bookmarklet/paste pair, not part of this decision.
- Cooked-history import is feasible later through the same bridge (no dates
  in `get_builder_data`'s history; `get_user` would be needed for timed
  entries).
- The bookmarklet is throwaway-by-design code living behind a link; it is
  still reviewed like any other shipped snippet (it holds no secrets — the
  `client_id` is the public web-client id from Mealime's own bundle).
- No catalog artifact changes; `data:*` gates are untouched.

## Alternatives considered

- **A full token-extraction guide** (user digs `auth_token` out of devtools
  and pastes the raw token): works, but the token is a live account
  credential that then transits our app/infrastructure, and the browser
  cannot call `api.mealime.com` from flambette.app (no CORS grant) without
  us standing up a proxy. Rejected on trust and liability for every user,
  under deadline pressure.
- **Log-in-with-Mealime** (email + password form): easiest UX, worst
  trade-off — we would handle other people's passwords and eat every
  captcha/2FA breakage. Rejected outright.
- **Official export**: does not exist (no export path post-acquisition).
- **Baking Mealime variant ids into the catalog** to match imports: impossible —
  variant ids are re-issued per API call (0/2759 overlap measured live); there
  is no stable id space to bake. `recipe_id` already provides the stable bridge.
