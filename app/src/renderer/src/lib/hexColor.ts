/** Split out of AmbientCanvas.tsx: react-refresh/only-export-components forbids
 *  a component file from exporting anything but components (and types) — see
 *  [[argus-renderer-lint-traps]]. Exported for test: the shipped version
 *  returned BLACK on anything that was not 6-digit hex, which silently made
 *  the light-theme ground pure black. Returns null instead so the caller can
 *  decide the fallback. */
export function hexToRgb01(hex: string): [number, number, number] | null {
  const s = hex.trim()
  const six = /^#?([0-9a-f]{6})$/i.exec(s)
  if (six) {
    const n = parseInt(six[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const three = /^#?([0-9a-f]{3})$/i.exec(s)
  if (three) {
    const n = parseInt(three[1], 16)
    return [(((n >> 8) & 15) * 17) / 255, (((n >> 4) & 15) * 17) / 255, ((n & 15) * 17) / 255]
  }
  return null
}
