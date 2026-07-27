import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { reviewSubagentSupport, driverForSession, resolveReviewFraming } from '../reviewFraming'
import type { AgentDriver, DriverSession } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { SubagentSupport } from '../../../../shared/drivers'

function stubDriver(kind: string, subagents: SubagentSupport): AgentDriver {
  return {
    kind: kind as AgentDriver['kind'],
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents
    },
    createSession(): DriverSession {
      throw new Error('not used in these tests')
    },
    probeAuth: async () => ({ ok: true, detail: '' })
  }
}

describe('reviewSubagentSupport', () => {
  it('is configurable only when both review mode and a configurable driver hold', () => {
    expect(reviewSubagentSupport('review', 'configurable')).toBe('configurable')
  })

  it('degrades to promptable outside review mode even on a configurable driver', () => {
    expect(reviewSubagentSupport('investigation', 'configurable')).toBe('promptable')
  })

  it('degrades to promptable in review mode on a promptable driver', () => {
    expect(reviewSubagentSupport('review', 'promptable')).toBe('promptable')
  })
})

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-framing-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'FRAME-1', title: 'framing' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('driverForSession', () => {
  it('resolves a pinned session through driverForInstance', () => {
    const s = createSession(db, 'FRAME-1', {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1'
    })
    const seen: string[] = []
    const driver = driverForSession(
      {
        db,
        driverForInstance: (id) => {
          seen.push(id)
          return stubDriver('github-copilot', 'configurable')
        },
        resolveDriver: () => stubDriver('claude-agent-sdk', 'promptable')
      },
      s.id
    )
    expect(seen).toEqual(['copilot-1'])
    expect(driver.kind).toBe('github-copilot')
  })

  it('falls back to the live default provider for an unpinned session (null instance_id)', () => {
    const s = createSession(db, 'FRAME-1', 'claude-agent-sdk')
    const driver = driverForSession(
      {
        db,
        driverForInstance: () => stubDriver('github-copilot', 'configurable'),
        resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable')
      },
      s.id
    )
    expect(driver.kind).toBe('claude-agent-sdk')
  })
})

describe('resolveReviewFraming', () => {
  it('throws on an unknown case', () => {
    expect(() =>
      resolveReviewFraming(
        { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
        'NO-SUCH-CASE',
        1
      )
    ).toThrow(/Unknown case/)
  })

  it('throws when the session does not belong to caseSlug', () => {
    createCase(db, argusHome, { slug: 'FRAME-2', title: 'other' })
    const s = createSession(db, 'FRAME-2', 'claude-agent-sdk')
    expect(() =>
      resolveReviewFraming(
        { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
        'FRAME-1',
        s.id
      )
    ).toThrow(/Unknown session/)
  })

  it('frames configurable for a review-mode session on a configurable driver', () => {
    const s = createSession(db, 'FRAME-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    const framing = resolveReviewFraming(
      { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
      'FRAME-1',
      s.id
    )
    expect(framing).toEqual({ support: 'configurable' })
  })

  it('frames promptable for an investigation-mode session even on a configurable driver', () => {
    const s = createSession(db, 'FRAME-1', {
      driverKind: 'claude-agent-sdk',
      mode: 'investigation'
    })
    const framing = resolveReviewFraming(
      { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
      'FRAME-1',
      s.id
    )
    expect(framing.support).toBe('promptable')
  })
})
