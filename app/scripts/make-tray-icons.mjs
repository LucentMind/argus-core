// Generates the tray icon assets. Pure Node — no image dependency, no Electron.
//
// The tray needs images the app icon cannot supply. `resources/argus-icon.png` is a filled
// rounded-square plate, and macOS template images use ONLY the alpha channel: that plate would
// render as a solid black blob in the menu bar. So the mark (three concentric rings plus a
// center dot, matching argus-icon.svg) is drawn here procedurally, plate-free, straight into an
// RGBA buffer and PNG-encoded with node:zlib.
//
// Run: node scripts/make-tray-icons.mjs   (from app/)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')

/** Ring geometry in a 0..1 unit square, taken from argus-icon.svg's 192px viewBox. */
const RINGS = [
  { r: 72 / 192, w: 11 / 192 },
  { r: 48 / 192, w: 8 / 192 },
  { r: 28 / 192, w: 4 / 192 }
]
const DOT_R = 16 / 192

/** Coverage of one pixel by the mark, 0..1, supersampled 4x4 for antialiasing. */
function coverage(px, py, size) {
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = (px + (sx + 0.5) / 4) / size - 0.5
      const y = (py + (sy + 0.5) / 4) / size - 0.5
      const d = Math.hypot(x, y)
      if (d <= DOT_R) {
        hits++
        continue
      }
      // A ring covers the pixel when the distance falls inside its stroke band.
      if (RINGS.some((ring) => Math.abs(d - ring.r) <= ring.w / 2)) hits++
    }
  }
  return hits / 16
}

/** RGBA buffer of the mark at `size`px, in one flat colour. */
function render(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, size)
      const i = (y * size + x) * 4
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return buf
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Minimal RGBA-8 PNG encoder: one IHDR, one deflated IDAT, one IEND. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 = compression, filter, interlace — all zero.

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BLACK = [0, 0, 0]
const SKY = [0x7d, 0xd3, 0xfc] // argus-icon.svg's ring colour

const assets = [
  // macOS menu bar: alpha-only, so the colour is irrelevant — black by convention.
  ['trayTemplate.png', 16, BLACK],
  ['trayTemplate@2x.png', 32, BLACK],
  // Windows and Linux render the image as-is.
  ['trayIcon.png', 32, SKY]
]

for (const [name, size, colour] of assets) {
  writeFileSync(join(OUT, name), encodePng(render(size, colour), size))
  console.log(`wrote resources/${name} (${size}x${size})`)
}
