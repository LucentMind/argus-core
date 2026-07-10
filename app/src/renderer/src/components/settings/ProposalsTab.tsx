import { useEffect, useState } from 'react'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { diffLines } from '../../lib/lineDiff'
import type { ProposalRecord, ProposalsPayload } from '../../../../shared/proposals'

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

export function ProposalsTab({
  onCountChange
}: {
  onCountChange: (n: number) => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<ProposalsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function apply(p: ProposalsPayload): void {
    setPayload(p)
    onCountChange(p.proposals.length)
  }

  useEffect(() => {
    let mounted = true
    void window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) {
          setPayload(p)
          onCountChange(p.proposals.length)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
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
      {payload.proposals.length === 0 ? (
        <div className="px-1 py-2 text-sm text-dim">
          No pending proposals — the agent drafts them via /contribute-back (write_proposal).
        </div>
      ) : (
        payload.proposals.map((p) => (
          <SettingsSection key={p.file} title={p.title}>
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              <Chip tone="neutral">{p.type}</Chip>
              <Chip tone="neutral">→ {p.target}</Chip>
              <Chip tone="neutral">{p.caseSlug}</Chip>
              <span className="text-xs text-mute">{new Date(p.date).toLocaleString()}</span>
              {p.current === null && <Chip tone="review">new file</Chip>}
            </div>
            <ProposalDiff p={p} />
            <div className="flex items-center gap-2 px-4 py-3">
              <Btn
                variant="primary"
                aria-label={`Accept ${p.title}`}
                disabled={busy}
                onClick={() => void act(() => window.argus.proposals.accept(p.file))}
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
            </div>
          </SettingsSection>
        ))
      )}
    </div>
  )
}
