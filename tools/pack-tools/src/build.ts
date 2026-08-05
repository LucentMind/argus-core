import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { Zip } from 'zip-lib'
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
  const raw = fs.readFileSync(manifestPath, 'utf8')
  try {
    return packManifestSchema.parse(JSON.parse(raw))
  } catch (err) {
    throw new Error(`invalid ${PACK_MANIFEST_FILE} in ${packDir}: ${(err as Error).message}`)
  }
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
  const entries = fs.existsSync(binDir) ? fs.readdirSync(binDir, { withFileTypes: true }) : []
  // Anything that isn't a regular file is unsafe to silently skip — this includes real
  // subdirectories AND symlinks (to a dir or a file): readdirSync's Dirent uses lstat
  // semantics, so a symlink reports isDirectory() === false AND isFile() === false and
  // would otherwise sail through both this guard and the `present` set unnoticed.
  const dirs = entries.filter((e) => !e.isFile()).map((e) => e.name)
  if (dirs.length > 0) {
    throw new Error(
      `--bin contains a subdirectory (${dirs.join(', ')}) — pack-tools does not copy directories; move its contents to individual files in --bin`
    )
  }
  const present = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
  const claimed = new Set<string>()
  const targetOs = osOf(platform)
  const warnings: string[] = []

  for (const b of manifest.binaries) {
    if (b.platforms && !b.platforms.includes(targetOs)) continue // not required here
    if (b.bundled === false) {
      warnings.push(`binary '${b.id}' declared bundled: false — skipping the --bin file check, resolved at runtime instead`)
      continue
    }
    const cands = candidateNames(b.names, platform)
    const hit = cands.find((n) => present.has(n))
    if (!hit) {
      throw new Error(
        `binary '${b.id}' has no file in ${binDir} (looked for: ${cands.join(', ')})`
      )
    }
    claimed.add(hit)
  }

  warnings.push(
    ...[...present]
      .filter((n) => !claimed.has(n))
      .map((n) => `extra file in --bin not claimed by any binary: ${n}`)
  )
  return { warnings }
}

/** Declarative directories copied verbatim into the bundle when present. */
const BUNDLE_DIRS = ['skills', 'references', 'ui'] as const

/** Dev artifacts that must never ship even though they're commonly present in a
 *  working checkout — e.g. after running a panel's own test suite. */
const BUNDLE_IGNORE = new Set(['node_modules', '.git', '__pycache__', '.DS_Store'])

export function assembleBundle(
  manifest: PackManifest,
  packDir: string,
  binDir: string,
  platform: string,
  stagingDir: string
): void {
  fs.mkdirSync(stagingDir, { recursive: true })

  // Manifest with platform stamped in — re-validate so an invalid platform
  // fails fast at build time and the emitted manifest round-trips through
  // the real loader.
  const stamped = packManifestSchema.parse({ ...manifest, platform })
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

  // Declarative dirs (allowlist — never bin-src/.git/etc). Filtered to drop
  // common dev artifacts a working checkout accumulates (node_modules from
  // running a panel's tests, .git, __pycache__, .DS_Store) — otherwise these
  // ship to every user, silently, and can 10x the bundle size.
  for (const d of BUNDLE_DIRS) {
    const src = path.join(packDir, d)
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(stagingDir, d), {
        recursive: true,
        filter: (from) => !BUNDLE_IGNORE.has(path.basename(from))
      })
    }
  }

  // Binaries → bin/. binDir may not exist at all — a pack whose binaries are ALL
  // `bundled: false` has nothing to point --bin at; crossCheckBinaries already
  // tolerates that (see above), so this copy loop must too, leaving bin/ empty
  // rather than crashing on a raw ENOENT.
  const binOut = path.join(stagingDir, 'bin')
  fs.mkdirSync(binOut, { recursive: true })
  if (fs.existsSync(binDir)) {
    for (const ent of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (ent.isFile()) fs.cpSync(path.join(binDir, ent.name), path.join(binOut, ent.name))
    }
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

export interface BuildOptions {
  packDir: string
  binDir: string
  platform: string
  outDir: string
}

export interface BuildResult {
  zipPath: string
  bundleName: string
  files: string[]
  totalBytes: number
  warnings: string[]
}

export async function zipBundle(
  stagingDir: string,
  outDir: string,
  bundleName: string
): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true })
  const zip = new Zip()
  for (const rel of walkFiles(stagingDir)) {
    zip.addFile(path.join(stagingDir, ...rel.split('/')), rel)
  }
  const zipPath = path.join(outDir, `${bundleName}.zip`)
  await zip.archive(zipPath)
  return zipPath
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const manifest = readManifest(opts.packDir)
  const { warnings } = crossCheckBinaries(manifest, opts.binDir, opts.platform)
  const bundleName = `${manifest.id}-${manifest.version}-${opts.platform}`

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'packtools-stage-'))
  try {
    assembleBundle(manifest, opts.packDir, opts.binDir, opts.platform, staging)
    writeChecksums(staging)
    const files = walkFiles(staging).sort()
    const totalBytes = files.reduce(
      (sum, rel) => sum + fs.statSync(path.join(staging, ...rel.split('/'))).size,
      0
    )
    const zipPath = await zipBundle(staging, opts.outDir, bundleName)
    return { zipPath, bundleName, files, totalBytes, warnings }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
