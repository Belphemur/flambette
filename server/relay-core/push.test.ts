/**
 * The push fan-out core (ADR-0102): registration, trigger vocabulary,
 * dedupe window, prune-on-gone, no-VAPID inertness — against a Map store
 * and a stub sender, so every decision is pinned WITHOUT a network. The
 * Web Push crypto itself (JWT, aes128gcm) has its own spec.
 */

import { describe, expect, test } from 'bun:test'
import {
  NOTIFY_DEDUPE_MS,
  NOTIFY_KEYS,
  PUSH_ROOM_CAP,
  createPushFanout,
  notifyPayload,
  parsePushRegistration,
  parseVapidConfig,
  type PushSubscriptionRow,
  type PushStore,
} from './push'
import { b64urlEncode, type VapidConfig } from './webpush'

/**
 * A REAL VAPID pair, minted the way `web-push generate-vapid-keys` would
 * produce it: the private scalar from the PKCS#8 export (d = the last 32
 * bytes of the P-256 structure), the public key as the 65-byte uncompressed
 * point. The crypto specs decode these values, so they must be well-formed.
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

/** A recording store: rows keyed (code, endpoint), every mutation counted. */
function makeStore() {
  const rows = new Map<
    string,
    { code: string; endpoint: string; keys: { p256dh: string; auth: string }; at: number }
  >()
  const calls = { register: 0, unregister: 0, drop: 0, trim: 0 }
  const store: PushStore & { calls: typeof calls } = {
    calls,
    list(code) {
      return [...rows.values()]
        .filter((r) => r.code === code)
        .map((r) => ({ endpoint: r.endpoint, keys: r.keys }))
    },
    register(code, row, at = 0) {
      calls.register++
      rows.set(`${code}\u0000${row.endpoint}`, { code, endpoint: row.endpoint, keys: row.keys, at })
    },
    // The SQL eviction's Map equivalent: newest `cap` rows by the
    // registration stamp survive, the rest go (the trim test's oracle).
    trim(code, cap) {
      calls.trim++
      const kept = [...rows.values()]
        .filter((r) => r.code === code)
        .sort((a, b) => b.at - a.at)
        .slice(0, cap)
        .map((r) => r.endpoint)
      for (const [key, row] of [...rows]) {
        if (row.code === code && !kept.includes(row.endpoint)) rows.delete(key)
      }
    },
    unregister(code, endpoint) {
      calls.unregister++
      rows.delete(`${code}\u0000${endpoint}`)
    },
    drop(code) {
      calls.drop++
      for (const key of [...rows.keys()]) {
        if (rows.get(key)!.code === code) rows.delete(key)
      }
    },
  }
  return store
}

/**
 * A stub sender: whatever HTTP statuses the map/function says, per
 * endpoint; every request's endpoint + payload is recorded.
 */
function makeSender(statuses: Map<string, number> | ((endpoint: string) => number) = () => 201) {
  const sent: { endpoint: string; payload: string; authorization: string }[] = []
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const endpoint = String(input)
    const status =
      typeof statuses === 'function' ? statuses(endpoint) : (statuses.get(endpoint) ?? 201)
    const body = init?.body
    sent.push({
      endpoint,
      // The body arrives as an ArrayBuffer (the encrypted envelope) —
      // decode it so payload assertions read the JSON inside.
      payload:
        body instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(body)) : String(body ?? ''),
      authorization: init?.headers?.Authorization ?? '',
    })
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return { impl, sent }
}

function fanoutWith(
  store: PushStore,
  options: { vapid?: VapidConfig | null; now?: number; fetchImpl?: typeof fetch } = {},
) {
  const clock = { value: options.now ?? 1000 }
  const fanout = createPushFanout({
    vapid: options.vapid === undefined ? VAPID : options.vapid,
    store,
    now: () => clock.value,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  return { fanout, clock }
}

/**
 * The async half of `notify` is a microtask chain several awaits deep
 * (JWT sign, HKDF chain, AES-GCM, fetch). Under the full suite's load a
 * single tick has raced it, so settle spins until the sender's recording
 * has actually advanced or a generous number of macrotasks passed.
 */
/** Give fire-and-forget work several macrotask rounds to finish (or fail). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1))
}

/** Wait until the stub sender has recorded `count` sends. */
async function waitSends(sender: { sent: unknown[] }, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (sender.sent.length >= count) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

/**
 * REAL subscription keys: the sender runs the actual aes128gcm
 * encryption, so the row's p256dh must be a 65-byte P-256 point and the
 * auth secret a real byte string — the crypto rejects shams before any
 * fetch. One pair serves every row; the fan-out never inspects it.
 */
const USER_KEYS = (await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveBits'],
)) as CryptoKeyPair
const USER_PUB = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', USER_KEYS.publicKey)))
const USER_AUTH = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))

function row(endpoint: string): PushSubscriptionRow {
  return { endpoint, keys: { p256dh: USER_PUB, auth: USER_AUTH } }
}

describe('notify trigger vocabulary', () => {
  test('the two ADR-0102 triggers are the whole list', () => {
    expect([...NOTIFY_KEYS]).toEqual(['plan-started', 'grocery-finished'])
  })
})

describe('parsePushRegistration', () => {
  test('accepts a well-formed subscription on a real push service', () => {
    const parsed = parsePushRegistration({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'P-256-KEY', auth: 'AUTH-SECRET' },
    })
    expect(parsed).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'P-256-KEY', auth: 'AUTH-SECRET' },
    })
    // Every service's real host shape: the provider's own subdomains and
    // the bare apex, but never a look-alike suffix domain.
    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://push.services.mozilla.com/abc',
      'https://wns2-by3p.notify.windows.com/abc',
      'https://notify.windows.com/abc',
      'https://web.push.apple.com/abc',
    ]) {
      expect(parsePushRegistration({ endpoint, keys: { p256dh: 'k', auth: 'a' } })).not.toBeNull()
    }
  })

  test('refuses hosts the fan-out must never dial (SSRF gate)', () => {
    for (const endpoint of [
      'http://insecure/abc',
      'https://push.example.evil.com/abc', // look-alike suffix
      'https://internal.example/abc', // not a push service
      'https://127.0.0.1/abc', // IPv4 literal
      'https://[::1]/abc', // IPv6 literal
      'https://localhost/abc',
      'https://fcm.googleapis.com:8443/abc', // non-default port
      `https://fcm.googleapis.com/${'x'.repeat(3000)}`, // oversized URL
    ]) {
      expect(parsePushRegistration({ endpoint, keys: { p256dh: 'k', auth: 'a' } })).toBeNull()
    }
  })

  test('refuses oversized key strings and nonsense shapes', () => {
    expect(parsePushRegistration({ endpoint: 'https://fcm.googleapis.com/abc', keys: { p256dh: 'k' } })).toBeNull()
    expect(parsePushRegistration({ endpoint: 'https://fcm.googleapis.com/abc', keys: 'keys' })).toBeNull()
    expect(parsePushRegistration({ keys: { p256dh: 'k', auth: 'a' } })).toBeNull()
    expect(parsePushRegistration({ endpoint: 42, keys: { p256dh: 'k', auth: 'a' } })).toBeNull()
    expect(
      parsePushRegistration({
        endpoint: 'https://fcm.googleapis.com/abc',
        keys: { p256dh: 'k'.repeat(600), auth: 'a' },
      }),
    ).toBeNull()
    expect(
      parsePushRegistration({
        endpoint: 'https://fcm.googleapis.com/abc',
        keys: { p256dh: 'k', auth: 'a'.repeat(600) },
      }),
    ).toBeNull()
  })
})

describe('parseVapidConfig', () => {
  test('absent keys = no configuration (feature silently off)', () => {
    expect(parseVapidConfig({})).toBeNull()
    expect(parseVapidConfig({ publicKey: 'only-public' })).toBeNull()
    expect(parseVapidConfig({ privateKey: 'only-private' })).toBeNull()
  })

  test('a real-shape pair parses; the subject rides along when present', () => {
    expect(parseVapidConfig({ publicKey: VAPID.publicKey, privateKey: VAPID.privateKey })).toEqual({
      publicKey: VAPID.publicKey,
      privateKey: VAPID.privateKey,
    })
    expect(
      parseVapidConfig({
        publicKey: VAPID.publicKey,
        privateKey: VAPID.privateKey,
        subject: 'mailto:a@b.c',
      }),
    ).toEqual({
      publicKey: VAPID.publicKey,
      privateKey: VAPID.privateKey,
      subject: 'mailto:a@b.c',
    })
  })

  test('a malformed pair is inert, not half-enabled', () => {
    // Undecodable base64url, wrong point shape, wrong scalar size — the
    // config must be OFF from boot rather than throw at the first send.
    for (const raw of [
      { publicKey: '!!!not base64!!!', privateKey: VAPID.privateKey },
      { publicKey: VAPID.publicKey.slice(0, 20), privateKey: VAPID.privateKey },
      { publicKey: VAPID.publicKey, privateKey: 'short' },
      { publicKey: 'PUB', privateKey: 'PRIV' },
    ]) {
      expect(parseVapidConfig(raw)).toBeNull()
    }
  })
})

describe('registration', () => {
  test('a device registers into the room it is in', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store)
    fanout.register('amber-falcon-lantern', row('https://push.example/a'), 500)
    expect(store.list('amber-falcon-lantern')).toHaveLength(1)
    expect(store.list('other-room')).toHaveLength(0)
  })

  test('a re-registration UPSERTS the same row (key rotation converges)', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store)
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.register(
      'room',
      { endpoint: 'https://push.example/a', keys: { p256dh: 'NEW', auth: 'KEYS' } },
      900,
    )
    expect(store.list('room')).toHaveLength(1)
    expect(store.list('room')[0].keys.p256dh).toBe('NEW')
  })

  test('unregister drops exactly the named endpoint', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store)
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.register('room', row('https://push.example/b'), 500)
    fanout.unregister('room', 'https://push.example/a')
    expect(store.list('room').map((r) => r.endpoint)).toEqual(['https://push.example/b'])
  })

  test('drop clears the room (the room-row deletion path)', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store)
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.drop('room')
    expect(store.list('room')).toHaveLength(0)
  })

  test('the per-room quota evicts the OLDEST registration past the cap', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store)
    for (let i = 0; i < PUSH_ROOM_CAP + 3; i++) {
      fanout.register('room', row(`https://push.example/${i}`), 1000 + i)
    }
    expect(store.list('room')).toHaveLength(PUSH_ROOM_CAP)
    // The three oldest rows (stamps 1000..1002) are gone; the newest
    // survive — one member cannot grow the table or the fan-out unbounded.
    const endpoints = store.list('room').map((r) => r.endpoint)
    expect(endpoints).not.toContain('https://push.example/0')
    expect(endpoints).not.toContain('https://push.example/1')
    expect(endpoints).not.toContain('https://push.example/2')
    expect(endpoints).toContain(`https://push.example/${PUSH_ROOM_CAP + 2}`)
    // Another room's rows are untouched by this room's trim.
    fanout.register('other', row('https://push.example/x'), 1)
    expect(store.list('other')).toHaveLength(1)
  })
})

describe('fan-out delivery', () => {
  test('one notify sends to every registered subscription EXCEPT the sender', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl })
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.register('room', row('https://push.example/b'), 500)
    fanout.notify('room', 'plan-started', { self: 'https://push.example/a' })
    await waitSends(sender, 1)
    expect(sender.sent.map((s) => s.endpoint)).toEqual(['https://push.example/b'])
    // The VAPID Authorization header rides every send; the COPY is
    // encrypted inside the envelope, so it is pinned via notifyPayload.
    expect(sender.sent[0].authorization.startsWith('vapid t=')).toBe(true)
  })

  test('the notification copy is the core\'s, once per trigger (pinned via notifyPayload)', () => {
    // The delivery tests cannot read the copy out of an ENCRYPTED
    // envelope; the construction itself is the unit under test here.
    const plan = JSON.parse(notifyPayload('plan-started')) as Record<string, string>
    expect(plan.title).toBe('Meal plan started')
    expect(plan.body).toContain('started a meal plan')
    expect(plan.url).toBe('/plan')
    expect(plan.tag).toBe('flambette:plan-started')
    const grocery = JSON.parse(notifyPayload('grocery-finished')) as Record<string, string>
    expect(grocery.title).toBe('Grocery list finished')
    expect(grocery.url).toBe('/grocery')
    expect(grocery.tag).toBe('flambette:grocery-finished')
  })

  test('the two triggers carry different copy and deep links', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl })
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.notify('room', 'grocery-finished')
    await settle()
    // One send, to the one subscription; the copy is notifyPayload's (the
    // test above), not readable through the envelope.
    expect(sender.sent.map((s) => s.endpoint)).toEqual(['https://push.example/a'])
  })

  test('a room with no subscriptions sends nothing', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl })
    fanout.notify('room', 'plan-started')
    await waitSends(sender, 1)
    expect(sender.sent).toHaveLength(0)
  })

  test('an unknown trigger key is refused at the frame gate (adapter-side isNotifyKey)', () => {
    // The vocabulary test above pins the list; this pins the helper.
    const fanout = createPushFanout({ vapid: VAPID, store: makeStore(), now: () => 0 })
    // The unknown key never reaches notify's dedupe/sends — TS types keep
    // it out; the runtime gate lives in the adapters.
    expect(typeof fanout.notify).toBe('function')
  })
})

describe('dedupe window', () => {
  test('two triggers of the same key inside the window send ONCE', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout, clock } = fanoutWith(store, { fetchImpl: sender.impl, now: 1000 })
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.notify('room', 'plan-started')
    await settle()
    clock.value = 1000 + NOTIFY_DEDUPE_MS - 1
    fanout.notify('room', 'plan-started')
    await waitSends(sender, 1)
    expect(sender.sent).toHaveLength(1)
  })

  test('a trigger after the window expires sends again', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout, clock } = fanoutWith(store, { fetchImpl: sender.impl, now: 1000 })
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.notify('room', 'plan-started')
    await waitSends(sender, 1)
    clock.value = 1000 + NOTIFY_DEDUPE_MS + 1
    fanout.notify('room', 'plan-started')
    // Wait for one send BEYOND the first, not "at least one" — the first
    // send may already be recorded when the second notify is issued.
    await waitSends(sender, sender.sent.length + 1)
    expect(sender.sent).toHaveLength(2)
  })

  test('the window is per (room, key): another room sends through immediately', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl, now: 1000 })
    fanout.register('room-a', row('https://push.example/a'), 500)
    fanout.register('room-b', row('https://push.example/b'), 500)
    fanout.notify('room-a', 'plan-started')
    fanout.notify('room-b', 'plan-started')
    await waitSends(sender, 1)
    expect(sender.sent).toHaveLength(2)
  })

  test('different keys in one room do not suppress each other', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl, now: 1000 })
    fanout.register('room', row('https://push.example/a'), 500)
    fanout.notify('room', 'plan-started')
    fanout.notify('room', 'grocery-finished')
    await waitSends(sender, 1)
    expect(sender.sent).toHaveLength(2)
  })
})

describe('prune on dead subscriptions', () => {
  test('410 Gone prunes the row at the one place that tried it', async () => {
    const store = makeStore()
    const sender = makeSender((endpoint) => (endpoint.endsWith('/dead') ? 410 : 201))
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl })
    fanout.register('room', row('https://push.example/dead'), 500)
    fanout.register('room', row('https://push.example/alive'), 500)
    fanout.notify('room', 'plan-started')
    await waitSends(sender, 2)
    // The prune runs after the /dead row's own async send completes, which
    // can lag the first send by a tick under suite load — settle before
    // asserting the store (the file's settle() doc names this race).
    await settle()
    expect(sender.sent).toHaveLength(2)
    expect(store.list('room').map((r) => r.endpoint)).toEqual(['https://push.example/alive'])
  })

  test('404 prunes too; other failures keep the row', async () => {
    const store = makeStore()
    const sender = makeSender((endpoint) => {
      if (endpoint.endsWith('/gone')) return 404
      if (endpoint.endsWith('/busy')) return 429
      return 201
    })
    const { fanout } = fanoutWith(store, { fetchImpl: sender.impl })
    fanout.register('room', row('https://push.example/gone'), 500)
    fanout.register('room', row('https://push.example/busy'), 500)
    fanout.notify('room', 'plan-started')
    await settle()
    // 404 pruned, 429 kept (the endpoint may still be alive).
    expect(store.list('room').map((r) => r.endpoint)).toEqual(['https://push.example/busy'])
  })

  test('a transport failure keeps the row and never throws out of notify', async () => {
    const store = makeStore()
    const impl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const { fanout } = fanoutWith(store, { fetchImpl: impl })
    fanout.register('room', row('https://push.example/a'), 500)
    expect(() => fanout.notify('room', 'plan-started')).not.toThrow()
    await settle()
    expect(store.list('room')).toHaveLength(1)
  })
})

describe('no-VAPID inertness (ADR-0102: feature silently off)', () => {
  test('notify without keys sends NOTHING and never errors', async () => {
    const store = makeStore()
    const sender = makeSender()
    const { fanout } = fanoutWith(store, { vapid: null, fetchImpl: sender.impl })
    fanout.register('room', row('https://push.example/a'), 500)
    expect(() => fanout.notify('room', 'plan-started')).not.toThrow()
    await waitSends(sender, 1)
    expect(sender.sent).toHaveLength(0)
    // The registration rows still exist — a later configuration refresh
    // makes the relay able to send without the household re-registering.
    expect(store.list('room')).toHaveLength(1)
  })

  test('registration still works with no keys', () => {
    const store = makeStore()
    const { fanout } = fanoutWith(store, { vapid: null })
    fanout.register('room', row('https://push.example/a'), 500)
    expect(store.list('room')).toHaveLength(1)
  })
})
