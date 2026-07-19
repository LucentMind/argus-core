import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import { sharedSkillsDir } from '../../skillsDir'
import type { CreateQueryFn } from '../drivers/claude'

/**
 * A linked code workspace is an investigation ARTIFACT, not configuration. The Claude CLI
 * auto-discovers `.claude/skills` in every `additionalDirectories` entry, so a repo that
 * happens to ship its own skills would inject them into the session listing — bypassing
 * Argus's tiers and the Skills page entirely (observed 2026-07-19: a linked
 * HiveMindTest checkout put analyze-logcat/-dlt/-recording into a KAN-22
 * turn). The driver must therefore pass an explicit `skills` allowlist naming exactly the
 * skills Argus resolved as enabled.
 */

const detection = createDetection()
let home: string, db: DatabaseSync, lastOptions: Record<string, unknown> | null

const capturingCreateQuery = (): CreateQueryFn => (args) => {
  lastOptions = args.options
  const q = new AsyncQueue<unknown>()
  return Object.assign(
    { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
    { interrupt: async () => q.end() }
  )
}

const writeSkill = (root: string, name: string, description: string): void => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-skillscope-'))
  db = openDb(path.join(home, 'argus.db'))
  lastOptions = null
  createCase(db, home, { slug: 'NAV-1', title: 'NAV-1' })
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const mkService = (access = defaultAgentAccess()): AgentService =>
  new AgentService({
    db,
    argusHome: home,
    detection,
    skillsRoots: [],
    agentAccess: () => access,
    onEvent: () => {},
    createQuery: capturingCreateQuery()
  })

it('passes an explicit skills allowlist naming only the resolved, enabled skills', async () => {
  writeSkill(sharedSkillsDir(home), 'code-graph', 'blast radius queries')
  writeSkill(sharedSkillsDir(home), 'contribute-back', 'draft proposals')

  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  await svc.send('NAV-1', s.id, 'hi')

  expect(lastOptions?.skills).toEqual(['code-graph', 'contribute-back'])
  await svc.stopAll()
})

it('omits a skill the user disabled, so the Skills page stays the control surface', async () => {
  writeSkill(sharedSkillsDir(home), 'code-graph', 'blast radius queries')
  writeSkill(sharedSkillsDir(home), 'contribute-back', 'draft proposals')

  const svc = mkService({ ...defaultAgentAccess(), skills: { 'bundled/code-graph': false } })
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  await svc.send('NAV-1', s.id, 'hi')

  expect(lastOptions?.skills).toEqual(['contribute-back'])
  await svc.stopAll()
})

it('sends an empty allowlist (never undefined) when no skill resolves enabled', async () => {
  // Regression guard: omitting `skills` is NOT "skills off" — the SDK falls back to the
  // CLI's discover-everything default, which is exactly the leak this test pins shut.
  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  await svc.send('NAV-1', s.id, 'hi')

  expect(lastOptions?.skills).toEqual([])
  await svc.stopAll()
})
