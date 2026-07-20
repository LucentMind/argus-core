import { useState } from 'react'
import { Btn, Chip } from '../ui'
import { DiffView } from './DiffView'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import type { SyncReport } from '../../../../shared/referenceSync'

/**
 * Final step of the space dialog (spec §3.2): per-draft diff with an
 * approve checkbox (defaults all-checked), must-keep guard warnings, and
 * unrouted/conflict/failure sections above the drafts. Apply sends only the
 * currently-approved targets.
 */
export function SyncReportView({ report }: { report: SyncReport }): React.JSX.Element {
  const [approved, setApproved] = useState<Set<string>>(
    () => new Set(report.drafts.map((d) => d.target))
  )
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<{
    written: string[]
    skipped: Array<{ target: string; reason: string }>
  } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  // Pruning is opt-in per file and defaults OFF: a distilled reference can still hold
  // hand-reviewed value after its Confluence source is deleted, so nothing goes without
  // an explicit tick.
  const [toPrune, setToPrune] = useState<Set<string>>(() => new Set())
  const [pruning, setPruning] = useState(false)
  const [pruned, setPruned] = useState<{ removed: string[]; trimmed: string[] } | null>(null)
  const [pruneError, setPruneError] = useState<string | null>(null)

  const prune = async (): Promise<void> => {
    setPruning(true)
    setPruneError(null)
    try {
      setPruned(await window.argus.refsync.prune(report.syncId, [...toPrune]))
      referenceSyncStore.set(await window.argus.refsync.get())
    } catch (err) {
      setPruneError((err as Error).message)
    } finally {
      setPruning(false)
    }
  }

  const apply = async (): Promise<void> => {
    setApplying(true)
    setApplyError(null)
    try {
      setApplied(await window.argus.refsync.applyDrafts(report.syncId, [...approved]))
      referenceSyncStore.set(await window.argus.refsync.get())
    } catch (err) {
      setApplyError((err as Error).message)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-dim text-xs">
        {report.selectedCount} page(s) in selection · {report.drafts.length} file(s) changed
      </div>
      {report.conflicts.length > 0 && (
        <div className="text-xs">
          {report.conflicts.map((c) => (
            <div key={c.target}>
              <Chip tone="danger">conflict</Chip> {c.target} — trust_tier {c.tier}, never
              auto-overwritten
            </div>
          ))}
        </div>
      )}
      {report.failures.length > 0 && (
        <div className="text-danger text-xs" role="alert">
          {report.failures.map((f) => (
            <div key={f.target}>
              {f.target} failed: {f.error}
            </div>
          ))}
        </div>
      )}
      {report.unrouted.length > 0 && (
        <div className="text-xs">
          <div className="text-mute">
            Unrouted pages (add a routing rule in config/reference-sync.json):
          </div>
          {report.unrouted.map((u) => (
            <div key={u.id} className="text-dim">
              {u.title}
            </div>
          ))}
        </div>
      )}
      {report.vanished.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          <div className="text-mute">
            Pages that no longer exist upstream. Removing a fully-orphaned file deletes it;
            otherwise only the dead source links are dropped.
          </div>
          {report.vanished.map((v) => (
            <label key={v.target} className="text-dim flex items-start gap-2">
              <input
                type="checkbox"
                aria-label={`Prune ${v.target}`}
                checked={toPrune.has(v.target)}
                disabled={pruning || pruned != null}
                onChange={(e) =>
                  setToPrune((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(v.target)
                    else next.delete(v.target)
                    return next
                  })
                }
              />
              <span>
                <span className="text-ink">{v.target}</span>{' '}
                <Chip tone={v.orphaned ? 'danger' : 'review'}>
                  {v.orphaned ? 'orphaned' : `${v.pages.length} source(s) gone`}
                </Chip>
                <span className="block text-mute">{v.pages.map((p) => p.title).join(', ')}</span>
              </span>
            </label>
          ))}
          {pruned ? (
            <div className="text-mute" role="status">
              removed {pruned.removed.length}, trimmed {pruned.trimmed.length}
            </div>
          ) : (
            <span>
              <Btn
                variant="danger"
                disabled={pruning || toPrune.size === 0}
                onClick={() => void prune()}
              >
                {pruning ? 'Removing…' : `Remove ${toPrune.size} selected`}
              </Btn>
            </span>
          )}
          {pruneError && (
            <div className="text-danger" role="alert">
              {pruneError}
            </div>
          )}
        </div>
      )}
      {report.drafts.map((d) => (
        <div key={d.target} className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={`approve · ${d.target}`}
              checked={approved.has(d.target)}
              disabled={applied != null}
              onChange={(e) => {
                const next = new Set(approved)
                if (e.target.checked) next.add(d.target)
                else next.delete(d.target)
                setApproved(next)
              }}
            />
            <span className="font-mono">{d.target}</span>
            <span className="text-faint text-xs">{d.pages.length} source page(s)</span>
          </label>
          {d.guardMisses.length > 0 && (
            <div role="alert" className="text-danger text-xs">
              must-keep patterns missing from this draft: {d.guardMisses.join(' · ')} — review
              before applying (config `mustKeep` in reference-sync.json)
            </div>
          )}
          <DiffView oldText={d.oldBody} newText={d.newBody} />
        </div>
      ))}
      {applied ? (
        <div className="text-xs" role="status">
          wrote {applied.written.length} file(s)
          {applied.skipped.map((s) => (
            <div key={s.target} className="text-danger">
              skipped {s.target}: {s.reason}
            </div>
          ))}
        </div>
      ) : null}
      {applyError && (
        <div role="alert" className="text-danger text-xs">
          {applyError}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {!applied && report.drafts.length > 0 && (
          <Btn
            variant="primary"
            onClick={() => void apply()}
            disabled={applying || approved.size === 0}
          >
            {`Apply ${approved.size} file${approved.size === 1 ? '' : 's'}`}
          </Btn>
        )}
      </div>
    </div>
  )
}
