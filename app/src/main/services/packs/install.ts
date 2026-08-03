import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { extract } from 'zip-lib'
import { PACK_MANIFEST_FILE, packManifestSchema, type PackManifest } from './manifest'
import { verifyBundleChecksums } from './verify'
import { isApiCompatible, platformMatchesHost, describeHost } from './compat'
import { stripQuarantine } from './quarantine'
import type { PacksStateStore, PackSource } from './packsState'
import { parseGhRef } from './githubRef'
import { packsDir } from './paths'
import { sharedSkillsDir, sharedReferencesDir, isNonPackTiered } from '../skillsDir'
import type { InspectResult, InstallResult, PackDependencyStatus } from '../../../shared/packs'
export type { InspectResult, InstallResult, PackDependencyStatus }

class InstallError extends Error {
  constructor(
    public code: 'manifest' | 'checksum' | 'platform' | 'api' | 'dependency' | 'io',
    message: string
  ) {
    super(message)
  }
}

/**
 * Resolve a manifest's declared dependencies against the installed set (`PacksStateStore.list()`).
 * Pure: it decides satisfaction only, never installs anything — Core refuses and names what is
 * missing rather than fetching a dependency on the user's behalf.
 */
export function resolveDependencies(
  manifest: Pick<PackManifest, 'id' | 'dependencies'>,
  installed: Record<string, string>
): PackDependencyStatus[] {
  return Object.entries(manifest.dependencies ?? {}).map(([id, range]) => {
    const installedVersion = installed[id] ?? null
    if (id === manifest.id) {
      return {
        id,
        range,
        installedVersion,
        satisfied: false,
        detail: `pack '${id}' declares a dependency on itself`
      }
    }
    if (installedVersion == null) {
      return {
        id,
        range,
        installedVersion,
        satisfied: false,
        detail: `requires '${id}' ${range}, which is not installed`
      }
    }
    if (!semver.valid(installedVersion)) {
      return {
        id,
        range,
        installedVersion,
        satisfied: false,
        detail: `requires '${id}' ${range}, but the installed version '${installedVersion}' is not valid semver`
      }
    }
    if (!semver.satisfies(installedVersion, range)) {
      return {
        id,
        range,
        installedVersion,
        satisfied: false,
        detail: `requires '${id}' ${range}, but '${installedVersion}' is installed`
      }
    }
    return { id, range, installedVersion, satisfied: true, detail: '' }
  })
}

/** One message naming every unsatisfied dependency, or null when they all resolve. */
export function describeUnsatisfied(packId: string, deps: PackDependencyStatus[]): string | null {
  const unmet = deps.filter((d) => !d.satisfied)
  if (unmet.length === 0) return null
  return `pack '${packId}' ${unmet.map((d) => d.detail).join('; ')}`
}

/** Ids of installed packs that declare a dependency on `id`, read from their on-disk manifests. */
export function dependentsOf(id: string, argusHome: string): string[] {
  const dir = packsDir(argusHome)
  if (!fs.existsSync(dir)) return []
  const dependents: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === id) continue
    const p = path.join(dir, ent.name, PACK_MANIFEST_FILE)
    if (!fs.existsSync(p)) continue
    // A pack whose manifest no longer parses can't be trusted to declare anything — it will
    // fail at load with its own error; it must not block an unrelated uninstall.
    const parsed = packManifestSchema.safeParse(
      (() => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf8'))
        } catch {
          return null
        }
      })()
    )
    if (!parsed.success) continue
    if (Object.hasOwn(parsed.data.dependencies ?? {}, id)) dependents.push(parsed.data.id)
  }
  return dependents.sort()
}

/** Materialize a .zip or directory source into a fresh staging dir on the packs volume. */
async function stage(source: string, argusHome: string): Promise<string> {
  // realpathSync: on macOS a symlinked parent (e.g. os.tmpdir() → /private/var,
  // or a symlinked ARGUS_HOME) makes zip-lib's safeSymlinksOnly guard compare an
  // extracted file's realpath against the unresolved staging path and reject the
  // mismatch. Resolve the staging dir up front so the guard sees matching paths.
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(argusHome, '.pack-install-')))
  try {
    const st = fs.statSync(source)
    if (st.isDirectory()) fs.cpSync(source, staging, { recursive: true })
    else await extract(source, staging, { safeSymlinksOnly: true })
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new InstallError('io', `could not read bundle: ${(err as Error).message}`)
  }
  return staging
}

function readManifest(dir: string): PackManifest {
  const p = path.join(dir, PACK_MANIFEST_FILE)
  if (!fs.existsSync(p)) throw new InstallError('manifest', `no ${PACK_MANIFEST_FILE} in bundle`)
  try {
    return packManifestSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch (err) {
    throw new InstallError('manifest', `invalid manifest: ${(err as Error).message}`)
  }
}

export async function inspectBundleSource(
  source: string,
  opts: { installed?: Record<string, string> } = {}
): Promise<InspectResult> {
  // realpathSync: os.tmpdir() is a symlink on macOS (/var/folders → /private/var),
  // which trips zip-lib's safeSymlinksOnly guard during extract. Resolve it first.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-inspect-')))
  try {
    const st = fs.statSync(source)
    if (st.isDirectory()) fs.cpSync(source, tmp, { recursive: true })
    else await extract(source, tmp, { safeSymlinksOnly: true })
    const m = readManifest(tmp)
    return {
      id: m.id,
      version: m.version,
      platform: m.platform,
      apiCompatible: isApiCompatible(m.argusApi),
      platformCompatible: platformMatchesHost(m.platform),
      updateRepo: m.updateRepo,
      dependencies: resolveDependencies(m, opts.installed ?? {})
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The pin a freshly installed manifest implies, or `null` when it declares no update source —
 * a pack that stops publishing must stop being checked rather than keep a pin from a previous
 * install. `updateRepo` wins if both are somehow present; the schema already refuses that pair,
 * so this ordering is a belt, not a policy.
 */
function sourceFor(manifest: PackManifest, now: number): PackSource | null {
  if (manifest.updateRepo) {
    const ref = parseGhRef(manifest.updateRepo)
    // Unreachable via the schema, which validates the shape — but `sourceFor` must not invent a
    // pin from a ref it could not parse.
    if (ref) return { kind: 'github', ...ref, installedAt: now }
  }
  if (manifest.updateUrl) {
    return {
      origin: new URL(manifest.updateUrl).origin,
      updateUrl: manifest.updateUrl,
      installedAt: now
    }
  }
  return null
}

export async function installPack(
  source: string,
  opts: {
    argusHome: string
    state: PacksStateStore
    host?: { platform: string; arch: string }
    /**
     * Forces the pin instead of deriving it from the manifest. Install-from-repo passes the repo
     * the bytes actually came from: the user chose a repo, and that choice must outrank a
     * manifest that names a feed. `null` pins nothing. Undefined (the default) derives.
     */
    pinOverride?: PackSource | null
  }
): Promise<InstallResult> {
  const { argusHome, state } = opts
  const host = opts.host ?? { platform: process.platform, arch: process.arch }
  const dest = packsDir(argusHome)
  fs.mkdirSync(dest, { recursive: true })

  let staging: string | null = null
  try {
    staging = await stage(source, argusHome)

    const verdict = verifyBundleChecksums(staging)
    if (!verdict.ok)
      throw new InstallError('checksum', `bundle failed verification: ${verdict.errors[0]}`)

    const manifest = readManifest(staging)
    if (!platformMatchesHost(manifest.platform, host)) {
      throw new InstallError(
        'platform',
        `bundle platform '${manifest.platform ?? '(none)'}' does not match host '${describeHost(host)}'`
      )
    }
    if (!isApiCompatible(manifest.argusApi)) {
      throw new InstallError(
        'api',
        `bundle requires argusApi '${manifest.argusApi}', incompatible with this Core`
      )
    }

    const unsatisfied = describeUnsatisfied(
      manifest.id,
      resolveDependencies(manifest, state.list())
    )
    if (unsatisfied) throw new InstallError('dependency', unsatisfied)

    stripQuarantine(staging)

    const target = path.join(dest, manifest.id)
    const bak = `${target}.bak`
    const previousVersion = state.get(manifest.id) ?? null
    const hadPrevious = fs.existsSync(target)

    if (hadPrevious) {
      fs.rmSync(bak, { recursive: true, force: true })
      fs.renameSync(target, bak)
    }
    try {
      fs.renameSync(staging, target)
    } catch (err) {
      if (hadPrevious && !fs.existsSync(target)) fs.renameSync(bak, target) // rollback
      throw new InstallError('io', `atomic swap failed: ${(err as Error).message}`)
    }
    staging = null // consumed by the rename

    state.set(manifest.id, manifest.version)
    // The pin is derived from the manifest we just installed, and CLEARED when that manifest
    // declares no update source — a pack that stops publishing must stop being checked rather
    // than retaining a pin from a previous install. `pinOverride` forces it instead, for
    // install-from-repo, where the repo the bytes came from must outrank the manifest.
    state.setSource(
      manifest.id,
      opts.pinOverride !== undefined ? opts.pinOverride : sourceFor(manifest, Date.now())
    )
    return {
      ok: true,
      id: manifest.id,
      version: manifest.version,
      previousVersion,
      relaunchRequired: true
    }
  } catch (err) {
    if (err instanceof InstallError) return { ok: false, code: err.code, error: err.message }
    return { ok: false, code: 'io', error: (err as Error).message }
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function uninstallPack(
  id: string,
  opts: { argusHome: string; state: PacksStateStore; coreSkillsDir?: string }
): { ok: boolean; error?: string } {
  const { argusHome, state, coreSkillsDir } = opts
  const dir = path.join(packsDir(argusHome), id)
  if (!fs.existsSync(dir)) return { ok: false, error: `pack '${id}' is not installed` }

  const dependents = dependentsOf(id, argusHome)
  if (dependents.length > 0) {
    return {
      ok: false,
      error: `pack '${id}' is required by ${dependents.map((d) => `'${d}'`).join(', ')} — uninstall ${dependents.length > 1 ? 'those packs' : 'that pack'} first`
    }
  }

  const coreSkillNames = new Set(
    coreSkillsDir && fs.existsSync(coreSkillsDir)
      ? fs
          .readdirSync(coreSkillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : []
  )

  // Reap the pack's seeded skills (whole subdir) and untiered references (protect tiered copies).
  // The bundled skills tier is no longer pack-exclusive — core-shipped skills seed into it too
  // (after packs, so they win name collisions) — so skip any name that's core-owned; otherwise
  // uninstalling a pack that collided with a core skill would delete the core skill until the
  // next app boot re-seeds it.
  const skillsSrc = path.join(dir, 'skills')
  if (fs.existsSync(skillsSrc)) {
    for (const ent of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (ent.isDirectory() && !coreSkillNames.has(ent.name))
        fs.rmSync(path.join(sharedSkillsDir(argusHome), ent.name), { recursive: true, force: true })
    }
  }
  const refsSrc = path.join(dir, 'references')
  if (fs.existsSync(refsSrc)) {
    for (const ent of fs.readdirSync(refsSrc, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      const dest = path.join(sharedReferencesDir(argusHome), ent.name)
      if (fs.existsSync(dest) && !isNonPackTiered(dest)) fs.rmSync(dest, { force: true })
    }
  }

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(`${dir}.bak`, { recursive: true, force: true })
  state.remove(id)
  return { ok: true }
}
