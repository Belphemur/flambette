import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { IDENTITY_PERSIST_KEY, useIdentityStore } from './identity'
import { useUiStore } from './ui'
import { isUuidShape } from '../lib/profileName'
import { NAME_ADJECTIVES, NAME_NOUNS } from '../lib/roomWords'

/**
 * Identity store behaviour (ADR-0063): generation timing (first join, and
 * the in-room hydration migration), id immutability, and renames clamping
 * identically to the relay's normalizeProfile.
 */

describe('identity store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
  })

  test('a fresh device has no identity until generated', () => {
    const identity = useIdentityStore()
    expect(identity.id).toBe('')
    expect(identity.name).toBe('')
    expect(identity.hasIdentity).toBe(false)
    expect(identity.displayName).toBe('Guest')
  })

  test('generate() mints a UUIDv7 id and a safe-word name', () => {
    const identity = useIdentityStore()
    identity.generate()
    expect(isUuidShape(identity.id)).toBe(true)
    // UUIDv7: version nibble is 7.
    expect(identity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const [adj, noun] = identity.name.toLowerCase().split(' ')
    expect(NAME_ADJECTIVES).toContain(adj)
    expect(NAME_NOUNS).toContain(noun)
    expect(identity.hasIdentity).toBe(true)
  })

  test('generation is idempotent — the id NEVER regenerates', () => {
    const identity = useIdentityStore()
    identity.generate()
    const firstId = identity.id
    const firstName = identity.name
    identity.generate()
    identity.generate()
    expect(identity.id).toBe(firstId)
    expect(identity.name).toBe(firstName)
  })

  test('ensureIfInRoom() generates when a household room is set (migration path)', () => {
    // A device that upgraded while already in a household: the ui slice
    // holds the room, the identity slice is absent.
    useUiStore().setHouseholdRoom('amber-falcon-lantern')
    const identity = useIdentityStore()
    identity.ensureIfInRoom()
    expect(isUuidShape(identity.id)).toBe(true)
    expect(identity.name).not.toBe('')
  })

  test('ensureIfInRoom() does NOT generate for a device without a room', () => {
    const identity = useIdentityStore()
    identity.ensureIfInRoom()
    expect(identity.id).toBe('')
  })

  test('ensureIfInRoom() never regenerates an existing identity', () => {
    useUiStore().setHouseholdRoom('amber-falcon-lantern')
    const identity = useIdentityStore()
    identity.generate()
    const id = identity.id
    identity.ensureIfInRoom()
    expect(identity.id).toBe(id)
  })

  test('rename clamps like the relay: trim, strip controls, cap 40 chars', () => {
    const identity = useIdentityStore()
    identity.generate()
    const id = identity.id
    identity.rename('  Brave   Otter  ')
    expect(identity.name).toBe('Brave Otter')
    // Strip-in-place: a control char INSIDE a word disappears without
    // leaving a seam (the same rule the relay's normalizeProfile applies
    // via the shared sanitizer).
    identity.rename('Bad\u0007Name\u200d Here')
    expect(identity.name).toBe('BadName Here')
    identity.rename('x'.repeat(80))
    expect(identity.name).toBe('x'.repeat(40))
    expect(identity.id).toBe(id)
  })

  test('rename refuses a blank result — the name cannot be emptied', () => {
    const identity = useIdentityStore()
    identity.generate()
    const name = identity.name
    identity.rename('   ')
    expect(identity.name).toBe(name)
  })

  test('persist key matches the registry and the ADR', () => {
    expect(IDENTITY_PERSIST_KEY).toBe('mealime-planner:v1:identity')
  })
})
