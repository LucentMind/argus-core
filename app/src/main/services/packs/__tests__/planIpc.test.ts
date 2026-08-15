import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Zip } from 'zip-lib'
import { registerPacksPlanIpc, type HandleFn } from '../planIpc'
import { PacksStateStore } from '../packsState'
import { GhError, type GhClient } from '../ghClient'
import type { ResolvedCandidate } from '../depSources'
import type { DeclaredSource } from '../dependencies'
import type { InstallResult, PlanResult, ApplyPlanResult } from '../../../../shared/packs'

let home: string
let tempRoot: string
let bundleSrc: string

/** A staged bundle DIR with just enough of a manifest for `inspectBundleSource` to read — the
 *  real function (not injected in `planIpc.ts`; see the comment on the harness below), so the
 *  fixture must satisfy it for real rather than through a fake. */
function makeBundleDir(id: string, version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `argus-planipc-bundle-${id}-`))
  fs.writeFileSync(
    path.join(dir, 'argus-pack.json'),
    JSON.stringify({ id, displayName: id, version, argusApi: '^1' }, null, 2)
  )
  return dir
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-planipc-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-planipc-temp-'))
  bundleSrc = makeBundleDir('maps', '2.0.0')
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.rmSync(bundleSrc, { recursive: true, force: true })
})

/**
 * `registerPacksPlanIpc` is the DI seam for `packsPlanBundle`/`packsApplyPlan` — see the comment
 * atop `planIpc.ts`. `handle` is faked to capture the registered listeners (same idiom as
 * `updateIpc.test.ts`'s `harness()`), never `vi.mock('electron')`. The resolver/download stubs are
 * only exercised by tests with a real dependency; the fixed single-pack plan below never needs
 * them. `inspectBundleSource` itself is NOT injectable (planIpc.ts imports it directly), so the
 * fixture bundle is a real directory a real manifest parse can succeed against.
 */
function harness(opts: { installCalls: string[]; installDelayMs?: number }): {
  handlers: Map<string, (...args: never[]) => unknown>
  onApplied: ApplyPlanResult[]
} {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const handle: HandleFn = (channel, fn) => void handlers.set(channel, fn as never)
  const packsState = new PacksStateStore(home)
  const onApplied: ApplyPlanResult[] = []

  registerPacksPlanIpc(handle, {
    resolver: {
      async resolve(id, _range, source): Promise<ResolvedCandidate | null> {
        return {
          id,
          version: '1.0.0',
          download: { kind: 'url', url: `https://x.example/${id}.zip`, sha256: 'a'.repeat(64) },
          source,
          originLabel: 'x.example'
        }
      }
    },
    download: async () => {
      throw new Error('not used by the fixed single-pack plan in this test file')
    },
    gh: unusedGh(),
    packsState,
    argusHome: home,
    tempRoot,
    install: async (source): Promise<InstallResult> => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(source, 'argus-pack.json'), 'utf8')
      ) as { id: string; version: string }
      opts.installCalls.push(manifest.id)
      if (opts.installDelayMs) await new Promise((r) => setTimeout(r, opts.installDelayMs))
      return {
        ok: true,
        id: manifest.id,
        version: manifest.version,
        previousVersion: null,
        relaunchRequired: true
      }
    },
    onApplied: (res) => onApplied.push(res)
  })

  return { handlers, onApplied }
}

/** For the bundle-path harnesses, which never reach `packs:plan-repo` — see its own describe. */
function unusedGh(): GhClient {
  const refuse = (): never => {
    throw new Error('the repo path is exercised in the packs:plan-repo describe, not here')
  }
  return { api: async () => refuse(), downloadAsset: async () => refuse() }
}

/** Stages the fixed single-pack ('maps', no deps) plan via the registered plan handler. */
async function stage(handlers: Map<string, (...args: never[]) => unknown>): Promise<PlanResult> {
  const planFn = handlers.get('packs:plan-bundle') as (
    e: unknown,
    source: string
  ) => Promise<PlanResult>
  return planFn(undefined, bundleSrc)
}

describe('registerPacksPlanIpc', () => {
  it('registers every plan channel', () => {
    const { handlers } = harness({ installCalls: [] })
    expect([...handlers.keys()].sort()).toEqual([
      'packs:apply-plan',
      'packs:plan-bundle',
      'packs:plan-repo'
    ])
  })

  it('stages then applies a plan, installing the staged pack exactly once', async () => {
    const installCalls: string[] = []
    const { handlers, onApplied } = harness({ installCalls })
    const planned = await stage(handlers)
    expect(planned.ok).toBe(true)

    const applyFn = handlers.get('packs:apply-plan') as () => Promise<ApplyPlanResult>
    const res = await applyFn()
    expect(res.installed.map((p) => p.id)).toEqual(['maps'])
    expect(installCalls).toEqual(['maps'])
    expect(onApplied).toHaveLength(1)
    expect(onApplied[0].installed.map((p) => p.id)).toEqual(['maps'])
  })

  it('a double-invocation of packsApplyPlan cannot double-install (the capture-and-clear race)', async () => {
    const installCalls: string[] = []
    // A small delay on the install call widens the race window: without the capture-and-clear
    // fix, a second call arriving before the first's `install()` resolves would see the same
    // staged plan and install it again.
    const { handlers } = harness({ installCalls, installDelayMs: 5 })
    const planned = await stage(handlers)
    expect(planned.ok).toBe(true)

    const applyFn = handlers.get('packs:apply-plan') as () => Promise<ApplyPlanResult>
    // Fire both synchronously, matching a double-clicked button dispatching two IPC calls before
    // either handler invocation has run past its first await.
    const [first, second] = await Promise.all([applyFn(), applyFn()])

    const results = [first, second].sort((a, b) => a.installed.length - b.installed.length)
    // One call gets "no plan staged" (the plan was already claimed and cleared); the other
    // installs it. Neither call may install it twice, and the pack must not be installed twice
    // in total.
    expect(results[0]).toMatchObject({
      installed: [],
      failed: { id: '', error: 'no plan staged' }
    })
    expect(results[1].installed.map((p) => p.id)).toEqual(['maps'])
    expect(installCalls).toEqual(['maps'])
  })

  it('creates a fresh per-plan cache directory and removes it once the plan is applied', async () => {
    const { handlers } = harness({ installCalls: [] })
    const before = fs.readdirSync(tempRoot)
    await stage(handlers)
    const afterStage = fs.readdirSync(tempRoot).filter((n) => !before.includes(n))
    expect(afterStage).toHaveLength(1) // exactly one mkdtemp'd staging dir created

    const applyFn = handlers.get('packs:apply-plan') as () => Promise<ApplyPlanResult>
    await applyFn()
    const afterApply = fs.readdirSync(tempRoot).filter((n) => !before.includes(n))
    expect(afterApply).toHaveLength(0) // removed once applied
  })

  it('removes the previous cache directory when a new plan supersedes it', async () => {
    const { handlers } = harness({ installCalls: [] })
    const before = fs.readdirSync(tempRoot)
    await stage(handlers)
    const afterFirst = fs.readdirSync(tempRoot).filter((n) => !before.includes(n))
    expect(afterFirst).toHaveLength(1)

    await stage(handlers) // a second plan, before the first was ever applied
    const afterSecond = fs.readdirSync(tempRoot).filter((n) => !before.includes(n))
    expect(afterSecond).toHaveLength(1) // the first plan's directory was cleaned up, not left behind
    expect(afterSecond[0]).not.toBe(afterFirst[0])
  })

  it('removes the cache directory when the plan is refused', async () => {
    const { handlers } = harness({ installCalls: [] })
    // A dependency declared as a bare string (no updateUrl/updateRepo) has no source to install
    // from, which `stagePlan` refuses with code 'unresolvable' — a real refusal, not a thrown
    // manifest-parse error, so `inspectBundleSource` still succeeds and only `stagePlan` fails.
    fs.writeFileSync(
      path.join(bundleSrc, 'argus-pack.json'),
      JSON.stringify({
        id: 'maps',
        displayName: 'maps',
        version: '2.0.0',
        argusApi: '^1',
        dependencies: { common: '^1.0.0' }
      })
    )
    const before = fs.readdirSync(tempRoot)
    const planned = await stage(handlers)
    expect(planned).toMatchObject({ ok: false, code: 'unresolvable' })
    const after = fs.readdirSync(tempRoot).filter((n) => !before.includes(n))
    expect(after).toHaveLength(0)
  })

  it(
    'resolves an already-installed dependency from its own recorded pin, never from the ' +
      "dependent bundle's declared source (the `pins` wiring planIpc.ts builds for stagePlan's " +
      'security check — see the comment on `PlannerDeps.pins` in depPlanner.ts)',
    async () => {
      // 'common' is already installed and pinned to a trusted source.
      const packsState = new PacksStateStore(home)
      packsState.set('common', '1.2.0')
      const trustedPin: DeclaredSource & { installedAt: number } = {
        kind: 'feed',
        updateUrl: 'https://trusted.example/feed.json',
        origin: 'https://trusted.example',
        installedAt: Date.now()
      }
      packsState.setSource('common', trustedPin)

      // The root bundle declares a dependency on 'common' at a range the installed 1.2.0 does not
      // satisfy (forcing a re-resolve), with a source pointing at a hostile origin. If `pins`
      // wiring is dropped (e.g. `pins: {}`), that hostile source is what the resolver would see.
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-planipc-root-'))
      fs.writeFileSync(
        path.join(rootDir, 'argus-pack.json'),
        JSON.stringify({
          id: 'root',
          displayName: 'root',
          version: '1.0.0',
          argusApi: '^1',
          dependencies: {
            common: { range: '^2.0.0', updateUrl: 'https://attacker.example/evil-feed.json' }
          }
        })
      )

      const resolvedFrom: (DeclaredSource | null)[] = []
      const handlers = new Map<string, (...args: never[]) => unknown>()
      const handle: HandleFn = (channel, fn) => void handlers.set(channel, fn as never)

      registerPacksPlanIpc(handle, {
        resolver: {
          async resolve(id, _range, source): Promise<ResolvedCandidate | null> {
            resolvedFrom.push(source)
            return {
              id,
              version: '2.0.0',
              download: { kind: 'url', url: `https://x.example/${id}.zip`, sha256: 'a'.repeat(64) },
              source,
              originLabel: 'x.example'
            }
          }
        },
        download: async (candidate, destPath) => {
          // A directory stands in for a downloaded bundle: `inspectBundleSource` (called next, via
          // `deps.inspect`) accepts either a zip or a directory.
          fs.mkdirSync(destPath, { recursive: true })
          fs.writeFileSync(
            path.join(destPath, 'argus-pack.json'),
            JSON.stringify({
              id: candidate.id,
              displayName: candidate.id,
              version: candidate.version,
              argusApi: '^1'
            })
          )
        },
        gh: unusedGh(),
        packsState,
        argusHome: home,
        tempRoot,
        onApplied: () => {}
      })

      const planFn = handlers.get('packs:plan-bundle') as (
        e: unknown,
        source: string
      ) => Promise<PlanResult>
      const planned = await planFn(undefined, rootDir)

      expect(planned.ok).toBe(true)
      // The resolver must have been asked to resolve 'common' from the trusted pin, never from the
      // hostile source the root manifest declared.
      expect(resolvedFrom).toEqual([
        {
          kind: 'feed',
          updateUrl: 'https://trusted.example/feed.json',
          origin: 'https://trusted.example'
        }
      ])

      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  )
})

// — the GitHub entry point —
//
// The defect these cover: installing from a repository called `installPack` directly, so a pack
// arriving that way never had its dependencies resolved and was simply refused with
// "requires <id>". They drive the repo install through the SAME staging slot the local-bundle
// picker uses, so one `packs:apply-plan` serves both.

const REPO_REF = 'github.com/LucentMind/demo_pack'

/** A real zip of a real manifest: `planIpc.ts` uses the real `inspectBundleSource`. */
async function zipOfManifest(manifest: Record<string, unknown>): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-planipc-gh-'))
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest, null, 2))
  const out = path.join(dir, 'bundle.zip')
  const zip = new Zip()
  zip.addFile(path.join(dir, 'argus-pack.json'), 'argus-pack.json')
  await zip.archive(out)
  const bytes = fs.readFileSync(out)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}

/** A repo publishing one release of `maps`, whose bundle is `bytes`. */
function ghFor(bytes: Buffer, manifestJson: Record<string, unknown>): GhClient {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')
  return {
    api: async (_ref, p) => {
      if (p === 'repos/LucentMind/demo_pack') return { full_name: 'LucentMind/demo_pack' }
      if (p.includes('/contents/')) {
        return { content: Buffer.from(JSON.stringify(manifestJson)).toString('base64') }
      }
      if (p.includes('/git/trees/')) {
        return { tree: [{ path: 'packs/maps/argus-pack.json', type: 'blob' }] }
      }
      if (p.startsWith('repos/LucentMind/demo_pack/releases')) {
        return [
          {
            tag_name: 'v2.0.0',
            draft: false,
            prerelease: false,
            html_url: 'https://github.com/LucentMind/demo_pack/releases/tag/v2.0.0',
            assets: [
              {
                name: 'maps-2.0.0-win-x64.zip',
                size: bytes.length,
                digest: `sha256:${sha}`,
                browser_download_url: 'https://github.com/x/y/releases/download/v2.0.0/maps.zip'
              }
            ]
          }
        ]
      }
      throw new GhError('notfound', p)
    },
    downloadAsset: async (_r, _t, _n, dest) => {
      fs.writeFileSync(dest, bytes)
      return { sha256: sha, bytesWritten: bytes.length }
    }
  }
}

describe('packs:plan-repo', () => {
  const WIN = { platform: 'win32', arch: 'x64' }

  /** Registers the IPC with a repo publishing `maps@2.0.0` carrying `dependencies`. */
  async function repoHarness(dependencies: Record<string, unknown>): Promise<{
    handlers: Map<string, (...args: never[]) => unknown>
    packsState: PacksStateStore
    installArgs: Array<{ id: string; pinOverride: unknown }>
  }> {
    const manifest = {
      id: 'maps',
      displayName: 'maps',
      version: '2.0.0',
      argusApi: '^1',
      platform: 'win-x64',
      dependencies
    }
    const bytes = await zipOfManifest(manifest)
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const handle: HandleFn = (channel, fn) => void handlers.set(channel, fn as never)
    const packsState = new PacksStateStore(home)
    const installArgs: Array<{ id: string; pinOverride: unknown }> = []

    registerPacksPlanIpc(handle, {
      resolver: {
        async resolve(id, _range, source): Promise<ResolvedCandidate | null> {
          return {
            id,
            version: '1.5.0',
            download: { kind: 'url', url: `https://x.example/${id}.zip`, sha256: 'a'.repeat(64) },
            source,
            originLabel: 'x.example'
          }
        }
      },
      download: async (candidate, destPath) => {
        // A directory stands in for a downloaded bundle, as in the pins test above.
        fs.mkdirSync(destPath, { recursive: true })
        fs.writeFileSync(
          path.join(destPath, 'argus-pack.json'),
          JSON.stringify({
            id: candidate.id,
            displayName: candidate.id,
            version: candidate.version,
            argusApi: '^1'
          })
        )
      },
      gh: ghFor(bytes, manifest),
      host: WIN,
      packsState,
      argusHome: home,
      tempRoot,
      install: async (source, opts): Promise<InstallResult> => {
        const id = fs.statSync(source).isDirectory()
          ? (
              JSON.parse(fs.readFileSync(path.join(source, 'argus-pack.json'), 'utf8')) as {
                id: string
              }
            ).id
          : 'maps'
        installArgs.push({ id, pinOverride: opts.pinOverride })
        return { ok: true, id, version: '2.0.0', previousVersion: null, relaunchRequired: true }
      },
      onApplied: () => {}
    })
    return { handlers, packsState, installArgs }
  }

  function planRepo(handlers: Map<string, (...args: never[]) => unknown>): Promise<PlanResult> {
    const fn = handlers.get('packs:plan-repo') as (
      e: unknown,
      ref: string,
      packId: string
    ) => Promise<PlanResult>
    return fn(undefined, REPO_REF, 'maps')
  }

  /** The reported bug, end to end: a repo pack that declares a sourced dependency. */
  it('resolves a dependency declared by a repo-installed pack instead of refusing it', async () => {
    const { handlers } = await repoHarness({
      common: { range: '^1.0.0', updateRepo: 'LucentMind/demo_pack' }
    })
    const planned = await planRepo(handlers)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.packs.map((p) => p.id)).toEqual(['common', 'maps'])
    expect(planned.packs.find((p) => p.id === 'maps')?.isRoot).toBe(true)
    expect(planned.packs.find((p) => p.id === 'common')?.version).toBe('1.5.0')
  })

  it('applies the repo plan, pinning the root to the repo the bytes came from', async () => {
    const { handlers, installArgs } = await repoHarness({
      common: { range: '^1.0.0', updateRepo: 'LucentMind/demo_pack' }
    })
    expect((await planRepo(handlers)).ok).toBe(true)
    const applyFn = handlers.get('packs:apply-plan') as () => Promise<ApplyPlanResult>
    const res = await applyFn()
    expect(res.failed).toBeNull()
    expect(installArgs.map((a) => a.id)).toEqual(['common', 'maps'])
    expect(installArgs[1].pinOverride).toMatchObject({
      kind: 'github',
      owner: 'LucentMind',
      repo: 'demo_pack',
      manifestPath: 'packs/maps/argus-pack.json'
    })
  })

  /**
   * Choosing a pack from a repository is the documented way to re-point a feed-installed pack at
   * that repo. `applyPlan` otherwise prefers an existing pin, which would silently discard it.
   */
  it('re-points an already feed-pinned pack at the chosen repo', async () => {
    const { handlers, packsState, installArgs } = await repoHarness({})
    packsState.set('maps', '1.0.0')
    packsState.setSource('maps', {
      kind: 'feed',
      updateUrl: 'https://old.example/feed.json',
      origin: 'https://old.example',
      installedAt: 1
    })
    expect((await planRepo(handlers)).ok).toBe(true)
    const applyFn = handlers.get('packs:apply-plan') as () => Promise<ApplyPlanResult>
    await applyFn()
    expect(installArgs[0].pinOverride).toMatchObject({ kind: 'github', repo: 'demo_pack' })
  })

  it('reports a staging refusal as a plan refusal and leaves no cache directory', async () => {
    const { handlers } = await repoHarness({})
    const before = fs.readdirSync(tempRoot)
    const fn = handlers.get('packs:plan-repo') as (
      e: unknown,
      ref: string,
      packId: string
    ) => Promise<PlanResult>
    const planned = await fn(undefined, REPO_REF, 'not-published-here')
    expect(planned).toMatchObject({ ok: false, code: 'bundle' })
    expect(fs.readdirSync(tempRoot).filter((n) => !before.includes(n))).toHaveLength(0)
  })

  it('refuses an unparseable repository reference without staging anything', async () => {
    const { handlers } = await repoHarness({})
    const fn = handlers.get('packs:plan-repo') as (
      e: unknown,
      ref: string,
      packId: string
    ) => Promise<PlanResult>
    const planned = await fn(undefined, 'not a repo', 'maps')
    expect(planned).toMatchObject({ ok: false, code: 'bundle' })
  })
})
