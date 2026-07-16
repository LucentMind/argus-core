import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Zip } from 'zip-lib'
import { inspectBundleSource, installPack, uninstallPack } from '../install'
import { PacksStateStore } from '../packsState'
import { describeHost } from '../compat'
import { packsDir } from '../paths'
import { sharedSkillsDir, sharedReferencesDir } from '../../skillsDir'

let home: string
let state: PacksStateStore
const HOST = { platform: process.platform, arch: process.arch }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-install-'))
  state = new PacksStateStore(home)
})
afterEach(() => {
  state.close()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Build a staged bundle DIR (manifest + optional extras) with a valid CHECKSUMS. */
function makeBundleDir(
  over: Record<string, unknown> = {},
  extras: Record<string, string> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bundle-'))
  const manifest = {
    id: 'sample',
    displayName: 'Sample',
    version: '1.0.0',
    argusApi: '^1',
    platform: describeHost(HOST),
    ...over
  }
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [rel, body] of Object.entries(extras)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, ...rel.split('/')), body)
  }
  // CHECKSUMS last, over everything else (2a format).
  const rels: string[] = []
  const walk = (rel: string): void => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const c = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(c)
      else if (ent.isFile() && c !== 'CHECKSUMS') rels.push(c)
    }
  }
  walk('')
  rels.sort()
  fs.writeFileSync(
    path.join(dir, 'CHECKSUMS'),
    rels
      .map(
        (rel) =>
          `${crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(dir, ...rel.split('/'))))
            .digest('hex')}  ${rel}\n`
      )
      .join('')
  )
  return dir
}

async function zipOf(dir: string): Promise<string> {
  const zip = new Zip()
  const walk = (rel: string): void => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const c = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(c)
      else if (ent.isFile()) zip.addFile(path.join(dir, ...c.split('/')), c)
    }
  }
  walk('')
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-zip-')), 'sample.zip')
  await zip.archive(out)
  return out
}

describe('inspectBundleSource', () => {
  it('reads id/version/platform + compatibility from a directory', async () => {
    const dir = makeBundleDir()
    const r = await inspectBundleSource(dir)
    expect(r).toMatchObject({
      id: 'sample',
      version: '1.0.0',
      apiCompatible: true,
      platformCompatible: true
    })
  })
  it('reads from a .zip', async () => {
    const zip = await zipOf(makeBundleDir())
    expect((await inspectBundleSource(zip)).id).toBe('sample')
  })
})

describe('installPack', () => {
  it('installs a directory bundle: pack lands, state records version, relaunch flagged', async () => {
    const r = await installPack(makeBundleDir({}, { 'bin/argus-demo': 'x' }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(r).toMatchObject({
      ok: true,
      id: 'sample',
      version: '1.0.0',
      previousVersion: null,
      relaunchRequired: true
    })
    expect(fs.existsSync(path.join(packsDir(home), 'sample', 'argus-pack.json'))).toBe(true)
    expect(fs.existsSync(path.join(packsDir(home), 'sample', 'bin', 'argus-demo'))).toBe(true)
    expect(state.get('sample')).toBe('1.0.0')
  })

  it('installs a .zip bundle', async () => {
    const zip = await zipOf(makeBundleDir())
    const r = await installPack(zip, { argusHome: home, state, host: HOST })
    expect(r.ok).toBe(true)
    expect(state.get('sample')).toBe('1.0.0')
  })

  it('upgrading retains the previous version as <id>.bak and reports previousVersion', async () => {
    await installPack(makeBundleDir({ version: '1.0.0' }), { argusHome: home, state, host: HOST })
    const r = await installPack(makeBundleDir({ version: '2.0.0' }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(r).toMatchObject({ ok: true, version: '2.0.0', previousVersion: '1.0.0' })
    expect(fs.existsSync(path.join(packsDir(home), 'sample.bak'))).toBe(true)
    expect(state.get('sample')).toBe('2.0.0')
  })

  it('aborts on a checksum mismatch, leaving the prior pack + state intact', async () => {
    await installPack(makeBundleDir({ version: '1.0.0' }), { argusHome: home, state, host: HOST })
    const bad = makeBundleDir({ version: '2.0.0' })
    fs.appendFileSync(path.join(bad, 'argus-pack.json'), ' ') // mutate after CHECKSUMS written
    const r = await installPack(bad, { argusHome: home, state, host: HOST })
    expect(r).toMatchObject({ ok: false, code: 'checksum' })
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(packsDir(home), 'sample', 'argus-pack.json'), 'utf8')
    )
    expect(onDisk.version).toBe('1.0.0') // unchanged
    expect(state.get('sample')).toBe('1.0.0')
  })

  it('rolls back to the previous version when the final rename fails', async () => {
    await installPack(makeBundleDir({ version: '1.0.0' }), { argusHome: home, state, host: HOST })
    const target = path.join(packsDir(home), 'sample')
    const realRename = fs.renameSync.bind(fs)
    // Fail only the staging->target swap (source is the .pack-install- staging dir);
    // let the .bak rename and the bak->target rollback rename through.
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike
    ) => {
      if (String(to) === target && String(from).includes('.pack-install-')) {
        throw new Error('simulated rename failure')
      }
      return realRename(from as fs.PathLike, to as fs.PathLike)
    }) as typeof fs.renameSync)
    try {
      const r = await installPack(makeBundleDir({ version: '2.0.0' }), {
        argusHome: home,
        state,
        host: HOST
      })
      expect(r).toMatchObject({ ok: false, code: 'io' })
      const onDisk = JSON.parse(fs.readFileSync(path.join(target, 'argus-pack.json'), 'utf8'))
      expect(onDisk.version).toBe('1.0.0') // rolled back from .bak
      expect(state.get('sample')).toBe('1.0.0')
    } finally {
      spy.mockRestore()
    }
  })

  it('a platform reject on an upgrade leaves the prior pack and .bak untouched', async () => {
    await installPack(makeBundleDir({ version: '1.0.0' }), { argusHome: home, state, host: HOST })
    const other = process.platform === 'win32' ? 'mac-arm64' : 'win-x64'
    const r = await installPack(makeBundleDir({ version: '2.0.0', platform: other }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(r).toMatchObject({ ok: false, code: 'platform' })
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(packsDir(home), 'sample', 'argus-pack.json'), 'utf8')
    )
    expect(onDisk.version).toBe('1.0.0') // prior pack untouched
    expect(state.get('sample')).toBe('1.0.0')
  })

  it('rejects a platform mismatch', async () => {
    const other = process.platform === 'win32' ? 'mac-arm64' : 'win-x64'
    const r = await installPack(makeBundleDir({ platform: other }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(r).toMatchObject({ ok: false, code: 'platform' })
    expect(state.get('sample')).toBeUndefined()
  })

  it('rejects an incompatible argusApi', async () => {
    const r = await installPack(makeBundleDir({ argusApi: '^2' }), {
      argusHome: home,
      state,
      host: HOST
    })
    expect(r).toMatchObject({ ok: false, code: 'api' })
    expect(state.get('sample')).toBeUndefined()
  })
})

describe('uninstallPack', () => {
  it('removes the pack dir, reaps untiered seeded assets, protects tiered refs, clears state', async () => {
    // install a pack that ships a skill + two references
    await installPack(
      makeBundleDir(
        {},
        {
          'skills/demo/SKILL.md': '# demo skill',
          'references/plain.md': 'pack reference',
          'references/synced.md': '---\ntrust_tier: hivemind\n---\nsynced'
        }
      ),
      { argusHome: home, state, host: HOST }
    )
    // simulate seedSharedAssets having copied the pack's assets out into ARGUS_HOME
    fs.mkdirSync(path.join(sharedSkillsDir(home), 'demo'), { recursive: true })
    fs.writeFileSync(path.join(sharedSkillsDir(home), 'demo', 'SKILL.md'), '# demo skill')
    fs.mkdirSync(sharedReferencesDir(home), { recursive: true })
    fs.writeFileSync(path.join(sharedReferencesDir(home), 'plain.md'), 'pack reference')
    fs.writeFileSync(
      path.join(sharedReferencesDir(home), 'synced.md'),
      '---\ntrust_tier: hivemind\n---\nsynced'
    )

    const r = uninstallPack('sample', { argusHome: home, state })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(packsDir(home), 'sample'))).toBe(false)
    expect(fs.existsSync(path.join(sharedSkillsDir(home), 'demo'))).toBe(false) // skill reaped
    expect(fs.existsSync(path.join(sharedReferencesDir(home), 'plain.md'))).toBe(false) // untiered reaped
    expect(fs.existsSync(path.join(sharedReferencesDir(home), 'synced.md'))).toBe(true) // tiered protected
    expect(state.get('sample')).toBeUndefined()
  })

  it('errors when the pack is not installed', () => {
    expect(uninstallPack('ghost', { argusHome: home, state }).ok).toBe(false)
  })

  it('protects a core-shipped skill from reaping when a pack ships a same-named skill, but still reaps pack-only skills', async () => {
    // install a pack that ships two skills: one collides with a core skill name, one doesn't
    await installPack(
      makeBundleDir(
        {},
        {
          'skills/contribute-back/SKILL.md': '# pack copy of contribute-back',
          'skills/pack-only/SKILL.md': '# pack-only skill'
        }
      ),
      { argusHome: home, state, host: HOST }
    )
    // simulate seedSharedAssets having copied the pack's skills, then core-skills seeding
    // AFTER packs (core wins the name collision) into the same bundled skills dir
    fs.mkdirSync(path.join(sharedSkillsDir(home), 'contribute-back'), { recursive: true })
    fs.writeFileSync(
      path.join(sharedSkillsDir(home), 'contribute-back', 'SKILL.md'),
      '# core contribute-back'
    )
    fs.mkdirSync(path.join(sharedSkillsDir(home), 'pack-only'), { recursive: true })
    fs.writeFileSync(path.join(sharedSkillsDir(home), 'pack-only', 'SKILL.md'), '# pack-only skill')

    // core-skills source dir (fixture, DI-style — not electron's resourcesPath)
    const coreSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-core-skills-'))
    fs.mkdirSync(path.join(coreSkillsDir, 'contribute-back'), { recursive: true })
    fs.writeFileSync(
      path.join(coreSkillsDir, 'contribute-back', 'SKILL.md'),
      '# core contribute-back'
    )

    const r = uninstallPack('sample', { argusHome: home, state, coreSkillsDir })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(sharedSkillsDir(home), 'contribute-back'))).toBe(true) // core skill survives
    expect(fs.existsSync(path.join(sharedSkillsDir(home), 'pack-only'))).toBe(false) // pack-only skill reaped
  })
})
