import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  graphsRoot,
  repoIdFor,
  scopeKeyFor,
  graphCacheDir,
  readMeta,
  writeMeta,
  parseExtractCounts,
  type GraphMeta
} from '../codeGraph'

describe('codeGraph helpers', () => {
  it('graphsRoot is <argusHome>/graphs', () => {
    expect(graphsRoot('C:\\home')).toBe(path.join('C:\\home', 'graphs'))
  })

  it('repoIdFor slugs the remote owner/name when a remote exists', () => {
    expect(repoIdFor('C:\\code\\hivemindtest', 'https://github.com/JiaweiHan88/hivemindtest.git')).toBe(
      'JiaweiHan88-hivemindtest'
    )
    expect(repoIdFor('/x/y', 'git@github.com:Org/My.Repo.git')).toBe('org-my-repo')
  })

  it('repoIdFor without remote uses basename + stable path hash', () => {
    const a = repoIdFor('C:\\code\\navigator', null)
    const b = repoIdFor('C:\\code\\navigator', null)
    const c = repoIdFor('C:\\other\\navigator', null)
    expect(a).toBe(b)
    expect(a).toMatch(/^navigator-[0-9a-f]{8}$/)
    expect(a).not.toBe(c)
  })

  it('scopeKeyFor maps null to _root and slugs subpaths', () => {
    expect(scopeKeyFor(null)).toBe('_root')
    expect(scopeKeyFor('src/routing')).toBe('src-routing')
    expect(scopeKeyFor('src\\routing\\')).toBe('src-routing')
  })

  it('scopeKeyFor rejects escaping or absolute scopes', () => {
    expect(() => scopeKeyFor('../secrets')).toThrow()
    expect(() => scopeKeyFor('C:\\windows')).toThrow()
    expect(() => scopeKeyFor('/etc')).toThrow()
    expect(() => scopeKeyFor('  ')).toThrow()
  })

  it('meta round-trips through the cache dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-graph-'))
    expect(readMeta(dir)).toBeNull()
    const meta: GraphMeta = {
      commit: 'abc123',
      branch: 'main',
      scope: null,
      builtAt: new Date().toISOString(),
      graphifyVersion: 'graphify 0.9.12',
      nodeCount: 9171,
      edgeCount: 31372,
      status: 'ok'
    }
    writeMeta(dir, meta)
    expect(readMeta(dir)).toEqual(meta)
  })

  it('readMeta returns null on corrupt json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-graph-'))
    fs.writeFileSync(path.join(dir, 'meta.json'), '{nope')
    expect(readMeta(dir)).toBeNull()
  })

  it('parseExtractCounts reads the graphify summary line', () => {
    const out = '[graphify extract] wrote C:\\x\\graphify-out\\graph.json: 9171 nodes, 31372 edges, 304 communities'
    expect(parseExtractCounts(out)).toEqual({ nodes: 9171, edges: 31372 })
    expect(parseExtractCounts('no summary here')).toEqual({ nodes: null, edges: null })
  })
})
