import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extract } from 'zip-lib'
import { PACK_MANIFEST_FILE, packManifestSchema, type PackManifest } from './manifest'
import { verifyBundleChecksums } from './verify'
import { isApiCompatible, platformMatchesHost, describeHost } from './compat'
import { stripQuarantine } from './quarantine'
import type { PacksStateStore } from './packsState'
import { packsDir } from './paths'
import { sharedSkillsDir, sharedReferencesDir, isNonPackTiered } from '../skillsDir'
import type { InspectResult, InstallResult } from '../../../shared/packs'
export type { InspectResult, InstallResult }

class InstallError extends Error {
  constructor(
    public code: 'manifest' | 'checksum' | 'platform' | 'api' | 'io',
    message: string
  ) {
    super(message)
  }
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

export async function inspectBundleSource(source: string): Promise<InspectResult> {
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
      platformCompatible: platformMatchesHost(m.platform)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function installPack(
  source: string,
  opts: { argusHome: string; state: PacksStateStore; host?: { platform: string; arch: string } }
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
  opts: { argusHome: string; state: PacksStateStore }
): { ok: boolean; error?: string } {
  const { argusHome, state } = opts
  const dir = path.join(packsDir(argusHome), id)
  if (!fs.existsSync(dir)) return { ok: false, error: `pack '${id}' is not installed` }

  // Reap the pack's seeded skills (whole subdir) and untiered references (protect tiered copies).
  const skillsSrc = path.join(dir, 'skills')
  if (fs.existsSync(skillsSrc)) {
    for (const ent of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (ent.isDirectory())
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
