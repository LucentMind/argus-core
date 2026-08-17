import { useEffect, useState } from 'react'
import { SettingsSection } from '../settings/settingsLayout'
import type { RejectDigest } from '../../../../shared/distill'

/**
 * Read-only viewer for the reject-pattern digest (spec §5) — `proposals/reject-patterns.md`,
 * shown next to the proposals queue rather than buried in Settings, since it explains WHY the
 * distiller avoided a direction, which is most useful right where a reviewer is looking at
 * what it proposed instead.
 *
 * Hidden entirely (renders nothing) until a digest has actually been built once: `null` from
 * `readRejectDigest` means "no rejects have accumulated enough yet" (spec's 5-reject trigger),
 * and an empty collapsed section with nothing to say would just be a confusing extra row.
 *
 * Collapsed by default — this is background/explanatory material, not the primary task.
 */
export function RejectDigestPanel(): React.JSX.Element | null {
  const [digest, setDigest] = useState<RejectDigest | null | undefined>(undefined)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    let stale = false
    void window.argus.proposals.rejectDigest().then((d) => {
      if (!stale) setDigest(d)
    })
    return () => {
      stale = true
    }
  }, [])

  if (!digest) return null

  const bullets = digest.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return (
    <SettingsSection
      title="Observed failure patterns"
      subtitle={`Built ${digest.builtAt.slice(0, 10)} from ${digest.rejectCount} rejected proposals — the distiller is told not to propose in these directions.`}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
    >
      <ul className="flex flex-col gap-1 px-4 py-3 text-xs text-dim">
        {bullets.map((line, i) => (
          <li key={i}>{line.replace(/^- /, '')}</li>
        ))}
      </ul>
    </SettingsSection>
  )
}
