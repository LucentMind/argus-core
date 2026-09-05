import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archiveCase, restoreCase } from '../caseArchive'
import { getCase } from '../caseService'
import { createImmediateQueue } from '../ingestQueue'
import { createSession } from '../agent/sessionStore'
import { caseDir } from '../paths'
import { readSessionEvents } from '../agent/mirror'
import { insertMessageFts } from '../ftsIndex'
import { cleanupArchiveFixtures, seedArchivableCase } from './archiveFixtures'

afterEach(() => {
  cleanupArchiveFixtures()
})

/**
 * Archive/restore round-trip for the rewind + fork-lineage columns added on top of the
 * existing turns/tool_calls/findingPointers sidecar (see caseArchiveRestore.test.ts).
 *
 * Before this, `collectCaseRows` dropped `turns.model`, `rewound_at`, `rewound_to_turn_id`
 * and `provider_anchor_id` from the sidecar entirely, and `registerImportedSessions` — which
 * rebuilds `sessions` rows purely from the mirrored transcript JSONL — has no way to know a
 * session's `driver_kind`/`instance_id`/`model`/`mode` or that it was forked from another
 * session at all. A rewound turn came back looking like an ordinary one, a provider anchor
 * was lost (breaking "continue where the SDK left off"), and a forked session's lineage to
 * its parent vanished — the UI could no longer show "forked from" or which turns it inherited.
 */
describe('restoreCase — rewind, provider anchors and fork lineage', () => {
  it('round-trips a rewound turn, its provider anchor/model, and a forked session’s lineage', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    const firstSessionId = Number(
      (db.prepare(`SELECT id FROM sessions WHERE case_id = ?`).get(caseId) as { id: number }).id
    )
    const now = new Date().toISOString()

    // The anchor turn: what the provider actually produced, carrying its message id and model.
    const anchorTurnId = Number(
      db
        .prepare(
          `INSERT INTO turns (case_id, session_id, turn_index, status, provider_anchor_id, model, created_at)
           VALUES (?, ?, 1, 'success', 'a', 'm', ?)`
        )
        .run(caseId, firstSessionId, now).lastInsertRowid
    )
    // A later turn rewound back to that anchor.
    const rewoundTurnId = Number(
      db
        .prepare(
          `INSERT INTO turns (case_id, session_id, turn_index, status, rewound_at, rewound_to_turn_id, created_at)
       VALUES (?, ?, 2, 'rewound', ?, ?, ?)`
        )
        .run(caseId, firstSessionId, now, anchorTurnId, now).lastInsertRowid
    )
    // Give the parent's mirror real turn ids. The shared fixture's transcript carries none, and
    // an event with `turnId: null` is exactly the shape that would let a broken remap look fine:
    // nothing to rewrite, nothing to notice.
    fs.writeFileSync(
      path.join(caseDir(home, slug), 'sessions', `${firstSessionId}.jsonl`),
      [
        [anchorTurnId, 'turn.started', { userText: 'the live question' }],
        [anchorTurnId, 'assistant.message', { text: 'the live answer' }],
        [rewoundTurnId, 'turn.started', { userText: 'the discarded question' }],
        [rewoundTurnId, 'assistant.message', { text: 'the discarded answer' }]
      ]
        .map(([turnId, type, payload]) =>
          JSON.stringify({
            type,
            caseId,
            caseSlug: slug,
            sessionId: firstSessionId,
            turnId,
            payload
          })
        )
        .join('\n') + '\n'
    )

    // A second session forked from the first at the anchor turn. It needs its own transcript
    // file — registerImportedSessions only re-creates sessions it finds a mirrored .jsonl for.
    const secondSession = createSession(db, slug, 'claude-agent-sdk')
    db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run('parent chat', firstSessionId)
    db.prepare(
      `UPDATE sessions SET forked_from_session_id = ?, forked_at_turn_id = ?,
              forked_inherited_turns = 1, forked_branching = 'native', title = ?
       WHERE id = ?`
    ).run(firstSessionId, anchorTurnId, 'parent chat (fork)', secondSession.id)
    fs.writeFileSync(
      path.join(caseDir(home, slug), 'sessions', `${secondSession.id}.jsonl`),
      JSON.stringify({
        type: 'turn.started',
        caseId,
        caseSlug: slug,
        sessionId: secondSession.id,
        payload: { userText: 'forked conversation' }
      }) + '\n'
    )

    await archiveCase(db, home, slug, { argusVersion: 'test' })
    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const newCaseId = getCase(db, slug)!.id
    const sessions = db
      .prepare(
        `SELECT id, title, driver_kind AS driverKind, forked_from_session_id AS forkedFromSessionId,
                forked_at_turn_id AS forkedAtTurnId, forked_inherited_turns AS forkedInheritedTurns,
                forked_branching AS forkedBranching
         FROM sessions WHERE case_id = ? ORDER BY id`
      )
      .all(newCaseId) as {
      id: number
      title: string
      driverKind: string
      forkedFromSessionId: number | null
      forkedAtTurnId: number | null
      forkedInheritedTurns: number | null
      forkedBranching: string | null
    }[]
    expect(sessions).toHaveLength(2)
    const [restoredParent, restoredChild] = sessions
    // Titles are part of the sidecar for the same reason the lineage columns are:
    // `registerImportedSessions` re-derives a title from the mirrored transcript's first user
    // message, and a fork's mirror IS a copy of its parent's — so without this the two chats
    // come back with the same name and the "(fork)" marker, which is the only thing telling
    // them apart in the chat switcher, is gone. Found live 2026-09-05.
    expect(restoredParent.title).toBe('parent chat')
    expect(restoredChild.title).toBe('parent chat (fork)')

    const restoredAnchor = db
      .prepare(
        `SELECT id, status, provider_anchor_id AS providerAnchorId, model
         FROM turns WHERE session_id = ? AND turn_index = 1`
      )
      .get(restoredParent.id) as {
      id: number
      status: string
      providerAnchorId: string | null
      model: string | null
    }
    expect(restoredAnchor.status).toBe('success')
    expect(restoredAnchor.providerAnchorId).toBe('a')
    expect(restoredAnchor.model).toBe('m')

    const restoredRewound = db
      .prepare(
        `SELECT status, rewound_to_turn_id AS rewoundToTurnId
         FROM turns WHERE session_id = ? AND turn_index = 2`
      )
      .get(restoredParent.id) as { status: string; rewoundToTurnId: number | null }
    expect(restoredRewound.status).toBe('rewound')
    expect(restoredRewound.rewoundToTurnId).toBe(restoredAnchor.id)

    // The mirror is what the renderer, the history digest and `read_session_transcript` all
    // classify against, and it carries turn ids of its own. `registerImportedSessions` rewrites
    // caseId/caseSlug/sessionId on every line but used to leave `turnId` at the EXPORTED value,
    // which no longer names anything once `rebuildCaseRows` reassigns ids — so a restored case's
    // rewound tail rendered as ordinary live turns (with rewind/fork menus on them) and both
    // model-facing mirror readers stopped filtering it. Found live 2026-09-05.
    const restoredEvents = readSessionEvents(caseDir(home, slug), restoredParent.id)
    const restoredIds = new Set(
      db
        .prepare(`SELECT id FROM turns WHERE session_id = ?`)
        .all(restoredParent.id)
        .map((r) => (r as { id: number }).id)
    )
    const mirrorTurnIds = restoredEvents.map((e) => e.turnId).filter((t): t is number => t != null)
    expect(mirrorTurnIds.length).toBeGreaterThan(0)
    expect(mirrorTurnIds.every((t) => restoredIds.has(t))).toBe(true)
    // …and the message index, which the distill/world/RCA readers join against `turns.status`
    // to drop rewound content, has to point at the same rows.
    const ftsTurnIds = db
      .prepare(`SELECT turn_id AS turnId FROM messages_fts WHERE session_id = ?`)
      .all(restoredParent.id) as { turnId: number | null }[]
    expect(ftsTurnIds.length).toBeGreaterThan(0)
    expect(ftsTurnIds.every((r) => r.turnId != null && restoredIds.has(r.turnId))).toBe(true)

    expect(restoredChild.forkedFromSessionId).toBe(restoredParent.id)
    expect(restoredChild.forkedAtTurnId).toBe(restoredAnchor.id)
    expect(restoredChild.forkedInheritedTurns).toBe(1)
    // The divider's wording is permanent, so the branching the fork actually got has to survive
    // the round trip: recomputing it after a restore is impossible (the cursors and provider
    // anchors a native fork was cut from are deliberately not restored).
    expect(restoredChild.forkedBranching).toBe('native')
    expect(restoredChild.driverKind).toBe('claude-agent-sdk')
  })
})

/**
 * I1. A fork's mirror is a byte copy of its parent's inherited lines (`copySessionMirror`), and
 * the live fork path deliberately does NOT index those lines — spec §5.2, pinned by
 * `sessionBranch.test.ts`'s "0 messages_fts rows for the fork". Restore rebuilt the chat index
 * from EVERY restored session's mirror, so an archive round-trip silently indexed the inherited
 * conversation a second time: chat search returned the same message twice, and every
 * `messages_fts` reader that feeds the model (distill input, distill world, the RCA drafter)
 * saw the parent's turns doubled — for a case whose only crime was being archived and restored.
 */
describe('restoreCase — a fork does not re-index its inherited turns', () => {
  const INHERITED = 'INHERITEDLINE-belongs-to-the-parent'
  const FORK_OWN = 'FORKOWNLINE-belongs-to-the-fork'

  it('indexes the inherited conversation once (under the parent) and the fork’s own line', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    const parentId = Number(
      (db.prepare(`SELECT id FROM sessions WHERE case_id = ?`).get(caseId) as { id: number }).id
    )
    const now = new Date().toISOString()
    const addTurn = (sessionId: number, index: number): number =>
      Number(
        db
          .prepare(
            `INSERT INTO turns (case_id, session_id, turn_index, status, created_at)
             VALUES (?, ?, ?, 'success', ?)`
          )
          .run(caseId, sessionId, index, now).lastInsertRowid
      )
    const line = (sessionId: number, turnId: number, type: string, payload: unknown): string =>
      JSON.stringify({ type, caseId, caseSlug: slug, sessionId, turnId, payload })

    // The parent: one turn, whose text is what the fork inherits.
    const parentTurn = addTurn(parentId, 1)
    fs.writeFileSync(
      path.join(caseDir(home, slug), 'sessions', `${parentId}.jsonl`),
      [
        line(parentId, parentTurn, 'turn.started', { userText: INHERITED }),
        line(parentId, parentTurn, 'assistant.message', { text: 'the inherited answer' })
      ].join('\n') + '\n'
    )

    // The fork, exactly as forkCaseSession leaves it: its OWN copies of the parent's turn rows,
    // a mirror whose inherited lines carry the fork's turn ids (copySessionMirror remaps them),
    // one turn of its own — and no chat-index rows at all for the inherited half.
    const fork = createSession(db, slug, 'claude-agent-sdk')
    db.prepare(
      `UPDATE sessions SET forked_from_session_id = ?, forked_at_turn_id = ?,
              forked_inherited_turns = 1, title = ? WHERE id = ?`
    ).run(parentId, parentTurn, 'archivable (fork)', fork.id)
    const forkInherited = addTurn(fork.id, 1)
    const forkOwn = addTurn(fork.id, 2)
    fs.writeFileSync(
      path.join(caseDir(home, slug), 'sessions', `${fork.id}.jsonl`),
      [
        line(fork.id, forkInherited, 'turn.started', { userText: INHERITED }),
        line(fork.id, forkInherited, 'assistant.message', { text: 'the inherited answer' }),
        line(fork.id, forkOwn, 'turn.started', { userText: FORK_OWN }),
        line(fork.id, forkOwn, 'assistant.message', { text: 'the fork’s own answer' })
      ].join('\n') + '\n'
    )
    insertMessageFts(db, INHERITED, caseId, parentId, parentTurn, 'user')
    insertMessageFts(db, FORK_OWN, caseId, fork.id, forkOwn, 'user')

    await archiveCase(db, home, slug, { argusVersion: 'test' })
    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const newCaseId = getCase(db, slug)!.id
    const rowsFor = (content: string): { sessionId: number }[] =>
      db
        .prepare(
          `SELECT session_id AS sessionId FROM messages_fts WHERE case_id = ? AND content = ?`
        )
        .all(newCaseId, content) as { sessionId: number }[]
    const restoredFork = db
      .prepare(`SELECT id FROM sessions WHERE case_id = ? AND forked_from_session_id IS NOT NULL`)
      .get(newCaseId) as { id: number }
    const restoredParent = db
      .prepare(`SELECT id FROM sessions WHERE case_id = ? AND forked_from_session_id IS NULL`)
      .get(newCaseId) as { id: number }

    const inherited = rowsFor(INHERITED)
    expect(inherited).toHaveLength(1)
    expect(inherited[0].sessionId).toBe(restoredParent.id)
    // …and the half that IS the fork's own conversation still comes back indexed.
    const own = rowsFor(FORK_OWN)
    expect(own).toHaveLength(1)
    expect(own[0].sessionId).toBe(restoredFork.id)
  })
})
