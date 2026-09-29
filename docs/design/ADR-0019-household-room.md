# ADR-0019: A persistent household room replaces share-links as the default flow

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0006 (live rooms over the relay), ADR-0013/ADR-0016
(`STORE_SLICES` registry, Settings tab). The room protocol, the shared
state and the relay are unchanged — only how a device *gets into* a room
by default.

## Context

Live-room sync already existed (ADR-0006): a device creates or joins a
room by code, and plan edits, grocery checkmarks, extras and cleared
ingredients are pushed whole-state, last-write-wins by `rev`. What was
missing was **persistence of the join**. The daily flow for a two-phone
household was "open the link the other phone sent", every time — and
after a relay restart the room is gone, so the link silently dead-ends
on "Room not found".

The owner and their partner plan and shop on two phones. A share link is
a *transfer* mechanism; it is the wrong tool for a standing arrangement.

## Decision

1. **`householdRoom` is a persisted ui setting** — a room code
   (`/^[A-Z0-9]{4,12}$/`, normalized to upper case) stored in the ui
   store slice and exported/imported through the `settings.json`
   `STORE_SLICES` entry (same-change rule, ADR-0013).

2. **The app auto-joins it on every start.** Once the config has loaded,
   `App.vue` re-joins the saved room unless the launch is already in a
   room (a session resume from `sessionStorage` wins, and so does an
   explicit `?room=CODE` link — an explicit request always beats the
   default). A successful join toasts `Household sync active — CODE`
   (`kind: 'household'`, i.e. `data-test="household-toast"`).

3. **Failure is never fatal.** A watcher on the room store's
   `status`/`error` toasts `Household sync unavailable — <reason>. Will
   retry next launch.`. Nothing is blocked, nothing is cleared, the app
   works fully offline as a single-device app, and the next start tries
   again. The saved code is deliberately *not* deleted on a failed join:
   the usual cause is a relay restart, not a bad code, and the code is
   still the right one afterwards.

4. **Settings hosts the surface** (ADR-0016): a "Household sync" card
   above Backup & restore with a code field, `Save` (persist for the
   next launch), `Join now` (persist and connect immediately), a
   `Turn off` action, and — when the device is in a room the setting
   doesn't match — "Sync with live room CODE", which adopts the current
   room. A code the setting rejects never reaches the store.

5. **The room stays ephemeral on the relay** (12h idle). Nothing here
   adds persistence server-side: a restart of the relay empties it, and
   the user is told to re-create the room (the Plan tab's `start-room`,
   or `Join now` with a fresh code from the other phone). That is the
   documented trade-off: the *device* remembers the room, the *relay*
   holds its state.

## Alternatives considered

- **Auto-create a room when the code is missing** (i.e. a device that
  has never been told about a room mints one). Rejected: two devices
  starting cold would mint two different rooms and silently never meet.
  The setting must be typed or adopted once, explicitly.
- **Persisting room state in the backup zip only.** Already true, and
  not enough: a restore is a manual, whole-data operation. Auto-join is
  the daily path.
- **Keeping share-links as the primary flow.** Kept as the *escape
  hatch* (guest device, one-off share) — just no longer the default.

## Consequences

- Two phones converge with zero per-day interaction, and a reload (or a
  crash, or a browser restart) re-establishes the room on its own.
- A stale or wrong code produces one dismissible toast and a fully
  usable app — the failure mode is "sync is off", never "app is
  broken".
- `householdRoom` participates in the ADR-0013 registry coverage
  assertion, so a future slice change cannot silently drop it.
- The relay is still the only network dependency and remains
  zero-storage; the household room adds no server-side state.
