import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { searchEvidence } from '../../search'
import { applyMemoryWrite, filteredIndex, readAudit } from '../../memory'
import { classifyToolCall } from '../risk'
import { materializeSessionSkills } from '../skillsResolver'
import { seedMemoryPair } from '../../__tests__/helpers/seedMemoryPair'
import { agentAccessSchema, defaultAgentAccess } from '../../../../shared/agentAccess'
import { caseDir } from '../../paths'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imem-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('memory compounding mechanics (spec §1.6)', () => {
  it('the fixture pair shares the defect signature across both cases (cross-case FTS)', () => {
    seedMemoryPair(db, argusHome)
    const hits = searchEvidence(db, 'BLOCKED_VERSION')
    const slugs = new Set(hits.map((h) => h.caseSlug))
    expect(slugs).toEqual(new Set(['NAV-100', 'NAV-200']))
  })

  it('case A writes a lesson (MEDIUM-gated); case B sees it unless the topic is disabled', async () => {
    seedMemoryPair(db, argusHome)

    // the write is classified MEDIUM ask
    const verdict = classifyToolCall(
      'mcp__argus__write_memory',
      { topic: 'data-version-blocks', content: 'x' },
      { caseDir: caseDir(argusHome, 'NAV-100'), workspaceRoots: [], readonlyRoots: [] }
    )
    expect(verdict).toMatchObject({ action: 'ask', risk: 'MEDIUM' })

    // approved write lands via the handler backend
    applyMemoryWrite(argusHome, 'NAV-100', {
      topic: 'data-version-blocks',
      content: 'BLOCKED_VERSION → check the dataVersion allowlist before quota/network.',
      indexEntry: 'BLOCKED_VERSION tile region rejections'
    })
    expect(readAudit(argusHome, 10)[0]).toMatchObject({
      caseSlug: 'NAV-100',
      topic: 'data-version-blocks'
    })

    // case B's injectable index contains the lesson…
    expect(filteredIndex(argusHome, defaultAgentAccess())).toContain('(data-version-blocks.md)')
    // …until the topic is disabled in agent-access
    const disabled = agentAccessSchema.parse({ memory: { 'data-version-blocks': false } })
    expect(filteredIndex(argusHome, disabled)).not.toContain('(data-version-blocks.md)')
  })

  it('disabled skills are not materialized into a case session', () => {
    seedMemoryPair(db, argusHome)
    const skillRoot = path.join(argusHome, 'skills', 'analyze-applog')
    fs.mkdirSync(skillRoot, { recursive: true })
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: analyze-applog\ndescription: d\n---\n'
    )
    const access = agentAccessSchema.parse({ skills: { 'bundled/analyze-applog': false } })
    materializeSessionSkills(argusHome, 'NAV-200', access)
    const linkDir = path.join(caseDir(argusHome, 'NAV-200'), '.claude', 'skills')
    expect(fs.readdirSync(linkDir)).not.toContain('analyze-applog')
  })
})
