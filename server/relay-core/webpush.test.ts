/**
 * The Web Push crypto core (ADR-0102): the VAPID JWT verifies against the
 * public key it claims, and the aes128gcm envelope decrypts back with the
 * RFC 8291 key schedule. Both runtimes' crypto is the platform's own
 * WebCrypto, so these specs run the real primitives — the tests REVERSE
 * the envelope with an independent decrypt path built only from the spec's
 * definitions (HKDF labels, key agreement), never the implementation's
 * internals, so a wrong label or wrong header layout fails loudly.
 */

import { describe, expect, test } from 'bun:test'
import {
  b64urlDecode,
  b64urlEncode,
  encryptAes128Gcm,
  signVapidJwt,
  sendWebPush,
  type VapidConfig,
} from './webpush'

/**
 * A REAL VAPID pair, minted the way `web-push generate-vapid-keys` would
 * produce it: the private scalar from the PKCS#8 export (d = the last 32
 * bytes of the P-256 structure), the public key as the 65-byte uncompressed
 * point — the shapes every deployment config carries.
 */
async function generateVapidKeys(): Promise<VapidConfig> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  // The PKCS#8 DER's trailing bytes are NOT reliably the raw scalar (an
  // INTEGER's leading-zero padding shifts the slice), so the private key's
  // own JWK export is the ground truth — the exact base64url d the
  // generator shape carries.
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return {
    publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: String((jwk as { d?: string }).d),
  }
}

const VAPID: VapidConfig = await generateVapidKeys()

/* The receiver side of a subscription — a fresh P-256 pair per suite. */
const userKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
]) as CryptoKeyPair
const USER_PUB_B64U = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', userKeys.publicKey)))
const USER_PUB_BYTES = b64urlDecode(USER_PUB_B64U)
const USER_AUTH = crypto.getRandomValues(new Uint8Array(16))
const USER_AUTH_B64U = b64urlEncode(USER_AUTH)

/* Derive x/y from the 65-byte point for the JWK import the verify test needs. */
const vapidPoint = b64urlDecode(VAPID.publicKey)
expect(vapidPoint.length).toBe(65)
expect(vapidPoint[0]).toBe(4)

async function verifyKey(): Promise<CryptoKey> {
  return (await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(vapidPoint.slice(1, 33)),
      y: b64urlEncode(vapidPoint.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
    false,
    ['verify'],
  )) as CryptoKey
}

describe('signVapidJwt (RFC 8292)', () => {
  test('the token verifies against its own public key', async () => {
    // `now` is MILLISECONDS (what every caller passes — Date.now()'s
    // unit); `exp` must be the Unix-SECONDS conversion + 12h, NOT the
    // raw addition that would land far past the push services' 24h cap.
    const now = 1_700_000_000_123
    const token = await signVapidJwt(VAPID, 'https://push.example', 'mailto:test@example.com', now)
    const [headerB64, payloadB64, signatureB64] = token.split('.')
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64))) as Record<string, unknown>
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as Record<string, unknown>
    expect(header.typ).toBe('JWT')
    expect(header.alg).toBe('ES256')
    expect(payload.aud).toBe('https://push.example')
    expect(payload.sub).toBe('mailto:test@example.com')
    expect(payload.exp).toBe(Math.floor(now / 1000) + 12 * 60 * 60)
    // The claim the push services actually enforce: expiry within 24h of
    // the token's mintage (in Unix seconds).
    expect(Math.floor(now / 1000) - payload.exp).toBeLessThanOrEqual(24 * 60 * 60)
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await verifyKey(),
      b64urlDecode(signatureB64!) as unknown as BufferSource,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`) as unknown as BufferSource,
    )
    expect(verified).toBe(true)
  })

  test('a tampered payload does not verify', async () => {
    const token = await signVapidJwt(VAPID, 'https://push.example', undefined, 0)
    const [h, p, s] = token.split('.')
    const other = JSON.parse(new TextDecoder().decode(b64urlDecode(p!))) as Record<string, unknown>
    other.aud = 'https://attacker.example'
    const forgedPayload = b64urlEncode(new TextEncoder().encode(JSON.stringify(other)))
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await verifyKey(),
      b64urlDecode(s!) as unknown as BufferSource,
      new TextEncoder().encode(`${h}.${forgedPayload}`) as unknown as BufferSource,
    )
    expect(verified).toBe(false)
  })

  test('subject is optional (RFC 8292 §5: sub SHOULD, not MUST)', async () => {
    const token = await signVapidJwt(VAPID, 'https://push.example', undefined, 0)
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(token.split('.')[1]!))) as Record<string, unknown>
    expect(payload.sub).toBeUndefined()
  })

  test('malformed keys are refused with a clear error', async () => {
    await expect(
      signVapidJwt(
        { publicKey: b64urlEncode(new Uint8Array(64)), privateKey: VAPID.privateKey },
        'https://a',
        undefined,
        0,
      ),
    ).rejects.toThrow('VAPID public key')
    await expect(
      signVapidJwt(
        { publicKey: VAPID.publicKey, privateKey: b64urlEncode(new Uint8Array(31)) },
        'https://a',
        undefined,
        0,
      ),
    ).rejects.toThrow('VAPID private key')
  })
})

/* ---------------------------------------------------- RFC 8291 reversal */

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as unknown as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
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

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('encryptAes128Gcm (RFC 8291 + RFC 8188 aes128gcm)', () => {
  test('the envelope decrypts back with the receiver-side key schedule', async () => {
    const payload = JSON.stringify({ title: 'Meal plan started', body: 'x'.repeat(500) })
    const body = await encryptAes128Gcm(USER_PUB_B64U, USER_AUTH_B64U, payload)

    /* Header layout (RFC 8188 §2.2): salt(16) || rs(4 BE) || idlen(1) || keyid(65). */
    const salt = body.slice(0, 16)
    const rs =
      (body[16]! << 24) | (body[17]! << 16) | (body[18]! << 8) | body[19]!
    expect(rs).toBe(4096)
    const idlen = body[20]!
    expect(idlen).toBe(65)
    const ephPub = body.slice(21, 21 + idlen)
    expect(ephPub[0]).toBe(4)
    expect(body.length).toBe(21 + idlen + 16 + Math.min(payload.length + 1, rs))

    /* Reverse the RFC 8291 key schedule, independently of the implementation. */
    const ephUserSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'ECDH',
          public: await crypto.subtle.importKey(
            'raw',
            ephPub as unknown as BufferSource,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
          ),
        },
        userKeys.privateKey,
        256,
      ),
    )
    const ikm = await hkdf(
      USER_AUTH,
      ephUserSecret,
      concat(utf8('WebPush: info'), new Uint8Array([0]), USER_PUB_BYTES, ephPub),
      32,
    )
    const cek = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16)
    const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12)

    const aesKey = await crypto.subtle.importKey('raw', cek as unknown as BufferSource, 'AES-GCM', false, [
      'decrypt',
    ])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
      aesKey,
      body.slice(21 + idlen) as unknown as BufferSource,
    )
    const plaintextBytes = new Uint8Array(plaintext)
    // RFC 8188: the plaintext ends with the 0x02 padding delimiter.
    expect(plaintextBytes[plaintextBytes.length - 1]).toBe(2)
    const content = new TextDecoder().decode(plaintextBytes.slice(0, plaintextBytes.length - 1))
    expect(content).toBe(payload)
  })

  test('each envelope is fresh: two sends differ in salt and ephemeral key', async () => {
    const a = await encryptAes128Gcm(USER_PUB_B64U, USER_AUTH_B64U, 'hello')
    const b = await encryptAes128Gcm(USER_PUB_B64U, USER_AUTH_B64U, 'hello')
    expect([...a.slice(0, 16)]).not.toEqual([...b.slice(0, 16)])
    expect([...a.slice(21, 21 + 65)]).not.toEqual([...b.slice(21, 21 + 65)])
  })

  test('a non-point p256dh is refused', async () => {
    await expect(encryptAes128Gcm(b64urlEncode(new Uint8Array(64)), USER_AUTH_B64U, 'x')).rejects.toThrow(
      'p256dh',
    )
    await expect(encryptAes128Gcm(USER_PUB_B64U, b64urlEncode(new Uint8Array(8)), 'x')).rejects.toThrow('auth')
  })
})

describe('sendWebPush', () => {
  test('sends the encrypted body with the VAPID + content-encoding headers and reports the status', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const impl = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    const result = await sendWebPush(
      'https://push.example/send/abc',
      { p256dh: USER_PUB_B64U, auth: USER_AUTH_B64U },
      '{"title":"t"}',
      VAPID,
      0,
      impl,
    )
    expect(result.status).toBe(201)
    expect(result.ok).toBe(true)
    expect(result.gone).toBe(false)
    expect(seen[0]!.url).toBe('https://push.example/send/abc')
    const headers = seen[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization.startsWith('vapid t=')).toBe(true)
    // `k=` is the configured public key, verbatim.
    expect(headers.Authorization).toContain(`k=${VAPID.publicKey}`)
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    // The body is the envelope the encryptor produced.
    const body = new Uint8Array(seen[0]!.init!.body as ArrayBuffer)
    expect(body.length).toBeGreaterThan(21 + 65)
  })

  test('410 Gone and 404 are reported as `gone`, other statuses are not', async () => {
    for (const [status, gone] of [
      [410, true],
      [404, true],
      [201, false],
      [500, false],
    ] as const) {
      const impl = (async () => new Response(null, { status })) as unknown as typeof fetch
      const result = await sendWebPush(
        'https://push.example/x',
        { p256dh: USER_PUB_B64U, auth: USER_AUTH_B64U },
        '{}',
        VAPID,
        0,
        impl,
      )
      expect(result.gone).toBe(gone)
      expect(result.status).toBe(status)
    }
  })
})
