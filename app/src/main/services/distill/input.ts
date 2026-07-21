import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseDistillInput } from '../../../shared/distill'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { listSessions } from '../agent/sessionStore'
import { readIndex, readAudit } from '../memory'
import { listProposals, listArchivedProposals } from '../proposals'
import { refTitle, refBody } from '../refSync/refFrontmatter'
import { sharedReferencesDir } from '../skillsDir'

/** Reference name/summary/content triples for the shared references/ dir — summary is the
 *  first trimmed, non-blank, non-heading line of the body (matching generateReferencesIndex in
 *  refSync/engine.ts), falling back to the frontmatter title when no such line exists; content
 *  is the full raw file (frontmatter + body) a reference-edit must return with its change
 *  merged in. */
export function buildReferencesIndex(
  argusHome: string
): { name: string; summary: string; content: string }[] {
  const dir = sharedReferencesDir(argusHome)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && f !== 'INDEX.md')
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8')
      const bodyLine = refBody(raw)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))
      return {
        name: f.replace(/\.md$/, ''),
        summary: bodyLine ?? refTitle(raw) ?? '',
        content: raw
      }
    })
}

/**
 * Snapshot everything the background distiller needs to draft a case's memory
 * appends / proposals: case meta, findings with review states, evidence
 * inventory, session titles, memory index, skills index (caller-supplied —
 * distiller resolves tier-aware access), references index, and the
 * already-captured section (pending + archived proposals for this case, and
 * memory audit entries filtered by caseSlug) so the distiller can skip
 * re-proposing what a human already reviewed.
 */
export function assembleDistillInput(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  skillsIndex: { name: string; description: string; content: string }[] = []
): CaseDistillInput {
  const c = getCase(db, slug)
  if (!c) throw new Error(`Unknown case: ${slug}`)

  const pending = listProposals(argusHome)
    .filter((p) => p.caseSlug === slug)
    .map((p) => ({ type: p.type, target: p.target, title: p.title, state: 'pending' as const }))
  const archived = listArchivedProposals(argusHome)
    .filter((p) => p.caseSlug === slug)
    .map((p) => ({ type: p.type, target: p.target, title: p.title, state: p.status }))

  return {
    caseMeta: {
      slug: c.slug,
      title: c.title,
      jiraKey: c.jiraKey,
      resolution: c.resolution,
      tags: c.tags,
      createdAt: c.createdAt,
      closedAt: c.updatedAt
    },
    findings: listFindings(db, argusHome, slug).map((f) => ({
      summary: f.summary,
      reviewState: f.reviewState,
      body: f.body ?? ''
    })),
    evidence: listEvidence(db, slug).map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    sessionTitles: listSessions(db, slug).map((s) => s.title),
    memoryIndex: readIndex(argusHome),
    skillsIndex,
    referencesIndex: buildReferencesIndex(argusHome),
    alreadyCaptured: {
      proposals: [...pending, ...archived],
      memoryWrites: readAudit(argusHome, 1000)
        .filter((e) => e.caseSlug === slug)
        .map((e) => ({ topic: e.topic, indexEntry: e.indexEntry }))
    }
  }
}
