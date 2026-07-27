import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../../../db'
import { createDetection } from '../../../../packs/detection'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { AgentDriver, DriverSessionContext } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'
import { createAcpDriver } from '../index'
import { CURSOR_PROFILE } from '../profiles/cursor'
import { GROK_PROFILE } from '../profiles/grok'
import type { AcpAgentProfile } from '../profiles/types'

/**
 * REAL-RUNTIME smoke for the ACP agents (Task 11). Gated on `ACP_SMOKE=1` because it spawns a
 * real `cursor-agent`/`grok` process and drives one live turn — it never runs in the normal
 * unit suite. Per the parent plan's owner decision, no ACP binaries/keys exist in CI, so this
 * file must SKIP CLEANLY (0 failures) here: the whole describe is `.skip` unless `ACP_SMOKE=1`,
 * and each agent is skipped individually when its CLI is not on PATH. Run it manually with an
 * installed agent + credentials:
 *   cd app && ACP_SMOKE=1 ./node_modules/.bin/electron node_modules/.bin/vitest run \
 *     src/main/services/agent/drivers/acp/__tests__/smoke.acp.test.ts
 * (Electron, not bare node — see the plan's Electron-only spawn-trap constraint.)
 */

const SMOKE = process.env.ACP_SMOKE === '1'

/** True when `command --version` (or `--help`) can be spawned — i.e. the CLI is on PATH. */
function binaryAvailable(command: string): boolean {
  try {
    const r = spawnSync(command, ['--version'], { stdio: 'ignore' })
    return !r.error // ENOENT sets r.error; any spawn that started (even nonzero exit) counts
  } catch {
    return false
  }
}

interface SmokeAgent {
  label: string
  profile: AcpAgentProfile
  command: string
}

const AGENTS: SmokeAgent[] = [
  { label: 'cursor', profile: CURSOR_PROFILE, command: 'cursor-agent' },
  { label: 'grok', profile: GROK_PROFILE, command: 'grok' }
]

const describeOrSkip = SMOKE ? describe : describe.skip

describeOrSkip('ACP real-runtime smoke (ACP_SMOKE=1)', () => {
  for (const agent of AGENTS) {
    const available = SMOKE && binaryAvailable(agent.command)
    const itOrSkip = available ? it : it.skip

    itOrSkip(
      `${agent.label}: one real turn with a file edit completes and reports a tool result`,
      async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `argus-acp-smoke-${agent.label}-`))
        const argusHome = path.join(tmp, 'home')
        const db = openDb(path.join(argusHome, 'argus.db'))
        try {
          const nativeToolDeps: NativeToolDeps = {
            db,
            argusHome,
            detection: createDetection(),
            caseId: 1,
            caseSlug: 'c',
            sessionId: 1,
            emitFinding: () => {}
          }
          const ctx: DriverSessionContext = {
            caseDir: tmp,
            additionalDirectories: [],
            skills: [],
            subagents: [],
            permissionMode: 'default',
            systemAppend: 'SMOKE',
            extraMcpServers: {},
            nativeToolDeps,
            panelCommandDecls: [],
            resumeCursor: null,
            eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
            // Approve the edit so the turn produces a tool result.
            onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
            onCursor: () => {},
            onTurnResult: () => {}
          }

          const driver: AgentDriver = createAcpDriver(agent.profile)
          const session = driver.createSession(ctx)
          session.send(
            `Create a file named smoke.txt in ${tmp} containing the text "hello from ${agent.label}".`
          )

          const events: AgentEvent[] = []
          for await (const e of session.events()) events.push(e)

          expect(events.some((e) => e.type === 'tool.call.completed')).toBe(true)
          expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
        } finally {
          db.close()
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      },
      60_000
    )
  }

  it('smoke harness is wired (sanity, always runs under ACP_SMOKE=1)', () => {
    // Guarantees the describe block itself is non-empty when ACP_SMOKE=1 even if every agent is
    // skipped for a missing binary, so the file never reports "no tests" as a failure.
    expect(AGENTS.length).toBeGreaterThan(0)
  })
})
