import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { getBinding } from '../prBindings'
import { linkPrForCase, type LinkPrForCaseDeps } from '../prLink'

let db: DatabaseSync
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prlink-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

function linkWorkspace(remote: string | null, repoPath = '/tmp/repo-a'): void {
  db.prepare(`UPDATE cases SET workspaces = ? WHERE slug = ?`).run(
    JSON.stringify([{ path: repoPath, remote, branch: 'main' }]),
    'c1'
  )
}

function deps(over: Partial<LinkPrForCaseDeps> = {}): LinkPrForCaseDeps {
  return {
    db,
    argusHome: home,
    materialize: vi.fn(async () => '/wt/acme-widget-42'),
    broadcast: vi.fn(),
    ...over
  }
}

describe('linkPrForCase', () => {
  it('takes the manual path for a string input: no materialize, no broadcast', async () => {
    const materialize = vi.fn(async () => '/wt/acme-widget-42')
    const broadcast = vi.fn()
    const binding = await linkPrForCase(
      deps({ materialize, broadcast }),
      'c1',
      'https://github.com/acme/widget/pull/42'
    )
    expect(binding.number).toBe(42)
    expect(binding.source).toBe('manual')
    expect(materialize).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(getBinding(db, 'c1')?.number).toBe(42)
  })

  it('a PrRef input materializes the worktree and broadcasts the change', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const materialize = vi.fn(async () => '/wt/acme-widget-42')
    const broadcast = vi.fn()
    const binding = await linkPrForCase(deps({ materialize, broadcast }), 'c1', {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
    expect(binding.number).toBe(42)
    expect(binding.source).toBe('search')
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('c1')
  })

  it('resolves repoPath to the linked remote that matches the PR owner/repo', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const binding = await linkPrForCase(deps(), 'c1', {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
    expect(binding.repoPath).toBe('/tmp/repo-a')
  })

  it('leaves repoPath null when no linked remote matches the PR owner/repo', async () => {
    linkWorkspace('https://github.com/other/thing.git', '/tmp/repo-a')
    const binding = await linkPrForCase(deps(), 'c1', {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
    expect(binding.repoPath).toBeNull()
  })

  it('rejects an unknown case slug', async () => {
    await expect(
      linkPrForCase(deps(), 'no-such-case', 'https://github.com/acme/widget/pull/42')
    ).rejects.toThrow(/unknown case/i)
  })
})
