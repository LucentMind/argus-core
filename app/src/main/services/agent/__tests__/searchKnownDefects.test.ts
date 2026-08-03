import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers, NATIVE_TOOL_SPECS, resolveToolSpecs } from '../nativeTools'
import { classifyToolCall, CLAUDE_TOOL_TAXONOMY, type RiskContext } from '../risk'
import type { CorpusSearchHit } from '../../defectCorpus/client'
import type { SourceSearchResult } from '../../defectCorpus/service'

let tmp: string
let argusHome: string
let db: DatabaseSync
const emitFinding = vi.fn()
const detection = createDetection()

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    caseDir: '/home/u/Argus/cases/old',
    workspaceRoots: [],
    readonlyRoots: [],
    taxonomy: CLAUDE_TOOL_TAXONOMY,
    ...overrides
  }
}

function baseRecord(overrides: Partial<CorpusSearchHit['record']> = {}): CorpusSearchHit['record'] {
  return {
    key: 'PROJ-1',
    url: 'https://jira.example.com/browse/PROJ-1',
    project: 'PROJ',
    summary: 'Widget crashes on startup',
    description: 'd',
    status: 'Closed',
    resolution: 'Fixed',
    components: [],
    labels: [],
    affectsVersions: [],
    fixVersions: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    resolvedAt: '2024-01-02T00:00:00Z',
    links: [],
    commentCount: 0,
    distilled: null,
    ...overrides
  }
}

function hit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    key: 'PROJ-1',
    url: 'https://jira.example.com/browse/PROJ-1',
    score: 0.9,
    matchedOn: 'lexical',
    snippet: 's',
    record: baseRecord(),
    ...overrides
  }
}

beforeEach(() => {
  emitFinding.mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-skd-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'new-case', title: 'A case' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('search_known_defects', () => {
  it('formats grouped output across sources, one failing', async () => {
    const results: SourceSearchResult[] = [
      {
        sourceId: 'alpha',
        sourceName: 'Alpha Corpus',
        ok: true,
        hits: [
          hit(),
          hit({
            key: 'PROJ-2',
            url: 'https://jira.example.com/browse/PROJ-2',
            matchedOn: 'semantic',
            record: baseRecord({
              key: 'PROJ-2',
              url: 'https://jira.example.com/browse/PROJ-2',
              summary: 'Widget hangs on shutdown',
              status: 'Closed',
              resolution: null,
              distilled: {
                signature: 'shutdown deadlock in widget manager',
                symptoms: 's',
                rootCause: 'r',
                fix: 'Release the lock before teardown',
                errorStrings: [],
                distilledAt: '2024-01-03T00:00:00Z'
              }
            })
          })
        ]
      },
      {
        sourceId: 'beta',
        sourceName: 'Beta Corpus',
        ok: false,
        error: 'unreachable',
        hits: []
      }
    ]
    const searchAll = vi.fn().mockResolvedValue(results)
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    const text = String(await handlers.search_known_defects({ query: 'widget crash' }))

    expect(searchAll).toHaveBeenCalledWith({ query: 'widget crash' })
    expect(text).toContain('## Alpha Corpus')
    expect(text).toContain(
      '- PROJ-1 [lexical] Widget crashes on startup (Closed/Fixed) — https://jira.example.com/browse/PROJ-1'
    )
    expect(text).toContain(
      '- PROJ-2 [semantic] Widget hangs on shutdown (Closed/open) — https://jira.example.com/browse/PROJ-2'
    )
    expect(text).toContain('signature: shutdown deadlock in widget manager')
    expect(text).toContain('fix: Release the lock before teardown')
    expect(text).toContain('## Beta Corpus: unavailable (unreachable)')
  })

  it('passes limit through to searchAll when provided', async () => {
    const searchAll = vi.fn().mockResolvedValue([])
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    await handlers.search_known_defects({ query: 'q', limit: 5 })
    expect(searchAll).toHaveBeenCalledWith({ query: 'q', limit: 5 })
  })

  it('no defectCorpus dep at all -> no-sources feedback', async () => {
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding
    })
    const text = String(await handlers.search_known_defects({ query: 'q' }))
    expect(text).toBe(
      'No defect-corpus sources are configured. The user can add one under Settings → Defect corpus.'
    )
  })

  it('no enabled sources (searchAll resolves []) -> same no-sources feedback', async () => {
    const searchAll = vi.fn().mockResolvedValue([])
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    const text = String(await handlers.search_known_defects({ query: 'q' }))
    expect(text).toBe(
      'No defect-corpus sources are configured. The user can add one under Settings → Defect corpus.'
    )
  })

  it('zero hits across all-live sources -> empty feedback', async () => {
    const searchAll = vi
      .fn()
      .mockResolvedValue([
        { sourceId: 'alpha', sourceName: 'Alpha Corpus', ok: true, hits: [] }
      ] as SourceSearchResult[])
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    const text = String(await handlers.search_known_defects({ query: 'q' }))
    expect(text).toBe('No similar known defects found.')
  })

  it('distilled.fix null renders the "none recorded" fallback with real indentation', async () => {
    const results: SourceSearchResult[] = [
      {
        sourceId: 'alpha',
        sourceName: 'Alpha Corpus',
        ok: true,
        hits: [
          hit({
            record: baseRecord({
              distilled: {
                signature: 'shutdown deadlock in widget manager',
                symptoms: 's',
                rootCause: 'r',
                fix: null,
                errorStrings: [],
                distilledAt: '2024-01-03T00:00:00Z'
              }
            })
          })
        ]
      }
    ]
    const searchAll = vi.fn().mockResolvedValue(results)
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    const text = String(await handlers.search_known_defects({ query: 'widget crash' }))
    expect(text.split('\n')).toContain('  fix: none recorded')
  })

  it('a failing source alongside a zero-hit live source renders the unavailable line, not the empty feedback', async () => {
    const results: SourceSearchResult[] = [
      { sourceId: 'alpha', sourceName: 'Alpha Corpus', ok: true, hits: [] },
      { sourceId: 'beta', sourceName: 'Beta Corpus', ok: false, error: 'unreachable', hits: [] }
    ]
    const searchAll = vi.fn().mockResolvedValue(results)
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      defectCorpus: { searchAll }
    })
    const text = String(await handlers.search_known_defects({ query: 'q' }))
    expect(text).toContain('## Beta Corpus: unavailable (unreachable)')
    expect(text).not.toContain('No similar known defects found.')
  })

  it('is classified LOW/allow', () => {
    const v = classifyToolCall('mcp__argus__search_known_defects', {}, ctx())
    expect(v).toMatchObject({ action: 'allow', risk: 'LOW' })
  })

  it('is present in NATIVE_TOOL_SPECS with the exact description', () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'search_known_defects')
    expect(spec).toBeDefined()
    expect(spec?.description).toBe(
      "Search the team's external known-defects corpus (past Jira tickets with resolutions and duplicate links) for defects similar to the query. Returns matches grouped by source with ticket keys, URLs, resolutions, and distilled root-cause info when available."
    )
    const resolved = resolveToolSpecs()
    expect(resolved.some((s) => s.name === 'search_known_defects')).toBe(true)
  })
})
