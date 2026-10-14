/**
 * The runtime mirror of the `SharedState` key set — the payload keys that
 * ride the room relay (ADR-0088 §6).
 *
 * A TypeScript interface vanishes at runtime, and `server/` is outside the
 * client's import graph (types are mirrored, never imported live), so the
 * agreement the ADR demands between the relay's `SYNCED_STORES` and the
 * client's payload keys needs a runtime artifact on THIS side too. It is
 * kept next to the interface it mirrors and verified against it at BUILD
 * time by the assertion in `src/stores/room.ts` (both directions, so a key
 * added to either side without the other fails `bun run build`), and
 * against `SYNCED_STORES` at TEST time by the relay-core cross-check —
 * the chain has no unguarded link.
 *
 * Pure data, no imports: it is loaded by the browser bundle, the relay
 * image (which copies all of `src/lib/`, ADR-0025) and the worker bundle
 * alike.
 */

/** The `SharedState` keys, in the order the interface declares them. */
export const SHARED_STATE_KEYS = [
  'plan',
  'customItems',
  'checked',
  'cleared',
  'customs',
  'cookedHistory',
  'filters',
  'favorites',
  'ratings',
  'ratingTombstones',
  'planIdentity',
] as const

export type SharedStateKey = (typeof SHARED_STATE_KEYS)[number]
