import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { CaseSession } from '../../agent/session'
import { createClaudeDriver, type CreateQueryFn } from '../../agent/drivers/claude'
import { createSession } from '../../agent/sessionStore'
import { AsyncQueue } from '../../agent/asyncQueue'
import { CLAUDE_TOOL_TAXONOMY } from '../../agent/risk'
import { assembleMode } from '../../agent/modeAssembly'
import { MODES } from '../../../../shared/modes'
import type { AgentDriver, DriverSessionContext } from '../../agent/driver'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { SessionPromptCapture } from '../../../../shared/promptsIpc'
import type { DatabaseSync } from 'node:sqlite'

describe('assembleMode reports the id behind each persona fragment', () => {
  it('returns ids parallel to the fragments, null for pack text', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: ['PACK'],
      contributeBack: true
    })
    expect(out.personaFragmentIds).toEqual([
      'persona.mode.investigation',
      'persona.neutral',
      'persona.diagram',
      null,
      'persona.contribute-back'
    ])
    expect(out.personaFragmentIds).toHaveLength(out.personaFragments.length)
  })

  it('omits the mode id when the mode declares no persona fragment', () => {
    // Guards the optional-first-element branch: ids must stay aligned with fragments.
    const out = assembleMode({
      mode: 'review',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: false
    })
    const expectFirst = MODES.review.personaFragment ? 'persona.mode.review' : 'persona.neutral'
    expect(out.personaFragmentIds[0]).toBe(expectFirst)
    expect(out.personaFragmentIds).toHaveLength(out.personaFragments.length)
  })

  it('leaves the fragment text itself unchanged', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: ['PACK'],
      contributeBack: false
    })
    expect(out.personaFragments[0]).toBe(MODES.investigation.personaFragment)
    expect(out.personaFragments).toContain('PACK')
  })
})

describe('CaseSession assembles the prompt capture', () => {
  let tmp: string, argusHome: string, db: DatabaseSync

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cap-wiring-'))
    argusHome = path.join(tmp, 'home')
    db = openDb(path.join(argusHome, 'argus.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** Captures the SDK options bag so the record can be compared against what was really sent.
   *  The empty-array loop keeps a real `yield` in the generator (eslint `require-yield`). */
  function spyQuery(): { options: () => Record<string, unknown> | null; fn: CreateQueryFn } {
    let seen: Record<string, unknown> | null = null
    const messages: unknown[] = []
    return {
      options: () => seen,
      fn: (args) => {
        seen = args.options
        return {
          async *[Symbol.asyncIterator]() {
            for (const m of messages) yield m
          },
          interrupt: async () => undefined
        }
      }
    }
  }

  function build(
    driver: AgentDriver,
    over: Partial<ConstructorParameters<typeof CaseSession>[0]> = {}
  ): void {
    const rec = createCase(db, argusHome, { slug: 'CAP-1', title: 't' })
    new CaseSession({
      db,
      argusHome,
      detection: createDetection(),
      caseId: rec.id,
      caseSlug: 'CAP-1',
      sessionId: createSession(db, 'CAP-1', 'claude-agent-sdk').id,
      workspaceRoots: [],
      skillsRoots: [],
      emit: () => {},
      driver,
      resumeCursor: null,
      ...over
    })
  }

  it('records the exact bytes the driver received, with per-fragment attribution', () => {
    const captured: SessionPromptCapture[] = []
    const sdk = spyQuery()
    build(createClaudeDriver(sdk.fn), {
      mode: 'investigation',
      // 'PADDED' carries surrounding whitespace to prove captureFragments reports the trimmed
      // length composePersona actually emits, not the raw fragment length.
      personaFragments: ['IDENTITY', 'NEUTRAL', '  PADDED  '],
      personaFragmentIds: ['persona.mode.investigation', 'persona.neutral', null],
      skillIndex: 'Skills most relevant to this mode:\n- doctor',
      enabledSkills: ['doctor'],
      activeOverrides: () => ['persona.neutral'],
      recordPromptCapture: (c: SessionPromptCapture) => {
        captured.push(c)
      },
      // Leading/trailing whitespace here too, so the personaAppend fragment's chars also
      // reflects the trimmed bytes composePersona folds into systemAppend.
      agentOptions: {
        model: 'claude-opus-5',
        permissionMode: 'plan',
        personaAppend: '  Focus on ADAS module defects.  '
      }
    })

    expect(captured).toHaveLength(1)
    const c = captured[0]
    expect(c).toMatchObject({
      caseSlug: 'CAP-1',
      driverKind: 'claude-agent-sdk',
      model: 'claude-opus-5',
      mode: 'investigation',
      permissionMode: 'plan',
      transport: 'systemPrompt.append',
      enabledSkills: ['doctor'],
      activeOverrides: ['persona.neutral']
    })

    // THE assertion: one composition, two consumers. A second `composePersona(...)` call inside
    // the capture could drift from what the driver got and nothing would notice.
    const sent = sdk.options()?.systemPrompt as { append: string } | undefined
    expect(c.systemAppend).toBe(sent?.append)
    expect(c.systemAppend).toContain('IDENTITY')
    expect(c.systemAppend).toContain('Focus on ADAS module defects.')

    expect(c.fragments).toEqual([
      {
        id: 'persona.mode.investigation',
        label: 'persona.mode.investigation',
        chars: 8,
        overridden: false
      },
      { id: 'persona.neutral', label: 'persona.neutral', chars: 7, overridden: true },
      { id: null, label: 'Pack or settings fragment', chars: 'PADDED'.length, overridden: false },
      {
        id: null,
        label: 'Pack or settings fragment',
        chars: 'Focus on ADAS module defects.'.length,
        overridden: false
      }
    ])
    expect(c.tools.some((t) => t.name === 'grep_lines' && t.origin === 'native')).toBe(true)
  })

  it('omits the personaAppend fragment entirely when it is empty or whitespace-only', () => {
    const captured: SessionPromptCapture[] = []
    const sdk = spyQuery()
    build(createClaudeDriver(sdk.fn), {
      mode: 'investigation',
      personaFragments: ['IDENTITY'],
      personaFragmentIds: ['persona.mode.investigation'],
      recordPromptCapture: (c: SessionPromptCapture) => captured.push(c),
      agentOptions: { personaAppend: '   ' }
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].fragments).toEqual([
      {
        id: 'persona.mode.investigation',
        label: 'persona.mode.investigation',
        chars: 8,
        overridden: false
      }
    ])
  })

  it('omits capturePrompt from the driver context entirely when there is no sink', () => {
    // Gate off. `capturePrompt` must be ABSENT, not a no-op function: the driver's optional-call
    // is what keeps a normal build from assembling a record at all.
    const seen: DriverSessionContext[] = []
    const queue = new AsyncQueue<AgentEvent>()
    const probe: AgentDriver = {
      kind: 'claude-agent-sdk',
      toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
      authFixHint: '',
      capabilities: {
        permissionModes: ['default'],
        editableApprovals: true,
        costReporting: true,
        headlessOneShot: false,
        systemPromptTransport: 'systemPrompt.append',
        subagents: 'configurable'
      },
      createSession: (ctx) => {
        seen.push(ctx)
        return {
          events: () => queue,
          send: () => undefined,
          interrupt: async () => undefined,
          end: () => queue.end()
        }
      },
      probeAuth: async () => ({ ok: true, detail: '' })
    }
    build(probe, { mode: 'investigation', personaFragments: ['IDENTITY'] })
    expect(seen).toHaveLength(1)
    expect('capturePrompt' in seen[0]).toBe(false)
  })
})
