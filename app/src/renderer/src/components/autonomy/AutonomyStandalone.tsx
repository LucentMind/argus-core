import { useState } from 'react'
import type { PostResults } from '../../../../shared/rca'
import { useAutonomy } from '../../lib/autonomyStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { Btn, SectionLabel } from '../ui'
import LaneCard from './LaneCard'

function human(ms: number): string {
  const h = ms / 3600000
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`
}

/** Full-page autonomy ledger (spec 2026-08-11-autonomy-ledger-design): global tiles, one
 *  LaneCard per lane, and the day-90 decision-review report. Mirrors ProposalsStandalone's
 *  standing as a top-level work surface reached from the top bar, not a Settings page. */
export default function AutonomyStandalone({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  useEscapeLayer({ onEscape: onClose })
  const payload = useAutonomy()
  const [report, setReport] = useState<{ file: string; markdown: string } | null>(null)
  const [postResult, setPostResult] = useState<PostResults | null>(null)
  const [busy, setBusy] = useState(false)

  if (!payload) return <div className="p-8 text-sm text-dim">Loading autonomy ledger…</div>

  const t = payload.timeInTriage
  return (
    <div className="mx-auto w-full max-w-5xl p-8">
      <h1 className="text-xl font-semibold text-ink">Autonomy</h1>
      <p className="text-sm text-dim">
        A-tier per lane, earned on evidence · {payload.windowDays}-day window
      </p>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-r3 border border-hair bg-panel p-3">
          <SectionLabel>Time in triage</SectionLabel>
          <p className="mt-1 text-sm text-ink">
            {t.medianMs === null
              ? 'no routed hypotheses yet'
              : `median ${human(t.medianMs)} · p90 ${human(t.p90Ms ?? t.medianMs)} · ${t.cases} cases`}
          </p>
        </div>
        <div className="rounded-r3 border border-hair bg-panel p-3">
          <SectionLabel>Cost per resolved case</SectionLabel>
          <p className="mt-1 text-sm text-ink">
            {payload.costPerResolvedCaseUsd === null
              ? 'no resolved cases'
              : `$${payload.costPerResolvedCaseUsd.toFixed(2)} · ${payload.resolvedCases} resolved`}
          </p>
        </div>
        <div className="rounded-r3 border border-hair bg-panel p-3">
          <SectionLabel>Unacknowledged demotions</SectionLabel>
          <p className="mt-1 text-sm text-ink">{payload.unackedDemotions}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {payload.lanes.map((l) => (
          <LaneCard key={l.lane} lane={l} />
        ))}
      </div>

      <div className="mt-6 rounded-r3 border border-hair bg-panel p-4">
        <h2 className="text-base font-medium text-ink">Decision-review report</h2>
        <p className="text-xs text-mute">
          The day-90 pack: per-lane rates, cost, time-in-triage, tier history.
        </p>
        <div className="mt-2 flex gap-2">
          <Btn
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.argus.autonomy
                .reportGenerate()
                .then((r) => {
                  setReport(r)
                  setPostResult(null)
                })
                .finally(() => setBusy(false))
            }}
          >
            Generate report
          </Btn>
          <Btn
            variant="outline"
            disabled={busy || report === null}
            onClick={() => {
              if (!report) return
              setBusy(true)
              void window.argus.autonomy
                .reportPost(report.file)
                .then(setPostResult)
                .finally(() => setBusy(false))
            }}
          >
            Post to Confluence
          </Btn>
        </div>
        {postResult?.confluencePage && (
          <p className="mt-2 text-sm text-ink">
            {postResult.confluencePage.ok
              ? `Posted: ${postResult.confluencePage.url ?? 'page created'}`
              : `Post failed: ${postResult.confluencePage.error}`}
          </p>
        )}
        {report && (
          <>
            <p className="mt-2 font-mono text-xs text-mute">{report.file}</p>
            <pre className="mt-1 max-h-80 overflow-auto rounded-r2 bg-hair/50 p-3 text-xs text-ink">
              {report.markdown}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
