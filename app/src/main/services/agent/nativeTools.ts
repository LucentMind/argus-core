import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseStatus } from '../../../shared/types'
import { searchEvidence } from '../search'
import { ingestArtifact, listEvidence } from '../ingest'
import { ensureWorktree } from '../workspaces'
import { caseDir } from '../paths'
import { applyMemoryWrite } from '../memory'

export interface NativeToolDeps {
  db: DatabaseSync
  argusHome: string
  caseId: number
  caseSlug: string
  sessionId: number
  emitFinding: (markdown: string) => void
}

const STATUSES: CaseStatus[] = ['open', 'analyzing', 'rca-drafted', 'closed']

export function argusToolHandlers(
  deps: NativeToolDeps
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const { db, argusHome, caseSlug, sessionId } = deps
  const dir = caseDir(argusHome, caseSlug)

  return {
    async search_evidence(args) {
      const scope = args.scope === 'all' ? undefined : caseSlug
      const hits = searchEvidence(db, String(args.query ?? ''), {
        caseSlug: scope,
        artifactType: args.artifact_type as never
      })
      return JSON.stringify(hits.slice(0, 25), null, 2)
    },

    async list_evidence() {
      return JSON.stringify(listEvidence(db, caseSlug), null, 2)
    },

    async get_artifact_meta(args) {
      const rec = listEvidence(db, caseSlug).find((e) => e.id === Number(args.evidence_id))
      if (!rec) throw new Error(`Unknown evidence_id: ${args.evidence_id}`)
      return JSON.stringify(rec, null, 2)
    },

    async ingest_artifact(args) {
      const p = path.resolve(String(args.path ?? ''))
      if (!p.startsWith(dir + path.sep)) {
        throw new Error(`ingest_artifact only accepts files inside the case dir: ${dir}`)
      }
      const rec = ingestArtifact(db, argusHome, caseSlug, p, 'agent')
      return JSON.stringify(rec, null, 2)
    },

    async append_finding(args) {
      const title = String(args.title ?? 'Finding')
      const markdown = String(args.markdown ?? '')
      const block = `\n## ${title}\n_${new Date().toISOString()} · session ${sessionId}_\n\n${markdown}\n`
      fs.appendFileSync(path.join(dir, 'findings.md'), block)
      deps.emitFinding(block)
      return 'finding appended'
    },

    async update_case_status(args) {
      const status = String(args.status ?? '')
      if (!STATUSES.includes(status as CaseStatus)) {
        throw new Error(`Invalid status ${JSON.stringify(status)}; expected ${STATUSES.join('|')}`)
      }
      db.prepare(`UPDATE cases SET status = ?, updated_at = ? WHERE slug = ?`).run(
        status,
        new Date().toISOString(),
        caseSlug
      )
      const cj = path.join(dir, 'case.json')
      const data = JSON.parse(fs.readFileSync(cj, 'utf8'))
      data.status = status
      fs.writeFileSync(cj, JSON.stringify(data, null, 2))
      return `status → ${status}`
    },

    async write_memory(args) {
      return applyMemoryWrite(argusHome, caseSlug, {
        topic: String(args.topic ?? ''),
        content: String(args.content ?? ''),
        indexEntry: args.index_entry == null ? undefined : String(args.index_entry)
      })
    },

    async workspace_checkout(args) {
      const wt = await ensureWorktree(
        argusHome,
        caseSlug,
        String(args.repo_path ?? ''),
        String(args.ref ?? '')
      )
      return `Checked out ${args.ref} in case worktree: ${wt}\nWork with the code there; the primary checkout is untouched.`
    }
  }
}

function asText(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] }
}

export function createArgusMcpServer(deps: NativeToolDeps): ReturnType<typeof createSdkMcpServer> {
  const h = argusToolHandlers(deps)
  return createSdkMcpServer({
    name: 'argus',
    version: '1.0.0',
    tools: [
      tool(
        'search_evidence',
        'FTS search over case evidence, findings and transcripts. Returns hits with relPath + matchLine — cite them as [relPath:line].',
        {
          query: z.string(),
          scope: z.enum(['case', 'all']).optional(),
          artifact_type: z.string().optional()
        },
        async (a) => asText(await h.search_evidence(a))
      ),
      tool(
        'list_evidence',
        'List all evidence artifacts of this case with types and metadata.',
        {},
        async (a) => asText(await h.list_evidence(a))
      ),
      tool(
        'get_artifact_meta',
        'Full metadata for one evidence artifact.',
        { evidence_id: z.number() },
        async (a) => asText(await h.get_artifact_meta(a))
      ),
      tool(
        'ingest_artifact',
        'Register a file you created/derived (inside the case dir) as evidence — it becomes searchable and citable.',
        { path: z.string() },
        async (a) => asText(await h.ingest_artifact(a))
      ),
      tool(
        'append_finding',
        'Append a structured finding to findings.md. Include [relPath:line] citations for every evidence claim.',
        { title: z.string(), markdown: z.string() },
        async (a) => asText(await h.append_finding(a))
      ),
      tool(
        'update_case_status',
        'Move the case through its lifecycle (open|analyzing|rca-drafted|closed).',
        { status: z.string() },
        async (a) => asText(await h.update_case_status(a))
      ),
      tool(
        'write_memory',
        'Record a durable cross-case lesson in agent memory (memory/<topic>.md). Provide index_entry when creating a topic so future sessions can discover it via _index.md.',
        { topic: z.string(), content: z.string(), index_entry: z.string().optional() },
        async (a) => asText(await h.write_memory(a))
      ),
      tool(
        'workspace_checkout',
        'Check out a branch/PR ref of a linked repo in a case-scoped worktree. NEVER run git switch/checkout in the primary checkout.',
        { repo_path: z.string(), ref: z.string() },
        async (a) => asText(await h.workspace_checkout(a))
      )
    ]
  })
}
