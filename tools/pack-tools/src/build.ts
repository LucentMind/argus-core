import fs from 'node:fs'
import path from 'node:path'
import {
  PACK_MANIFEST_FILE,
  packManifestSchema,
  type PackManifest
} from '../../../app/src/main/services/packs/manifest'

export function readManifest(packDir: string): PackManifest {
  const manifestPath = path.join(packDir, PACK_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`no ${PACK_MANIFEST_FILE} found in ${packDir}`)
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return packManifestSchema.parse(raw)
}

export function osOf(platform: string): 'win32' | 'darwin' | 'linux' {
  const os = platform.split('-')[0]
  if (os === 'mac') return 'darwin'
  if (os === 'win') return 'win32'
  if (os === 'linux') return 'linux'
  throw new Error(`unknown os in platform '${platform}'`)
}

/** File names a binary decl is satisfied by on this platform (adds .exe on win). */
function candidateNames(names: string[], platform: string): string[] {
  const win = osOf(platform) === 'win32'
  return names.flatMap((n) => (win ? [n, `${n}.exe`] : [n]))
}

export function crossCheckBinaries(
  manifest: PackManifest,
  binDir: string,
  platform: string
): { warnings: string[] } {
  const present = new Set(
    fs.existsSync(binDir)
      ? fs.readdirSync(binDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
      : []
  )
  const claimed = new Set<string>()
  const targetOs = osOf(platform)

  for (const b of manifest.binaries) {
    if (b.platforms && !b.platforms.includes(targetOs)) continue // not required here
    const cands = candidateNames(b.names, platform)
    const hit = cands.find((n) => present.has(n))
    if (!hit) {
      throw new Error(
        `binary '${b.id}' has no file in ${binDir} (looked for: ${cands.join(', ')})`
      )
    }
    claimed.add(hit)
  }

  const warnings = [...present]
    .filter((n) => !claimed.has(n))
    .map((n) => `extra file in --bin not claimed by any binary: ${n}`)
  return { warnings }
}
