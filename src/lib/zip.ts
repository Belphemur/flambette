/**
 * Minimal zero-dependency ZIP reader/writer (STORED entries only — no
 * compression). Used by the backup/restore feature (ADR-0013): the zip
 * format for stored entries is a few well-defined byte layouts, which is
 * cheaper than pulling in JSZip for ~100 lines.
 *
 * Supports: name/data pairs (no zip64, no encryption, no directories),
 * with CRC-32 integrity on write and a central-directory scan on read.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS timestamp (2s resolution, year since 1980) for the given Date. */
function dosTimeDate(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(0, d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

const encoder = new TextEncoder()

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** Build a stored (uncompressed) zip archive from the given files. */
export function zipStore(files: ZipEntry[]): Uint8Array {
  const now = dosTimeDate(new Date())
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff])
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const crc = crc32(file.data)
    const size = file.data.length

    chunks.push(
      // Local file header
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(size), // compressed
      u32(size), // uncompressed
      u16(nameBytes.length),
      u16(0), // extra len
      nameBytes,
      file.data,
    )

    central.push(
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset),
      nameBytes,
    )

    offset += 30 + nameBytes.length + size
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const end = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]

  const all = [...chunks, ...central, ...end]
  const total = all.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of all) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

/** Read a stored zip archive into a name → data map. Returns an error string on failure. */
export function unzipStore(zip: Uint8Array): Map<string, Uint8Array> | string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)

  // Locate the End Of Central Directory record (signature scan from the end).
  let eocd = -1
  const minEocd = Math.max(0, zip.length - 22 - 65535)
  for (let i = zip.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return 'Not a zip archive — no central directory found'

  const entries = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)

  const files = new Map<string, Uint8Array>()
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) return 'Corrupt zip — bad central directory entry'
    const method = view.getUint16(pos + 10, true)
    const csize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    const name = new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLen))
    pos += 46 + nameLen + extraLen + commentLen

    if (method !== 0) return `Unsupported zip entry "${name}" — only stored (uncompressed) zips are accepted`
    if (view.getUint32(localOffset, true) !== 0x04034b50)
      return `Corrupt zip — bad local header for "${name}"`
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    files.set(name, zip.subarray(dataStart, dataStart + csize))
  }
  return files
}

export function textDecoder(): TextDecoder {
  return new TextDecoder()
}
