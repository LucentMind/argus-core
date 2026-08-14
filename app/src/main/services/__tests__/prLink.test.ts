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
  it('the manual (string) path also materializes and broadcasts', async () => {
    // Was "no materialize, no broadcast" — deliberately inverted (fix wave, one-PR-per-case).
    // addBinding now REPLACES the case's binding instead of only ever adding one, so skipping
    // materialize on the manual path would leave the `argus:prs` region of CLAUDE.md (written
    // by materializePrBindings) still naming a PR that is no longer bound. The manual path pays
    // the same lazy, never-fatal fetch the picker path already pays.
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const materialize = vi.fn(async () => '/wt/acme-widget-42')
    const broadcast = vi.fn()
    const { binding, materialized } = await linkPrForCase(
      deps({ materialize, broadcast }),
      'c1',
      'https://github.com/acme/widget/pull/42'
    )
    expect(binding.number).toBe(42)
    expect(binding.source).toBe('manual')
    expect(getBinding(db, 'c1')?.number).toBe(42)
    await materialized
    expect(materialize).toHaveBeenCalledTimes(1)
    // Twice by design — the committed binding, then the landed worktree. See linkPrForCase.
    expect(broadcast.mock.calls).toEqual([['c1'], ['c1']])
  })

  it('a PrRef input materializes the worktree and broadcasts the change', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const materialize = vi.fn(async () => '/wt/acme-widget-42')
    const broadcast = vi.fn()
    const { binding, materialized } = await linkPrForCase(deps({ materialize, broadcast }), 'c1', {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
    expect(binding.number).toBe(42)
    expect(binding.source).toBe('search')
    await materialized
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls).toEqual([['c1'], ['c1']])
  })

  /**
   * The defect this whole change exists for: `pr:link` used to await the checkout, so
   * `PrPickerDialog` — which closes on it resolving and locks its own Escape/✕/backdrop and
   * both buttons while it is in flight — stayed up, inert and silent, for the length of a
   * `git fetch` + `git worktree add`. A never-settling materializer stands in for the cold
   * fetch: if the binding is ever put behind it again, this hangs instead of failing loudly,
   * so it is bounded by the runner's own timeout rather than left to hang forever.
   */
  it('returns the binding without waiting for the checkout', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const broadcast = vi.fn()
    const binding = await Promise.race([
      linkPrForCase(
        deps({ materialize: () => new Promise<string>(() => {}), broadcast }),
        'c1',
        'https://github.com/acme/widget/pull/42'
      ).then((r) => r.binding),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pr:link awaited the checkout')), 2000)
      )
    ])
    expect(binding.number).toBe(42)
    // The binding is committed and announced even though the worktree will never exist.
    expect(getBinding(db, 'c1')?.number).toBe(42)
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('c1')
  })

  /** materializePrBindings swallows its own failures, but a caller must survive one that
   *  escapes anyway — `materialized` is chained onto in main and must never reject. */
  it('a throwing materializer does not reject the link or its materialized handle', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const { binding, materialized } = await linkPrForCase(
      deps({
        materialize: () => {
          throw new Error('git exploded')
        }
      }),
      'c1',
      'https://github.com/acme/widget/pull/42'
    )
    expect(binding.number).toBe(42)
    await expect(materialized).resolves.toBeUndefined()
  })

  it('resolves repoPath to the linked remote that matches the PR owner/repo', async () => {
    linkWorkspace('https://github.com/acme/widget.git', '/tmp/repo-a')
    const { binding } = await linkPrForCase(deps(), 'c1', {
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
    expect(binding.repoPath).toBe('/tmp/repo-a')
  })

  it('leaves repoPath null when no linked remote matches the PR owner/repo', async () => {
    linkWorkspace('https://github.com/other/thing.git', '/tmp/repo-a')
    const { binding } = await linkPrForCase(deps(), 'c1', {
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
