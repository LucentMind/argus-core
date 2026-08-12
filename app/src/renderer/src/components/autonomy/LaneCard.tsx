import { useState } from 'react'
import { TIER_MIN, type LaneStatus } from '../../../../shared/autonomy'
import { Btn } from '../ui'

function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** One lane's tier, bar-clearance and event history — the unit the Autonomy page repeats per
 *  lane (spec 2026-08-11-autonomy-ledger-design). Promote/demote both go through the same
 *  inline note + confirm affordance rather than window.confirm (repo convention: no native
 *  confirm/alert), and rely on the `autonomyChanged` broadcast to refresh the store — the
 *  preload call's own resolved payload is ignored, same as ProposalsStandalone's act(). */
export default function LaneCard({ lane }: { lane: LaneStatus }): React.JSX.Element {
  const [verb, setVerb] = useState<'promote' | 'demote' | null>(null)
  const [note, setNote] = useState('')
  const m = lane.metrics

  async function commit(): Promise<void> {
    if (verb === 'promote') await window.argus.autonomy.promote(lane.lane, note.trim())
    if (verb === 'demote') await window.argus.autonomy.demote(lane.lane, note.trim())
    setVerb(null)
    setNote('')
  }

  return (
    <div className="rounded-r3 border border-hair bg-panel p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-base font-medium text-ink">{lane.label}</h3>
        <span className="rounded-r1 bg-signal/15 px-1.5 font-mono text-sm text-signal">
          A{lane.tier}
        </span>
        {lane.tier !== lane.baseline && (
          <span className="text-xs text-mute">baseline A{lane.baseline}</span>
        )}
        <span
          className={`ml-auto rounded-full px-2 text-xs ${
            lane.clearsBar ? 'bg-review/15 text-review' : 'bg-defect/15 text-defect'
          }`}
        >
          {lane.clearsBar ? 'clears bar' : 'below bar'}
        </span>
      </div>
      <p className="mt-1 text-sm text-dim">
        {m.decisions} decisions · {pct(m.acceptanceRate)} accepted ·{' '}
        {m.costUsd === null ? 'cost unattributed' : `$${m.costUsd.toFixed(2)}`}
      </p>
      <p className="text-xs text-mute">
        bar: ≥{lane.bar.minDecisions} decisions at ≥{Math.round(lane.bar.minAcceptanceRate * 100)}%
        {m.dataStart ? ` · data since ${m.dataStart.slice(0, 10)}` : ' · no stamped data yet'}
      </p>
      {Object.keys(m.depth).length > 0 && (
        <p className="text-xs text-mute">
          {Object.entries(m.depth)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}
        </p>
      )}
      {Object.keys(m.rejectReasons).length > 0 && (
        <p className="text-xs text-mute">
          rejected:{' '}
          {Object.entries(m.rejectReasons)
            .map(([k, v]) => `${k} ×${v}`)
            .join(', ')}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Btn
          variant="outline"
          disabled={!lane.clearsBar}
          title={lane.clearsBar ? 'Record a promotion' : 'Lane must clear its bar first'}
          onClick={() => setVerb('promote')}
        >
          Promote
        </Btn>
        <Btn variant="outline" disabled={lane.tier <= TIER_MIN} onClick={() => setVerb('demote')}>
          Demote
        </Btn>
      </div>
      {verb && (
        <div className="mt-2">
          <textarea
            className="w-full rounded-r2 border border-hair bg-transparent p-2 text-sm text-ink"
            rows={2}
            placeholder={`Why ${verb} this lane? (recorded in the ledger)`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="mt-1 flex gap-2">
            <Btn variant="primary" onClick={() => void commit()}>
              Record {verb}
            </Btn>
            <Btn variant="ghost" onClick={() => setVerb(null)}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
      {lane.events.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-hair pt-2 text-xs text-dim">
          {lane.events.map((e) => (
            <li key={e.id} className="flex items-center gap-2">
              <span className="font-mono">
                {e.createdAt.slice(0, 10)} {e.kind} A{e.fromTier}→A{e.toTier}
              </span>
              {e.note && <span className="truncate text-mute">{e.note}</span>}
              {e.kind === 'auto-demote' && e.acknowledgedAt === null && (
                <Btn
                  variant="outline"
                  className="ml-auto border-defect/40 text-defect hover:bg-defect/10"
                  onClick={() => void window.argus.autonomy.ack(e.id)}
                >
                  Acknowledge
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
