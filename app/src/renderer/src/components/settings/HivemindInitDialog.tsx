import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Btn, Chip, Skeleton } from '../ui'
import { confirm as askConfirm } from '../../lib/confirmStore'
import type {
  HivemindInitOutcome,
  HivemindInitPreview,
  HivemindInitResult
} from '../../../../shared/hivemind'

const OUTCOME_LABEL: Record<HivemindInitOutcome, string> = {
  initialized: 'Initial commit pushed',
  created: 'PR opened',
  updated: 'PR updated',
  unchanged: 'Already set up'
}

/**
 * Preview → act flow for scaffolding an empty HiveMind repo (spec 2026-09-07). Mirrors
 * SharePushDialog's shape, minus the editable PR title — the title here is fixed, since this
 * proposes the repo layout itself, not a named user asset.
 */
export function HivemindInitDialog({
  onClose,
  onBusyChange,
  onDone
}: {
  onClose: () => void
  onBusyChange?: (busy: boolean) => void
  /** Called once init() succeeds, so the host can refresh its payload immediately. */
  onDone: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<HivemindInitPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blockedByPrUrl, setBlockedByPrUrl] = useState<string | null>(null)
  const [result, setResult] = useState<HivemindInitResult | null>(null)

  useEffect(() => {
    let mounted = true
    window.argus.hivemind
      .initPreview()
      .then((p) => mounted && setPreview(p))
      .catch((e) => mounted && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  async function run(): Promise<void> {
    if (busy || !preview) return
    if (preview.noCommits) {
      const ok = await askConfirm({
        title: 'Push the initial commit?',
        message:
          'This repository has no commits yet, so there is nothing to open a pull request against — Argus will push directly to its default branch instead of proposing a change for review.',
        confirmLabel: 'Push'
      })
      if (!ok) return
    }
    setBusy(true)
    onBusyChange?.(true)
    setError(null)
    setBlockedByPrUrl(null)
    try {
      const r = await window.argus.hivemind.init()
      if (r.ok) {
        setResult(r)
        onDone()
      } else {
        setError(r.error)
        if (r.blockedByPrUrl) setBlockedByPrUrl(r.blockedByPrUrl)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  if (result?.ok) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm">
        <Chip tone="signal">{OUTCOME_LABEL[result.outcome]}</Chip>
        {result.prUrl && (
          <Btn variant="ghost" onClick={() => void window.argus.openExternal(result.prUrl!)}>
            {result.prUrl}
            <ExternalLink size={12} aria-hidden="true" />
          </Btn>
        )}
        <Btn variant="outline" onClick={onClose}>
          Done
        </Btn>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      {blockedByPrUrl && (
        <div className="flex items-center gap-2 text-xs text-dim">
          <Btn variant="ghost" onClick={() => void window.argus.openExternal(blockedByPrUrl)}>
            {blockedByPrUrl}
          </Btn>
        </div>
      )}
      {preview === null ? (
        <div role="status" aria-label="Loading preview" className="flex flex-col gap-1.5 py-1">
          <Skeleton className="h-2 w-[80%]" />
          <Skeleton className="h-2 w-[65%]" />
        </div>
      ) : (
        <>
          <p className="text-xs text-dim">
            {preview.missing.length === 0
              ? 'The layout is already complete — nothing to add.'
              : `Adds: ${preview.missing.join(', ')}`}
          </p>
          {preview.missing.includes('README.md') && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
              {preview.readme}
            </pre>
          )}
        </>
      )}
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          disabled={busy || preview === null || preview.missing.length === 0}
          onClick={() => void run()}
        >
          {busy
            ? preview?.noCommits
              ? 'Pushing…'
              : 'Opening…'
            : preview?.noCommits
              ? 'Push initial commit'
              : 'Open pull request'}
        </Btn>
        <Btn variant="dangerSolid" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  )
}
