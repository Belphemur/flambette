import type { PlanEntry } from '../stores/plan'

/**
 * Plan sharing: gzip(JSON(plan)) → base64url → `?p=` query param, using the
 * native CompressionStream API (no dependency). Links longer than
 * MAX_SHARE_LENGTH chars are rejected — most messaging apps/UIs mangle
 * overly long URLs.
 */
export const MAX_SHARE_LENGTH = 1800

async function pipeGzip(bytes: Uint8Array, compress: boolean): Promise<Uint8Array> {
  const StreamCtor = compress ? CompressionStream : DecompressionStream
  // Blob.stream() gives us a ReadableStream to pipe through the codec.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new StreamCtor('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encode a plan into the `?p=` param value (base64url of gzip JSON). */
export async function encodePlan(plan: PlanEntry[]): Promise<string> {
  const json = JSON.stringify(plan)
  const gzipped = await pipeGzip(new TextEncoder().encode(json), true)
  return toBase64Url(gzipped)
}

/**
 * Decode a `?p=` param value back into plan entries. Returns null when the
 * payload is malformed or doesn't look like a plan.
 */
export async function decodePlan(str: string): Promise<PlanEntry[] | null> {
  try {
    const bytes = await pipeGzip(fromBase64Url(str), false)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed)) return null
    const entries = parsed.filter(
      (e): e is PlanEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as PlanEntry).variantId === 'number' &&
        typeof (e as PlanEntry).servings === 'number' &&
        Number.isFinite((e as PlanEntry).variantId) &&
        (e as PlanEntry).servings >= 1,
    )
    return entries.length === parsed.length ? entries : null
  } catch {
    return null
  }
}

/**
 * Full share URL for the plan (`<origin><base>?p=<encoded>`), or null when
 * the encoded plan is too long to share reliably.
 */
export async function planShareUrl(plan: PlanEntry[]): Promise<string | null> {
  if (plan.length === 0) return null
  const encoded = await encodePlan(plan)
  if (encoded.length > MAX_SHARE_LENGTH) return null
  return `${window.location.origin}${import.meta.env.BASE_URL}?p=${encoded}`
}
