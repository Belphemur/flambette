/**
 * Real Web Push over WebCrypto — the ZERO-DEPENDENCY implementation the
 * shared core uses (ADR-0102, ADR-0040: the relay core stays dependency-
 * free, and `web-push` npm cannot even run on workerd, so one hand-rolled
 * implementation is also the only shared one — DRY by construction).
 *
 * Three pieces, each pinned by the core specs:
 *
 * 1. **VAPID JWT** (RFC 8292): an ES256 (ECDSA P-256/SHA-256) JSON Web
 *    Token over `{aud: <endpoint origin>, sub, exp}`, signed with the
 *    deployment's VAPID private key; the Authorization header carries
 *    `vapid t=<jwt>, k=<public key base64url>`.
 * 2. **Payload encryption** (RFC 8291, aes128gcm content encoding — RFC
 *    8188): an ephemeral ECDH P-256 key agrees a shared secret with the
 *    subscription's `p256dh` receiver key; HKDF mixes it with the
 *    subscription's `auth` secret into a CEK + nonce; the plaintext
 *    carries the RFC 8188 padding delimiter (0x02).
 * 3. **The send**: `fetch(endpoint, { method: 'POST', ... })` with the
 *    encrypted body and the TTL/Content-Encoding headers. The HTTP status
 *    is the caller's whole answer — 201 sent, 410/404 dead subscription,
 *    anything else best-effort failure.
 *
 * WebCrypto is the chosen primitive surface because BOTH runtimes have it
 * built in: Bun exposes `crypto.subtle` and workerd mandates it. No key
 * material ever leaves the runtime; no bignum library is needed — the
 * curves are handled inside the platform's EC implementations.
 *
 * TYPING NOTE: the two runtimes' type declarations spell the subtle API's
 * arguments differently (workerd's experimental types rename some fields,
 * the Node typings carry DOM-spelled overload unions), and this core
 * type-checks under BOTH projects (`server/tsconfig.json` and
 * `server/tsconfig.relay.json`) without either lib. The module therefore
 * speaks to the platform through ONE structural facade (`SubtleLike`)
 * cast once at module load — the same honesty the adapters apply to
 * `Bun.serve`: declare structurally, never drag a lib in. Every cast in
 * this file is a compile-time spelling problem, never a runtime one: the
 * platform receives exactly the values it always did.
 */

/** Base64url without padding — the encoding every push key and JWT part uses. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * The ONE byte-cast at the WebCrypto boundary: our helpers pass
 * `Uint8Array`s, the platform's subtle API wants its own buffer spelling
 * (a view whose buffer slot the two runtime type libs disagree about).
 * `slice` materialises a standalone ArrayBuffer — a copy, but of bytes
 * measured in hundreds, per send.
 */
function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

/** The platform's opaque key object — we never introspect it. */
interface SubtleKey {
  /* A marker-less stand-in: structurally anything, used only in signatures. */
  readonly _subtleKey: unique symbol
}

/** A JWK-shaped object, as the platform's `importKey('jwk', ...)` wants it. */
interface JwkObject {
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
  [field: string]: unknown
}

/**
 * The slice of WebCrypto this module needs, spelled structurally so it
 * type-checks on Bun AND workerd without either runtime's lib. Cast once:
 * `crypto.subtle` is assigned, then every call below is OUR spelling.
 */
interface SubtleLike {
  importKey(
    format: 'jwk' | 'raw',
    keyData: JwkObject | ArrayBuffer,
    algorithm: { name: string; namedCurve?: string; hash?: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<SubtleKey>
  generateKey(
    algorithm: { name: string; namedCurve: string },
    extractable: false,
    keyUsages: string[],
  ): Promise<{ publicKey: SubtleKey; privateKey: SubtleKey }>
  exportKey(format: 'raw', key: SubtleKey): Promise<ArrayBuffer>
  deriveBits(
    algorithm:
      | { name: 'ECDH'; public: SubtleKey }
      | { name: 'HKDF'; hash: string; salt: ArrayBuffer; info: ArrayBuffer },
    key: SubtleKey,
    length: number,
  ): Promise<ArrayBuffer>
  sign(algorithm: { name: string; hash: string }, key: SubtleKey, data: ArrayBuffer): Promise<ArrayBuffer>
  encrypt(
    algorithm: { name: string; iv: ArrayBuffer },
    key: SubtleKey,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>
}

const subtle = crypto.subtle as unknown as SubtleLike

/** A VAPID keypair, in the `web-push generate-vapid-keys` shapes. */
export interface VapidKeys {
  /** 65-byte uncompressed point, base64url (the `k=` in Authorization). */
  publicKey: string
  /** 32-byte private scalar, base64url. */
  privateKey: string
}

export interface VapidConfig extends VapidKeys {
  /** `mailto:` contact (RFC 8292 §5) — optional, sent when present. */
  subject?: string
}

/* ------------------------------------------------------------------ JWT */

/** The JWK the ECDSA importKey needs, parsed out of the two base64url strings. */
function vapidJwk(keys: VapidKeys): {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  d: string
} {
  const point = b64urlDecode(keys.publicKey)
  // 0x04 prefix (uncompressed point) || X(32) || Y(32). Anything else is
  // not a key this runtime generated or was configured with.
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point')
  }
  const scalar = b64urlDecode(keys.privateKey)
  if (scalar.length !== 32) {
    throw new Error('VAPID private key must be a 32-byte P-256 scalar')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(point.slice(1, 33)),
    y: b64urlEncode(point.slice(33, 65)),
    d: b64urlEncode(scalar),
  }
}

/**
 * Sign a VAPID JWT for ONE audience (an endpoint's origin, RFC 8292 §3).
 * `exp` is now + 12h (the RFC's own example horizon; tokens are minted per
 * send and never cached, so a short claim needs no revocation story).
 * `now` is a MILLISECOND timestamp (Date.now()'s unit, what every caller
 * passes); `exp` is a Unix-SECONDS claim, so the conversion happens here —
 * the two units must never be added raw.
 */
export async function signVapidJwt(
  keys: VapidKeys,
  audience: string,
  subject: string | undefined,
  now: number,
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload: Record<string, unknown> = {
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
  }
  if (subject) payload.sub = subject
  const signingInput =
    b64urlEncode(utf8(JSON.stringify(header))) + '.' + b64urlEncode(utf8(JSON.stringify(payload)))
  const key = await subtle.importKey(
    'jwk',
    vapidJwk(keys),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(utf8(signingInput))),
  )
  // ES256 signatures are the raw r||s pair in WebCrypto — exactly the JWS
  // P-256 encoding (RFC 7518 §3.4), so the bytes attach directly.
  return signingInput + '.' + b64urlEncode(signature)
}

/* ------------------------------------------------------- payload crypto */

/** One HKDF step over the platform's HKDF: salt + IKM -> `length` bytes of `info`. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', bytes(ikm), { name: 'HKDF' }, false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Encrypt ONE push payload for ONE subscription (RFC 8291 + RFC 8188
 * aes128gcm). Returns the body bytes whose header embeds the ephemeral
 * public key, so the push service needs nothing but the body.
 */
export async function encryptAes128Gcm(
  userPublicKeyB64u: string,
  userAuthB64u: string,
  payload: string,
): Promise<Uint8Array> {
  const userPub = b64urlDecode(userPublicKeyB64u)
  if (userPub.length !== 65 || userPub[0] !== 4) {
    throw new Error('subscription p256dh must be a 65-byte uncompressed P-256 point')
  }
  const auth = b64urlDecode(userAuthB64u)
  if (auth.length < 16) throw new Error('subscription auth secret too short')

  // The ephemeral sender keypair — fresh per send, per RFC 8291 §3.1.
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])
  const ephPubBytes = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey))
  const sharedSecret = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'ECDH',
        public: await subtle.importKey(
          'raw',
          bytes(userPub),
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          [],
        ),
      },
      ephemeral.privateKey,
      256,
    ),
  )

  // IKM: HKDF(auth-salt, ECDH secret, "WebPush: info" || NUL || userPub || ephPub).
  const ikm = await hkdf(
    auth,
    sharedSecret,
    concat(utf8('WebPush: info'), new Uint8Array([0]), userPub, ephPubBytes),
    32,
  )
  // Fresh salt per send, same lifetime as the ephemeral key.
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16)
  const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12)

  // RFC 8188 §2: the plaintext ends with the 0x02 padding delimiter (the
  // older draft's two-byte length prefix is NOT this scheme).
  const plaintext = concat(utf8(payload), new Uint8Array([2]))

  const aesKey = await subtle.importKey('raw', bytes(cek), { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: bytes(nonce) }, aesKey, bytes(plaintext)),
  )

  // The aes128gcm header (RFC 8188 §2.2): salt(16) || rs(4, big-endian) ||
  // idlen(1) || keyid. The keyid IS the ephemeral public key (as_keyid).
  const RECORD_SIZE = 4096
  const header = concat(
    salt,
    new Uint8Array([
      (RECORD_SIZE >>> 24) & 0xff,
      (RECORD_SIZE >>> 16) & 0xff,
      (RECORD_SIZE >>> 8) & 0xff,
      RECORD_SIZE & 0xff,
    ]),
    new Uint8Array([ephPubBytes.length]),
    ephPubBytes,
  )
  return concat(header, ciphertext)
}

/* ---------------------------------------------------------------- send */

/** The whole result of one send attempt: nothing thrown but transport death. */
export interface PushSendResult {
  /** 201 = delivered. 410/404 = the subscription is dead — prune it. */
  status: number
  ok: boolean
  /** True when the push service itself said the subscription is gone. */
  gone: boolean
}

/**
 * Send one encrypted push to one endpoint. `fetchImpl` is injectable (the
 * specs use a stub; both runtimes supply the platform fetch). Network
 * failures THROW — the fan-out layer catches and moves on (best-effort),
 * so this function's contract stays "the push service's answer".
 */
export async function sendWebPush(
  endpoint: string,
  subscription: { p256dh: string; auth: string },
  payload: string,
  vapid: VapidConfig,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  const audience = new URL(endpoint).origin
  const jwt = await signVapidJwt(vapid, audience, vapid.subject, now)
  const body = await encryptAes128Gcm(subscription.p256dh, subscription.auth, payload)
  const res = await fetchImpl(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // One hour of push-service-side storage: a phone that is briefly
        // offline still sees the news. NOT a relay-side queue (the ADR
        // has none) — the push service's own retention window.
        TTL: '3600',
      },
      body: bytes(body),
      // A redirect would carry the VAPID-signed POST off the validated
      // push service — the destination is confined to what registration
      // allowed, so a redirect is refused, not followed.
      redirect: 'error',
    } as unknown as RequestInit,
  )
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    gone: res.status === 410 || res.status === 404,
  }
}
