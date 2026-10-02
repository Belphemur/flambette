/**
 * Room-code canonicalisation and legacy minting — ONE implementation for
 * every relay and for the client (ADR-0040, ADR-0021).
 *
 * Canonicalisation is IMPORTED from `src/lib/roomWords` rather than
 * re-declared, because the client and the relay must agree byte for byte
 * on which string a room is keyed by: if they disagree, a household
 * splits into two rooms that both look alive. Importing is the lockstep.
 *
 * This replaces the hand-maintained `normalizeCode` copy that used to live
 * in the Bun relay's `roomLifecycle.mjs` — a second implementation free to
 * drift, which had already fallen behind: the client also accepts the
 * run-together spelling (`amberfalconlantern`) and the Bun copy did not.
 *
 * Nothing else in `server/` imports from `src/`: the Bun relay ships in a
 * container that only contains its own runtime surface, so the dependency
 * runs client-lib → relay, never the other way round.
 */

import { WORD_ROOM_CODE_RE, normalizeRoomCode } from '../../src/lib/roomWords'
import { CODE_ALPHABET, CODE_LENGTH } from './policy'

export { normalizeRoomCode, WORD_ROOM_CODE_RE as WORD_CODE_RE }

/**
 * The relay's TOTAL entry point for an untrusted code: `join`/`create`
 * arrive as parsed JSON, so `code` can be a number, an object or nothing
 * at all, and the client-typed helper takes a `string`.
 *
 * Canonicalisation used to live in the relay, where it opened with a
 * `typeof` guard for exactly this reason; the guard has to live here now,
 * because "canonicalise, or refuse" is a relay decision and a missing code
 * must be a refusal rather than an exception thrown inside a socket
 * handler.
 */
export function canonicalizeCode(raw: unknown): string {
  return typeof raw === 'string' ? normalizeRoomCode(raw) : ''
}

/**
 * One uniformly-random index into [0, len) from `crypto.getRandomValues`.
 *
 * Modulo alone would bias the low indices whenever `len` does not divide
 * 256, so bytes at or above the largest whole multiple are rejected and
 * redrawn — the same rejection sampling the client's `generateRoomCode`
 * uses. Termination is all but certain: for the 28-character alphabet,
 * 3 bytes in 224 are rejected.
 */
function randomIndex(len: number): number {
  const byte = new Uint8Array(1)
  const ceiling = Math.floor(256 / len) * len
  for (;;) {
    crypto.getRandomValues(byte)
    if (byte[0] < ceiling) return byte[0] % len
  }
}

/**
 * Mint a legacy room code. Only a `create` that arrived without a code
 * gets one (ADR-0038 §3): word codes are rolled client-side so the user
 * can read them before joining, and this shape only exists to keep a
 * hand-typed or link-less create working.
 *
 * A collision with a live room is not detected here: it surfaces as
 * `code_taken` and the client re-rolls, which ADR-0021 calls the expected
 * path rather than an error.
 */
export function mintLegacyCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomIndex(CODE_ALPHABET.length)]
  return code
}