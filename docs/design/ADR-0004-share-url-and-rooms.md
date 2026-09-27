# ADR-0004: Share via URL deep-link (`?p=`), rooms for interactive sync

- **Status:** accepted (share URL 2026-09-23; superseded-in-part by
  ADR-0006 room model same day)
- **Decides:** how plans travel between users

## Context

Users plan meals together. Options: a backend with accounts, or
stateless sharing.

## Decision

Two layers, both auth-free:

1. **One-shot URL share** (`src/lib/share.ts`): the plan is encoded as
   gzip(JSON `{e: entries, c: customItems}`) → base64url in
   `/plan?p=…`, capped at 1800 chars (oversized plans should be shared
   as rooms). v1 bare-array payloads still decode (back-compat).
   Import happens in `App.vue` on mount; the param is stripped after.
2. **Live rooms** (ADR-0006): `?room=CODE` joins a relay room;
   checkbox state, plan edits, custom items and cleared ingredients
   sync live; cooked history stays personal.

## Consequences

- No PII, no auth, no backend persistence beyond the in-memory relay.
- 1800-char cap is a URL-length practicality (browsers, proxies) —
  room sharing is the documented overflow path.

## Alternatives considered

- **Accounts + server plans** — rejected: out of scope for an offline
  static SPA.
- **Chunked URLs for big plans** — rejected: fragile across chat apps.
