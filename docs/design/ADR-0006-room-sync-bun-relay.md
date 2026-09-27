# ADR-0006: Live room sync over a zero-dep Bun relay

- **Status:** accepted
- **Date:** 2026-09-23 (node/ws model) — revised 2026-09-27 (Bun)
- **Decides:** the realtime-sync architecture and server runtime

## Context

Checklist state, plan edits and (later) cleared ingredients must sync
between household members in real time. No accounts, no persistence
requirement beyond a shopping trip.

## Decision

- **Protocol**: whole-state last-write-wins keyed by a monotonic
  `rev`; 300 ms debounced push; the push watcher runs
  `flush: 'sync'` (async flush caused a push-echo feedback loop).
  Room codes are 4 hex chars, non-secret; rooms expire after 12h
  idle; the relay heartbeats every 30 s.
- **Runtime (revised)**: the relay is a **single-file, zero-dependency
  Bun program** (`server/relay.mjs` on `Bun.serve` native WebSocket),
  containerized on `oven/bun:1-alpine`. The previous node + `ws`
  implementation was replaced during the phase-8 image-size work:
  244→131 MB uncompressed (−46%), 59→40 MB compressed.

## Consequences

- Relay state is in memory; a relay restart empties rooms (users
  rejoin by link) — accepted for this product.
- `flush: 'sync'` on any new room-payload watcher is mandatory, not
  stylistic.
- Wire protocol must stay backward-tolerant: new payload fields must
  be optional + default-applied on receive (the `cleared` field set
  this precedent; old peers ignore it, new peers default it to `{}`).

## Alternatives considered

- **node:x-alpine + `ws`** — superseded: two× the image size plus a
  dependency surface.
- **Yjs/CRDT** — rejected: LWW-on-whole-state fits the data (small,
  single-editor-at-a-time in practice) without a new dep class.
