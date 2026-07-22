import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { DatabaseSync } from 'node:sqlite'
import {
  CASE_RESOLUTIONS,
  type CaseRecord,
  type CaseResolution,
  type CaseStatus
} from '../../../shared/types'
import { searchEvidence } from '../search'
import { searchCaseSummaries } from '../distill/summaries'
import { ingestArtifact, listEvidence } from '../ingest'
import { ensureWorktree } from '../workspaces'
import { caseDir } from '../paths'
import { applyMemoryWrite, readTopic } from '../memory'
import { writeProposal } from '../proposals'
import { setCaseStatus } from '../caseService'
import { topicEnabled, defaultAgentAccess, type AgentAccess } from '../../../shared/agentAccess'
import type { Detection } from '../packs/detection'
import type { CapturePanelEvidence } from './capturePanel'
import { ensureIndex, getLines, searchLines } from '../lineIndex'
import { resolveTextDocAbs } from '../textdoc'

export interface NativeToolDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  caseId: number
  caseSlug: string
  sessionId: number
  emitFinding: (markdown: string) => void
  /** Live agent-access overrides; read per read_memory call so mid-session toggles bite. */
  agentAccess?: () => AgentAccess
  /** Current turn row id, read at finding time; null between turns. */
  currentTurnId?: () => number | null
  /** Open/focus a panel in the session's case (3b-2). Injected; absent in tests that don't need it. */
  openPanel?: (
    packId: string,
    windowId: string,
    evidenceId?: number
  ) => { ok: boolean; reason?: string; panel?: unknown }
  /** Capture an open panel to evidence (session-bound by AgentService). Absent in sessions without panels. */
  capturePanel?: (packId: string, windowId: string) => Promise<CapturePanelEvidence>
  /** Fired by setCaseStatus after a non-closed→closed transition; enqueues distillation. */
  onCaseClosed?: (rec: CaseRecord) => void
  /** Fired after workspace_checkout materializes/switches a case worktree, so the
   *  renderer can refresh repo chips + repo snippet caches without a case switch. */
  onWorktreeChanged?: (caseSlug: string) => void
}

const STATUSES: CaseStatus[] = ['open', 'analyzing', 'rca-drafted', 'closed']

export interface FindingWriteCtx {
  db: DatabaseSync
  argusHome: string
  caseId: number
  caseSlug: string
  sessionId: number
  turnId: number | null
}

/** Append a finding block to findings.md + insert the pending findings row. Shared by the
 *  native append_finding tool and the panel emitFinding HITL path (3b). */
export function appendFinding(
  ctx: FindingWriteCtx,
  input: { title: string; markdown: string }
): { findingId: number; block: string } {
  const title = input.title || 'Finding'
  const dir = caseDir(ctx.argusHome, ctx.caseSlug)
  // Insert first so the row id can be embedded in the findings.md block, giving
  // FindingsPane an exact row↔block join (see findings.ts parseFindingBodies).
  const res = ctx.db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(ctx.caseId, ctx.sessionId, ctx.turnId, title, new Date().toISOString())
  const findingId = Number(res.lastInsertRowid)
  const block = `\n<!-- finding:${findingId} -->\n## ${title}\n_${new Date().toISOString()} · session ${ctx.sessionId}_\n\n${input.markdown}\n`
  fs.appendFileSync(path.join(dir, 'findings.md'), block)
  return { findingId, block }
}

export function argusToolHandlers(
  deps: NativeToolDeps
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const { db, argusHome, detection, caseSlug, sessionId } = deps
  const dir = caseDir(argusHome, caseSlug)

  const num = (v: unknown, name: string, fallback?: number): number => {
    if (v == null && fallback !== undefined) return fallback
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
    return n
  }

  const resolveIndexedEvidence = async (
    evidenceId: number
  ): Promise<{ abs: string; index: Awaited<ReturnType<typeof ensureIndex>> }> => {
    const res = resolveTextDocAbs(db, argusHome, { kind: 'evidence', evidenceId })
    // Scope to this session's case — resolveTextDocAbs resolves across ALL cases, so without
    // this check an agent could read another case's evidence by guessing/iterating ids.
    // Same error as not-found: don't leak that the id exists in another case.
    if ('error' in res || res.caseSlug !== caseSlug) {
      throw new Error(`Unknown evidence_id: ${evidenceId}`)
    }
    const index = await ensureIndex(argusHome, res.abs)
    return { abs: res.abs, index }
  }

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

    async search_case_history(args) {
      const limit = args.limit == null ? 5 : Number(args.limit)
      const hits = searchCaseSummaries(db, String(args.query ?? ''), { limit })
      if (hits.length === 0) return 'No similar past cases found.'
      return hits
        .map((h) => `«${h.caseSlug}» [${h.resolution}] ${h.signature} — ${h.snippet}`)
        .join('\n')
    },

    async get_artifact_meta(args) {
      const rec = listEvidence(db, caseSlug).find((e) => e.id === Number(args.evidence_id))
      if (!rec) throw new Error(`Unknown evidence_id: ${args.evidence_id}`)
      return JSON.stringify(rec, null, 2)
    },

    async read_lines(args) {
      const { abs, index } = await resolveIndexedEvidence(num(args.evidence_id, 'evidence_id'))
      const from = Math.max(1, num(args.from, 'from', 1))
      const to = Math.min(num(args.to, 'to', from), from + 499)
      if (from > index.totalLines) {
        return `line ${from} does not exist — the file ends at line ${index.totalLines}`
      }
      const r = getLines(index, abs, from, to)
      const body = r.lines.map((l, i) => `${r.from + i}\t${l}`).join('\n')
      return `lines ${r.from}-${r.from + r.lines.length - 1} of ${index.totalLines}\n${body}`
    },

    async grep_lines(args) {
      const { abs, index } = await resolveIndexedEvidence(num(args.evidence_id, 'evidence_id'))
      const maxResults = Math.min(num(args.max_results, 'max_results', 200), 1000)
      const fromLine = Math.max(1, num(args.from_line, 'from_line', 1))
      const toLine = args.to_line == null ? undefined : num(args.to_line, 'to_line')
      const filterQuery = args.filter_query == null ? undefined : String(args.filter_query)
      const hits: number[] = []
      let scannedTo = fromLine - 1
      let capped = false
      const caseSensitive = args.case_sensitive === true
      for await (const b of searchLines(index, abs, String(args.query ?? ''), {
        regex: args.regex === true,
        caseSensitive,
        fromLine,
        toLine,
        maxResults,
        filter:
          filterQuery === undefined
            ? undefined
            : { query: filterQuery, regex: args.filter_regex === true, caseSensitive }
      })) {
        hits.push(...b.hits)
        scannedTo = b.scannedTo
        capped = b.capped
      }
      const shown = hits.map((n) => {
        const line = getLines(index, abs, n, n).lines[0] ?? ''
        return `${n}\t${line}`
      })
      const header = `${hits.length} matches (lines ${fromLine}-${scannedTo} of ${index.totalLines})`
      const tail = capped ? `\n[capped — continue with from_line: ${scannedTo + 1}]` : ''
      return `${header}\n${shown.join('\n')}${tail}`
    },

    async ingest_artifact(args) {
      const p = path.resolve(String(args.path ?? ''))
      if (!p.startsWith(dir + path.sep)) {
        throw new Error(`ingest_artifact only accepts files inside the case dir: ${dir}`)
      }
      const rec = ingestArtifact(db, argusHome, detection, caseSlug, p, 'agent')
      return JSON.stringify(rec, null, 2)
    },

    async append_finding(args) {
      const { block } = appendFinding(
        {
          db,
          argusHome,
          caseId: deps.caseId,
          caseSlug,
          sessionId,
          turnId: deps.currentTurnId?.() ?? null
        },
        { title: String(args.title ?? 'Finding'), markdown: String(args.markdown ?? '') }
      )
      deps.emitFinding(block)
      return 'finding appended'
    },

    async update_case_status(args) {
      const status = String(args.status ?? '')
      if (!STATUSES.includes(status as CaseStatus)) {
        throw new Error(`Invalid status ${JSON.stringify(status)}; expected ${STATUSES.join('|')}`)
      }
      let resolution: CaseResolution | null = null
      if (status === 'closed') {
        const r = String(args.resolution ?? '')
        if (!CASE_RESOLUTIONS.includes(r as CaseResolution)) {
          throw new Error(`Closing requires a resolution; expected ${CASE_RESOLUTIONS.join('|')}`)
        }
        resolution = r as CaseResolution
      }
      setCaseStatus(db, argusHome, caseSlug, status as CaseStatus, resolution, deps.onCaseClosed)
      return resolution ? `status → ${status} (${resolution})` : `status → ${status}`
    },

    async read_memory(args) {
      const topic = String(args.topic ?? '')
      if (topic === '_index') {
        throw new Error(
          'read_memory: "_index" is not a topic — its enabled lines are already in your context'
        )
      }
      const access = deps.agentAccess?.() ?? defaultAgentAccess()
      if (!topicEnabled(access, topic)) {
        throw new Error(`read_memory: topic "${topic}" is disabled by agent-access settings`)
      }
      const content = readTopic(argusHome, topic) // validates the topic name
      if (!content) {
        throw new Error(
          `read_memory: no such topic "${topic}" — see the index lines in your context`
        )
      }
      return content
    },

    async write_memory(args) {
      return applyMemoryWrite(argusHome, caseSlug, {
        topic: String(args.topic ?? ''),
        content: String(args.content ?? ''),
        indexEntry: args.index_entry == null ? undefined : String(args.index_entry)
      })
    },

    async write_proposal(args) {
      const file = writeProposal(argusHome, caseSlug, {
        type: String(args.type ?? ''),
        target: String(args.target ?? ''),
        title: String(args.title ?? ''),
        content: String(args.content ?? '')
      })
      return (
        `Proposal drafted: proposals/${file}. It is inert — nothing changes until the user ` +
        `accepts it on the Settings → Proposals page. Do not apply the change yourself.`
      )
    },

    async workspace_checkout(args) {
      const wt = await ensureWorktree(
        argusHome,
        caseSlug,
        String(args.repo_path ?? ''),
        String(args.ref ?? '')
      )
      deps.onWorktreeChanged?.(caseSlug)
      return `Checked out ${args.ref} in case worktree: ${wt}\nWork with the code there; the primary checkout is untouched.`
    },

    async open_panel(args) {
      if (!deps.openPanel) throw new Error('open_panel is not available in this session')
      const evId = args.evidence_id == null ? undefined : Number(args.evidence_id)
      return JSON.stringify(
        deps.openPanel(String(args.pack_id ?? ''), String(args.window_id ?? ''), evId),
        null,
        2
      )
    },

    async capture_panel(args) {
      if (!deps.capturePanel) throw new Error('capture_panel is not available in this session')
      const res = await deps.capturePanel(String(args.pack_id ?? ''), String(args.window_id ?? ''))
      if (res.ok) {
        return JSON.stringify(
          {
            ok: true,
            evidence_id: res.evidenceId,
            rel_path: res.relPath,
            artifact_type: res.artifactType,
            hint: 'Use the Read tool on rel_path to view the panel.'
          },
          null,
          2
        )
      }
      return JSON.stringify({ ok: false, reason: res.reason, hint: res.hint }, null, 2)
    }
  }
}

function asText(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] }
}

export interface NativeToolSpec {
  name: string
  description: string
  schema: z.ZodRawShape
}

export const NATIVE_TOOL_SPECS: readonly NativeToolSpec[] = [
  {
    name: 'search_evidence',
    description:
      'FTS search over case evidence, findings and transcripts. Returns hits with relPath + matchLine — cite them as [relPath:line].',
    schema: {
      query: z.string(),
      scope: z.enum(['case', 'all']).optional(),
      artifact_type: z.string().optional()
    }
  },
  {
    name: 'list_evidence',
    description: 'List all evidence artifacts of this case with types and metadata.',
    schema: {}
  },
  {
    name: 'search_case_history',
    description: 'Search summaries of closed past cases by symptom/root-cause text. Read-only.',
    schema: { query: z.string(), limit: z.number().optional() }
  },
  {
    name: 'get_artifact_meta',
    description: 'Full metadata for one evidence artifact.',
    schema: { evidence_id: z.number() }
  },
  {
    name: 'read_lines',
    description:
      'Read a numbered line range from an evidence file of ANY size (fast seek, no offset guessing). Max 500 lines per call. Use the returned line numbers in [relPath:line] citations.',
    schema: { evidence_id: z.number(), from: z.number(), to: z.number() }
  },
  {
    name: 'grep_lines',
    description:
      'Exhaustive line-number search inside ONE evidence file of any size. Pipeline mirrors the viewer: from_line/to_line = cut, filter_query (+filter_regex) = filter, query = search — a line must match filter AND query. Case-insensitive by default; case_sensitive: true applies to both query and filter. Scope with from_line/to_line (e.g. second half of the file); when capped, continue from the reported from_line. Complements search_evidence (cross-evidence FTS, top hits only).',
    schema: {
      evidence_id: z.number(),
      query: z.string(),
      regex: z.boolean().optional(),
      from_line: z.number().optional(),
      to_line: z.number().optional(),
      max_results: z.number().optional(),
      filter_query: z.string().optional(),
      filter_regex: z.boolean().optional(),
      case_sensitive: z.boolean().optional()
    }
  },
  {
    name: 'ingest_artifact',
    description:
      'Register a file you created/derived (inside the case dir) as evidence — it becomes searchable and citable.',
    schema: { path: z.string() }
  },
  {
    name: 'append_finding',
    description:
      'Append a structured finding to findings.md. Include [relPath:line] citations for every evidence claim.',
    schema: { title: z.string(), markdown: z.string() }
  },
  {
    name: 'update_case_status',
    description:
      'Move the case through its lifecycle (open|analyzing|rca-drafted|closed). When setting closed, you MUST pass resolution = solved|rejected|forwarded|wont-fix|duplicate|not-reproducible.',
    schema: { status: z.string(), resolution: z.string().optional() }
  },
  {
    name: 'read_memory',
    description:
      'Load a lesson from agent memory by topic name (the names appear in the Agent memory index lines in your context).',
    schema: { topic: z.string() }
  },
  {
    name: 'write_memory',
    description:
      'Record a durable cross-case lesson in agent memory (memory/<topic>.md). Provide index_entry when creating a topic so future sessions can discover it via _index.md. index_entry is the description ONLY — do not repeat the topic name in it, the index line already links it.',
    schema: { topic: z.string(), content: z.string(), index_entry: z.string().optional() }
  },
  {
    name: 'write_proposal',
    description:
      'Draft a contribute-back proposal (new/edited skill, reference edit, or recipe) as an inert file the user reviews on the Settings → Proposals page. Provide the FULL proposed file content, not a diff.',
    schema: {
      type: z.enum(['skill-new', 'skill-edit', 'reference-edit', 'recipe']),
      target: z.string(),
      title: z.string(),
      content: z.string()
    }
  },
  {
    name: 'workspace_checkout',
    description:
      'Check out a branch/PR ref of a linked repo in a case-scoped worktree. NEVER run git switch/checkout in the primary checkout.',
    schema: { repo_path: z.string(), ref: z.string() }
  },
  {
    name: 'open_panel',
    description:
      "Open or focus a pack's window (webPanel or externalApp) in this case, optionally on a specific evidence item (webPanel only). Returns {ok, panel|reason}. Call this before a panel/app command if it may be closed.",
    schema: { pack_id: z.string(), window_id: z.string(), evidence_id: z.number().optional() }
  },
  {
    name: 'capture_panel',
    description:
      'Screenshot an OPEN pack panel into case evidence, then use Read on the returned rel_path to view it. The panel must already be open — call open_panel first if it may be closed. Returns {ok, evidence_id, rel_path, artifact_type} — use the Read tool on rel_path to view the capture — or {ok:false, reason}.',
    schema: { pack_id: z.string(), window_id: z.string() }
  }
]

export function createArgusMcpServer(deps: NativeToolDeps): ReturnType<typeof createSdkMcpServer> {
  const h = argusToolHandlers(deps)
  return createSdkMcpServer({
    name: 'argus',
    version: '1.0.0',
    tools: NATIVE_TOOL_SPECS.map((s) =>
      tool(s.name, s.description, s.schema, async (a) =>
        asText(await h[s.name as keyof typeof h](a))
      )
    )
  })
}
