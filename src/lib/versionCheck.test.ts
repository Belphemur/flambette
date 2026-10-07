import { describe, expect, test, vi } from 'bun:test'
import { checkVersion, compareVersions, type VersionState } from './versionCheck'

describe('compareVersions', () => {
  test('same strings → same', () => {
    expect(compareVersions('v2.2.0', 'v2.2.0')).toBe('same')
  })

  test('different strings → stale', () => {
    expect(compareVersions('v2.2.0', 'v2.3.0')).toBe('stale')
    expect(compareVersions('v2.2.0-main-abc', 'v2.2.0-main-def')).toBe('stale')
    expect(compareVersions('dev', 'v2.2.0')).toBe('stale')
  })

  test('null deployed → unknown', () => {
    expect(compareVersions('v2.2.0', null)).toBe('unknown')
  })
})

describe('checkVersion', () => {
  const RUNNING = 'v2.2.0'

  test('same version → same', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 'v2.2.0', builtAt: '2026-10-07T00:00:00Z' }),
    })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('same')
    expect(result.deployed).toBe('v2.2.0')
  })

  test('different version → stale', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 'v2.3.0', builtAt: '2026-10-08T00:00:00Z' }),
    })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('stale')
    expect(result.deployed).toBe('v2.3.0')
  })

  test('network failure → unknown', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('unknown')
    expect(result.deployed).toBeNull()
  })

  test('HTTP failure → unknown', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('unknown')
  })

  test('malformed JSON → unknown', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('bad json') },
    })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('unknown')
  })

  test('missing version field → unknown', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ builtAt: 'x' }) })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('unknown')
  })

  test('timeout → unknown', async () => {
    const fetch = vi.fn(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 200)
        }),
    )
    const result = await checkVersion({ running: RUNNING, fetch, timeoutMs: 50 })
    expect(result.state).toBe('unknown')
    expect(result.deployed).toBeNull()
  }, 5000)

  test('empty version string → unknown', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '' }) })
    const result = await checkVersion({ running: RUNNING, fetch })
    expect(result.state).toBe('unknown')
  })
})
