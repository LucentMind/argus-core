import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archiveCase, restoreCase } from '../caseArchive'
import { getCase } from '../caseService'
import { createImmediateQueue } from '../ingestQueue'
import { createSession } from '../agent/sessionStore'
import { caseDir } from '../paths'
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
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, rewound_at, rewound_to_turn_id, created_at)
       VALUES (?, ?, 2, 'rewound', ?, ?, ?)`
    ).run(caseId, firstSessionId, now, anchorTurnId, now)

    // A second session forked from the first at the anchor turn. It needs its own transcript
    // file — registerImportedSessions only re-creates sessions it finds a mirrored .jsonl for.
    const secondSession = createSession(db, slug, 'claude-agent-sdk')
    db.prepare(
      `UPDATE sessions SET forked_from_session_id = ?, forked_at_turn_id = ?, forked_inherited_turns = 1
       WHERE id = ?`
    ).run(firstSessionId, anchorTurnId, secondSession.id)
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
        `SELECT id, driver_kind AS driverKind, forked_from_session_id AS forkedFromSessionId,
                forked_at_turn_id AS forkedAtTurnId, forked_inherited_turns AS forkedInheritedTurns
         FROM sessions WHERE case_id = ? ORDER BY id`
      )
      .all(newCaseId) as {
      id: number
      driverKind: string
      forkedFromSessionId: number | null
      forkedAtTurnId: number | null
      forkedInheritedTurns: number | null
    }[]
    expect(sessions).toHaveLength(2)
    const [restoredParent, restoredChild] = sessions

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

    expect(restoredChild.forkedFromSessionId).toBe(restoredParent.id)
    expect(restoredChild.forkedAtTurnId).toBe(restoredAnchor.id)
    expect(restoredChild.forkedInheritedTurns).toBe(1)
    expect(restoredChild.driverKind).toBe('claude-agent-sdk')
  })
})
