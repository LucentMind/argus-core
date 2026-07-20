// Pure triage derivation shared by the main process (sorting in listCases) and
// the renderer (card rendering). MUST NOT import from src/main — tsconfig.web
// excludes it, and such an import drags node:sqlite into typecheck:web.
import type { CaseRecord } from './types'

export type ActionItemKind = 'sync-error' | 'status' | 'comments' | 'attachments' | 'stale' | 'idle'

export interface ActionItem {
  kind: ActionItemKind
  severity: 'action' | 'info'
  label: string
}

/** Rank order — lower sorts first. Also the order items appear on a card. */
const KIND_ORDER: ActionItemKind[] = [
  'sync-error',
  'status',
  'comments',
  'attachments',
  'stale',
  'idle'
]

const STALE_AFTER_DAYS = 7
// Reserved for the 'idle' kind, emitted starting in Task 5 (needs an evidence
// count CaseRecord does not carry yet). Unused here by design; see the note
// at the bottom of deriveActionItems. Exported (rather than
// eslint-disable-next-line'd) so tsc's noUnusedLocals doesn't flag it now that
// this module is reachable from tsconfig.node.json's program too.
export const IDLE_AFTER_DAYS = 14
const DAY_MS = 86_400_000

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / DAY_MS)
}

function plural(n: number, noun: string): string {
  return `${n} new ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Derives what needs attention on a case. Pure: a function of the record alone.
 *
 * A null reviewBaseline means "nothing known to have changed" — NOT "everything
 * changed". Every case predates this feature at migration time, so treating null
 * as all-new would light up every card at once.
 */
export function deriveActionItems(c: CaseRecord, now: Date = new Date()): ActionItem[] {
  const items: ActionItem[] = []

  if (c.lastSyncError) {
    items.push({
      kind: 'sync-error',
      severity: 'action',
      label: `sync failed — ${c.lastSyncError.code}`
    })
  }

  const base = c.reviewBaseline
  if (base) {
    if (c.jiraStatus && c.jiraStatus !== base.status) {
      items.push({ kind: 'status', severity: 'action', label: `status → ${c.jiraStatus}` })
    }
    const newComments = (c.jiraCommentCount ?? 0) - base.commentCount
    if (newComments > 0) {
      items.push({ kind: 'comments', severity: 'action', label: plural(newComments, 'comment') })
    }
    const known = new Set(base.attachmentIds)
    const fresh = c.jiraAttachmentIds.filter((id) => !known.has(id)).length
    if (fresh > 0) {
      items.push({ kind: 'attachments', severity: 'action', label: plural(fresh, 'attachment') })
    }
  }

  if (c.jiraKey && c.jiraSyncedAt) {
    const days = daysBetween(c.jiraSyncedAt, now)
    if (days > STALE_AFTER_DAYS) {
      items.push({ kind: 'stale', severity: 'info', label: `synced ${days}d ago` })
    }
  }

  return items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

/**
 * Sort key for the overview — lower sorts first. Any action item outranks
 * info-only, which outranks an untouched case. Callers break ties on updatedAt.
 */
export function triageRank(items: ActionItem[]): number {
  if (items.length === 0) return 100
  const best = items.reduce((lo, i) => Math.min(lo, KIND_ORDER.indexOf(i.kind)), KIND_ORDER.length)
  return items.some((i) => i.severity === 'action') ? best : 50 + best
}
