import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseDistillInput } from '../../../shared/distill'
import type { RcaDraft } from '../../../shared/rca'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { listSessions } from '../agent/sessionStore'
import { listProposals, listArchivedProposals } from '../proposals'
import { refTitle, refBody, refTier } from '../refSync/refFrontmatter'
import { sharedReferencesDir } from '../skillsDir'
import { artifactsDir } from '../paths'

/** Reference name/summary/content/tier records for the shared references/ dir — summary is the
 *  first trimmed, non-blank, non-heading line of the body (matching generateReferencesIndex in
 *  refSync/engine.ts), falling back to the frontmatter title when no such line exists; content
 *  is the full raw file (frontmatter + body) a reference-edit must return with its change
 *  merged in; tier is the trust_tier ('confluence' files are auto-synced and must never be an
 *  edit target — the distiller is told so via rule 7). */
export function buildReferencesIndex(
  argusHome: string
): { name: string; summary: string; content: string; tier: string | null }[] {
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
        content: raw,
        tier: refTier(raw)
      }
    })
}

/**
 * `artifacts/rca-structure.json` — the confirmed, human-reviewed RCA structure for this case, if
 * one was ever generated and confirmed. Unlike rca/jobs.ts's readPriorDraft (which throws on a
 * corrupt file so a bad read can never silently regenerate over confirmed edits), this read is
 * purely advisory input to a case distillation — which can run on a live (open) case as well as
 * a closed one: a missing file, an unreadable one, or malformed JSON all just mean "no confirmed
 * structure to fold in" — never throw, always fall back to null.
 */
function readConfirmedRcaStructure(argusHome: string, slug: string): RcaDraft | null {
  const file = path.join(artifactsDir(argusHome, slug), 'rca-structure.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RcaDraft
  } catch {
    return null
  }
}

/**
 * Snapshot everything the background distiller needs to draft a case's proposals:
 * case meta, findings with review states and roles, evidence inventory, session
 * titles, skills index (caller-supplied — distiller resolves tier-aware access),
 * references index, the confirmed RCA structure (if any), and the already-captured
 * section (pending + archived proposals for this case) so the distiller can skip
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
      status: c.status,
      resolution: c.resolution,
      tags: c.tags,
      createdAt: c.createdAt,
      closedAt: c.updatedAt
    },
    findings: listFindings(db, argusHome, slug).map((f) => ({
      summary: f.summary,
      reviewState: f.reviewState,
      role: f.role,
      body: f.body ?? ''
    })),
    evidence: listEvidence(db, slug).map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    sessionTitles: listSessions(db, slug).map((s) => s.title),
    skillsIndex,
    referencesIndex: buildReferencesIndex(argusHome),
    rcaStructure: readConfirmedRcaStructure(argusHome, slug),
    alreadyCaptured: {
      proposals: [...pending, ...archived]
    }
  }
}
