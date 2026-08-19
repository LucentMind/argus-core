import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import {
  assetReviewState,
  copySkillAssetReviews,
  dropSkillAssetReviews,
  recordAssetReviews,
  sha256Hex
} from '../skillAssetReviews'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-asset-reviews-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const script = '#!/bin/sh\necho hi\n'

describe('assetReviewState', () => {
  it('is unreviewed with no row', () => {
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', script)).toBe('unreviewed')
  })

  it('is reviewed when the content hash matches', () => {
    recordAssetReviews(db, 'collect-logs', [{ relPath: 'scripts/collect.sh', content: script }], {
      origin: 'proposal',
      reviewedBy: 'Jiawei Han'
    })
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', script)).toBe('reviewed')
  })

  it('is changed when the bytes differ from the reviewed row', () => {
    recordAssetReviews(db, 'collect-logs', [{ relPath: 'scripts/collect.sh', content: script }], {
      origin: 'proposal',
      reviewedBy: null
    })
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', `${script}rm -rf /\n`)).toBe(
      'changed'
    )
  })

  it('does not match a row belonging to another skill', () => {
    recordAssetReviews(db, 'other-skill', [{ relPath: 'scripts/collect.sh', content: script }], {
      origin: 'proposal',
      reviewedBy: null
    })
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', script)).toBe('unreviewed')
  })
})

describe('recordAssetReviews', () => {
  it('replaces the row for a path rather than accumulating rows', () => {
    const opts = { origin: 'editor' as const, reviewedBy: null }
    recordAssetReviews(db, 's', [{ relPath: 'a.sh', content: 'one' }], opts)
    recordAssetReviews(db, 's', [{ relPath: 'a.sh', content: 'two' }], opts)
    const rows = db.prepare(`SELECT sha256 FROM skill_asset_reviews WHERE skill = 's'`).all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as { sha256: string }).sha256).toBe(sha256Hex('two'))
  })

  it('records only the assets it was given', () => {
    recordAssetReviews(db, 's', [{ relPath: 'a.sh', content: 'x' }], {
      origin: 'proposal',
      reviewedBy: null
    })
    expect(assetReviewState(db, 's', 'b.sh', 'x')).toBe('unreviewed')
  })
})

describe('dropSkillAssetReviews / copySkillAssetReviews', () => {
  it('drop removes every row for one skill only', () => {
    const opts = { origin: 'proposal' as const, reviewedBy: null }
    recordAssetReviews(db, 'a', [{ relPath: 'x.sh', content: 'x' }], opts)
    recordAssetReviews(db, 'b', [{ relPath: 'x.sh', content: 'x' }], opts)
    dropSkillAssetReviews(db, 'a')
    expect(assetReviewState(db, 'a', 'x.sh', 'x')).toBe('unreviewed')
    expect(assetReviewState(db, 'b', 'x.sh', 'x')).toBe('reviewed')
  })

  it('copy carries the reviewed state to a new skill name', () => {
    recordAssetReviews(db, 'a', [{ relPath: 'x.sh', content: 'x' }], {
      origin: 'proposal',
      reviewedBy: null
    })
    copySkillAssetReviews(db, 'a', 'a-fork')
    expect(assetReviewState(db, 'a-fork', 'x.sh', 'x')).toBe('reviewed')
  })

  it('copy replaces any rows the destination already had', () => {
    const opts = { origin: 'proposal' as const, reviewedBy: null }
    recordAssetReviews(db, 'a', [{ relPath: 'x.sh', content: 'new' }], opts)
    recordAssetReviews(db, 'dst', [{ relPath: 'x.sh', content: 'old' }], opts)
    copySkillAssetReviews(db, 'a', 'dst')
    expect(assetReviewState(db, 'dst', 'x.sh', 'new')).toBe('reviewed')
  })
})
