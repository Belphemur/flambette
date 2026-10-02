/**
 * The relay's typed seam: code canonicalisation, legacy code minting and
 * the error codes, shared by the Durable Object and the worker entry.
 *
 * Canonicalisation is IMPORTED from src/lib/roomWords.ts rather than
 * re-declared, because the client and the relay must agree byte for byte
 * on which string a room is keyed by: if they disagree, a household
 * splits into two rooms that both look alive. Importing is the lockstep —
 * a hand-copied `normalizeCode` here would be a second implementation
 * free to drift, which is exactly the failure this file prevents.
 *
 * Nothing else in server/ imports from src/: the Bun relay ships in a
 * container that only contains *.mjs, so the dependency runs client-lib →
 * relay, never the other way round.
 */

import { normalizeRoomCode } from '../../src/lib/roomWords'
import { CODE_ALPHABET, CODE_LENGTH } from '../relayPolicy.mjs'

export { normalizeRoomCode }

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

/** The `error` payloads the relay can emit (mirrors server/relay.mjs). */
export const RELAY_ERRORS = {
  codeTaken: 'code_taken',
  notFound: 'not_found',
  roomExpired: 'room_expired',
  rateLimited: 'rate_limited',
  badState: 'bad_state',
  badJson: 'bad_json',
  notInRoom: 'not_in_room',
  unknownType: 'unknown_type',
} as const
