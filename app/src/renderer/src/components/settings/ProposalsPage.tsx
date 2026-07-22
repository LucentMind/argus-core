import { useEffect, useState } from 'react'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip, SectionLabel } from '../ui'
import { diffLines } from '../../lib/lineDiff'
import { MessageView } from '../MessageView'
import { SharePushDialog } from './SharePushDialog'
import { useSettingsPayload } from '../../lib/settingsStore'
import { PROPOSAL_TYPE_LABELS } from '../../../../shared/proposals'
import type {
  AcceptedTarget,
  ProposalRecord,
  ProposalsPayload,
  ProposalType
} from '../../../../shared/proposals'

const noop = (): void => undefined

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

function ProposalDiff({ p }: { p: ProposalRecord }): React.JSX.Element {
  const lines = diffLines(p.current ?? '', p.content)
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">
      {lines.map((l, i) => (
        <div key={i} className={KIND_CLASS[l.kind]}>
          {KIND_PREFIX[l.kind]}
          {l.text}
        </div>
      ))}
    </pre>
  )
}

export function ProposalsPage({
  initialTypes,
  onOpenHivemind
}: {
  initialTypes?: readonly ProposalType[]
  onOpenHivemind?: () => void
} = {}): React.JSX.Element {
  const [payload, setPayload] = useState<ProposalsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<ReadonlySet<ProposalType>>(new Set(initialTypes ?? []))
  const [editing, setEditing] = useState<Record<string, string>>({})
  type Accepted = { file: string; title: string; target: AcceptedTarget }
  const [justAccepted, setJustAccepted] = useState<Accepted[]>([])
  const [sharing, setSharing] = useState<string | null>(null)
  const settings = useSettingsPayload()
  const repoSet = (settings?.settings.hivemind.repo ?? '').trim() !== ''

  function toggleType(t: ProposalType): void {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  function apply(p: ProposalsPayload): void {
    setPayload(p)
  }

  useEffect(() => {
    let mounted = true
    void window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) {
          setPayload(p)
        }
      })
      .catch((e) => {
        if (mounted) {
          setPayload({ proposals: [] })
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      mounted = false
    }
  }, [])

  async function act(fn: () => Promise<ProposalsPayload>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      apply(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!payload) return <div className="text-dim">loading…</div>

  const typesPresent = Array.from(new Set(payload.proposals.map((p) => p.type)))
  // active may contain types no longer present (e.g. the last proposal of that type was just
  // accepted/rejected) — intersect with what's actually here so a stale chip can't hide everything.
  const effective = new Set([...active].filter((t) => typesPresent.includes(t)))
  const filtered =
    effective.size === 0
      ? payload.proposals
      : payload.proposals.filter((p) => effective.has(p.type))
  const sorted = [...filtered].sort(
    (a, b) => a.caseSlug.localeCompare(b.caseSlug) || b.date.localeCompare(a.date)
  )

  function toggleEdit(p: ProposalRecord): void {
    setEditing((prev) => {
      const next = { ...prev }
      if (p.file in next) {
        delete next[p.file]
      } else {
        next[p.file] = p.content
      }
      return next
    })
  }

  let lastCaseSlug: string | null = null

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      {typesPresent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <span className="text-xs text-mute">Filter</span>
          {typesPresent.map((t) => (
            <button
              key={t}
              aria-pressed={active.has(t)}
              aria-label={`Filter ${PROPOSAL_TYPE_LABELS[t]}`}
              onClick={() => toggleType(t)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${active.has(t) ? 'border-signal text-ink' : 'border-hair text-dim hover:text-ink'}`}
            >
              {PROPOSAL_TYPE_LABELS[t]} · {payload.proposals.filter((p) => p.type === t).length}
            </button>
          ))}
        </div>
      )}
      {justAccepted.map((a) => {
        const pushKind =
          a.target.kind === 'skill' || a.target.kind === 'reference' ? a.target.kind : null
        return (
          <div
            key={a.file}
            className="flex flex-col rounded-r2 border border-signal/30 bg-signal/5"
          >
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
              <Chip tone="signal">accepted</Chip>
              <span className="flex-1 text-ink">“{a.title}” accepted into your library.</span>
              {pushKind && repoSet && (
                <Btn
                  variant="outline"
                  aria-label={`Share to HiveMind: ${a.target.name}`}
                  onClick={() => setSharing(sharing === a.file ? null : a.file)}
                >
                  Share to HiveMind
                </Btn>
              )}
              {pushKind && !repoSet && onOpenHivemind && (
                <Btn variant="ghost" onClick={onOpenHivemind}>
                  Set up HiveMind to share →
                </Btn>
              )}
            </div>
            {pushKind && sharing === a.file && (
              <SharePushDialog
                kind={pushKind}
                name={a.target.name}
                onClose={() => setSharing(null)}
              />
            )}
          </div>
        )
      })}
      {payload.proposals.length === 0 ? (
        <div className="px-1 py-2 text-sm text-dim">
          No pending proposals — the agent drafts them during sessions (write_proposal /
          /contribute-back) and after case distillation.
        </div>
      ) : (
        sorted.map((p) => {
          const showCaseHeader = p.caseSlug !== lastCaseSlug
          lastCaseSlug = p.caseSlug
          const isEditing = p.file in editing
          const isMarkdown = p.type === 'memory-append' || p.type === 'case-summary'
          return (
            <div key={p.file} className="flex flex-col gap-2">
              {showCaseHeader && <SectionLabel>Case: {p.caseSlug}</SectionLabel>}
              <SettingsSection title={p.title}>
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                  <Chip tone="neutral">{PROPOSAL_TYPE_LABELS[p.type]}</Chip>
                  {p.type !== 'case-summary' && <Chip tone="neutral">→ {p.target}</Chip>}
                  <span className="text-xs text-mute">{new Date(p.date).toLocaleString()}</span>
                  {p.current === null && <Chip tone="review">new file</Chip>}
                  {p.previouslyReviewed && <Chip tone="review">previously reviewed</Chip>}
                </div>
                {isEditing ? (
                  <textarea
                    aria-label="Edit proposal content"
                    className="max-h-64 w-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs"
                    rows={8}
                    value={editing[p.file]}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [p.file]: e.target.value }))}
                  />
                ) : isMarkdown ? (
                  <div className="px-4 py-3">
                    <MessageView markdown={p.content} onCite={noop} />
                  </div>
                ) : (
                  <ProposalDiff p={p} />
                )}
                <div className="flex items-center gap-2 px-4 py-3">
                  <Btn
                    variant="primary"
                    aria-label={`Accept ${p.title}`}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await (isEditing
                          ? window.argus.proposals.accept(p.file, editing[p.file])
                          : window.argus.proposals.accept(p.file))
                        setJustAccepted((prev) => [
                          ...prev,
                          { file: p.file, title: p.title, target: r.accepted }
                        ])
                        return r
                      })
                    }
                  >
                    Accept
                  </Btn>
                  <Btn
                    variant="danger"
                    aria-label={`Reject ${p.title}`}
                    disabled={busy}
                    onClick={() => void act(() => window.argus.proposals.reject(p.file))}
                  >
                    Reject
                  </Btn>
                  <Btn
                    variant="outline"
                    aria-label={`Edit ${p.title}`}
                    onClick={() => toggleEdit(p)}
                  >
                    Edit
                  </Btn>
                </div>
              </SettingsSection>
            </div>
          )
        })
      )}
    </div>
  )
}
