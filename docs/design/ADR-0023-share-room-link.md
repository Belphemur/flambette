# ADR-0023: One-tap "Share room" copies the join link

**Status:** Accepted (2026-09-28)
**Extends:** ADR-0004 (`?room=` deep links), ADR-0006 (rooms), ADR-0019
(household room). No protocol, store or relay change.

## Context

Sharing a room used to mean finding the link: open the Plan tab, open
the share sheet, look at a readonly input, select the text, copy. The
household flow made that mostly unnecessary on the *second* phone
(ADR-0019 auto-joins a saved code), but it is still the path for a guest
device, a fresh phone, or "here, type this in".

The action people actually want is a single gesture that puts the join
link on the clipboard.

## Decision

1. **One tap → clipboard, nothing else.** `useShareRoomLink()`
   (`src/composables/useShareRoomLink.ts`) copies
   `${origin}${BASE_URL}plan?room=<code>` and toasts
   `Copied! Anyone with this link joins your household.` No picker
   dialog, no second step.

2. **No `navigator.share`.** The app is frequently served from a
   plain-HTTP LAN origin, where Web Share does not exist (AGENTS.md
   pitfall). Clipboard is the sanctioned path, through
   `useClipboard({ legacy: true })` — the same one the Plan share link
   already uses — which falls back to `document.execCommand('copy')`.

3. **Two surfaces, one implementation.** A `🔗 Share room link` button on
   the Settings household card, and a `Share link` action on the toasts
   that confirm joining (the auto-join toast in `App.vue` and the
   "Joining household …" toast in Settings). Both call the same
   composable, so the two surfaces cannot drift.

4. **The link is built for a code, not for "the room".**
   `room.roomLinkFor(code)` works for a room this device has not joined
   yet, so the saved `householdRoom` setting is shareable even before
   the relay has re-created the room after a restart.

5. **Never a silent failure.** `useClipboard` reports `copied` even when
   its legacy write silently failed, so a successful-looking toast could
   be a lie. After writing, the composable reads the clipboard back where
   the origin permits it and reports failure on a mismatch. On failure
   the toast carries the link itself (`Couldn't copy automatically — the
   link is <url>`), so the user can still copy it by hand. An
   *unreadable* clipboard is not treated as a failure.

6. **With nothing to share, the button is disabled** rather than
   producing an empty link; calling the composable directly still toasts
   an explanatory message.

## Alternatives considered

- **A share sheet with a QR code / native share.** Rejected for now: the
  ask is one tap to the clipboard, and a native share sheet is
  unavailable on the app's most common deployment (plain-HTTP LAN).
- **Put the link in the room chip's title (already there).** Rejected as
  the only affordance: reading a title attribute is not a tap.
- **Trust `copied` alone.** Rejected: it is set unconditionally on the
  legacy path, which is exactly the path LAN origins use.

## Consequences

- Sharing is one tap from Settings or straight off the join
  confirmation; the share sheet is no longer the path.
- The composable owns clipboard feedback, so future share surfaces (a
  QR sheet, a room menu) reuse it instead of re-implementing copy.
- Read-back verification costs one `readText()` on origins that allow
  it; where it is unavailable the write's own verdict stands.
