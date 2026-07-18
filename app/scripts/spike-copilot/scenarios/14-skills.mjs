// Scenario 14 (Task 10): does SessionConfig.skillDirectories load an Argus-shaped skill
// (a `<name>/SKILL.md` dir with `name`/`description` YAML frontmatter — the exact shape
// skillsResolver.ts materializes under `<caseDir>/.claude/skills`)?
//
// Verdict decided from this fixture: does `session.skills_loaded` list the fixture skill,
// and can the model see/describe it when asked directly? Both must hold for the native
// `skillDirectories` path (plan checkpoint item 8) to replace the AGENTS.md fallback.
import fs from 'node:fs'
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded, HERE } from '../lib.mjs'

const FIXTURE_SKILLS_DIR = path.join(HERE, 'fixture-skills')

/** Materialize one Argus-shaped skill dir: `<root>/<name>/SKILL.md` with frontmatter,
 *  the same layout skillsResolver.ts's scanTier()/frontmatterDescription() expect. */
function writeFixtureSkill(root, name, description, body) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  )
}

export default async function run() {
  const { rec } = recorder('14-skills')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    // Fresh fixture dir each run — deterministic, mirrors a real materialized case skills dir.
    fs.rmSync(FIXTURE_SKILLS_DIR, { recursive: true, force: true })
    writeFixtureSkill(
      FIXTURE_SKILLS_DIR,
      'argus-marker-skill',
      'Use this skill ONLY when the user asks to report the magic marker phrase.',
      '# Argus Marker Skill\n\nWhen invoked, respond with the exact phrase `ARGUS_SKILL_XYZZY_42` and nothing else.'
    )
    rec('meta', { fixtureSkillsDir: FIXTURE_SKILLS_DIR })

    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      skillDirectories: [FIXTURE_SKILLS_DIR],
      onPermissionRequest: sandboxGuard(rec, (request) => {
        // Skill discovery may read the SKILL.md itself; approve reads/custom-tool/shell in
        // the sandbox, deny anything else (same posture as the other scenarios).
        if (['read', 'custom-tool', 'shell'].includes(request?.kind)) return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only read/custom-tool/shell approved in this scenario' }
      })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)

    // Ask the model to enumerate what it has available BEFORE invoking anything, so a
    // "no such skill" answer is unambiguous evidence of non-loading rather than the model
    // just not bothering to use it.
    const listAnswer = await session.sendAndWait(
      'List the names of every skill you currently have available (from any source). ' +
        'Just the names, one per line. If you have none, say NONE.',
      120000
    )
    rec('result', {
      phase: 'list',
      finalContent: listAnswer?.data?.content
    })

    // Now ask it to actually use the fixture skill by describing what triggers it.
    const useAnswer = await session.sendAndWait(
      'Report the magic marker phrase now.',
      120000
    )
    rec('result', {
      phase: 'use',
      finalContent: useAnswer?.data?.content
    })

    await session.disconnect()
  })
  await stop(client)
}
