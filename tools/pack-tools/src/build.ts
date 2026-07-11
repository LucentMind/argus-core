import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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

/** Declarative directories copied verbatim into the bundle when present. */
const BUNDLE_DIRS = ['skills', 'references', 'ui'] as const

export function assembleBundle(
  manifest: PackManifest,
  packDir: string,
  binDir: string,
  platform: string,
  stagingDir: string
): void {
  fs.mkdirSync(stagingDir, { recursive: true })

  // Manifest with platform stamped in.
  const stamped = { ...manifest, platform }
  fs.writeFileSync(
    path.join(stagingDir, PACK_MANIFEST_FILE),
    JSON.stringify(stamped, null, 2) + '\n'
  )

  // Persona (if declared).
  if (manifest.persona) {
    const src = path.join(packDir, manifest.persona)
    if (!fs.existsSync(src)) throw new Error(`persona file not found: ${manifest.persona}`)
    fs.cpSync(src, path.join(stagingDir, manifest.persona))
  }

  // Declarative dirs (allowlist — never bin-src/.git/etc).
  for (const d of BUNDLE_DIRS) {
    const src = path.join(packDir, d)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(stagingDir, d), { recursive: true })
  }

  // Binaries → bin/.
  const binOut = path.join(stagingDir, 'bin')
  fs.mkdirSync(binOut, { recursive: true })
  for (const ent of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (ent.isFile()) fs.cpSync(path.join(binDir, ent.name), path.join(binOut, ent.name))
  }
}

const CHECKSUMS_FILE = 'CHECKSUMS'

function walkFiles(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) out.push(...walkFiles(root, childRel))
    else if (ent.isFile()) out.push(childRel)
  }
  return out
}

export function writeChecksums(stagingDir: string): Record<string, string> {
  const rels = walkFiles(stagingDir)
    .filter((r) => r !== CHECKSUMS_FILE)
    .sort()
  const map: Record<string, string> = {}
  for (const rel of rels) {
    const buf = fs.readFileSync(path.join(stagingDir, ...rel.split('/')))
    map[rel] = crypto.createHash('sha256').update(buf).digest('hex')
  }
  const body = rels.map((rel) => `${map[rel]}  ${rel}\n`).join('')
  fs.writeFileSync(path.join(stagingDir, CHECKSUMS_FILE), body)
  return map
}
