import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { MenuButton } from '../ui'
import { DRIVERS } from '../../../../shared/drivers'
import { relativeChecked } from '../../lib/relativeTime'
import type { ProviderInstance } from '../../../../shared/settings'
import type { ProviderStatus } from '../../../../shared/types'

/**
 * "Checked just now" for the provider section header. One label for the whole section (the
 * newest probe wins) rather than per row — the refresh button is section-wide too, and a
 * timestamp on every row would be noise.
 */
export function LastChecked({
  statuses
}: {
  statuses: ProviderStatus[]
}): React.JSX.Element | null {
  // Re-render on a timer so "just now" becomes "1m ago" without a new probe.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const newest = statuses
    .map((s) => s.checkedAt)
    .filter((c): c is string => c != null)
    .sort()
    .at(-1)
  if (!newest) return null
  return <span className="text-xs text-faint">Checked {relativeChecked(newest, now)}</span>
}

/**
 * "Add provider", offering only drivers not already present. With no delete affordance a
 * second instance of a driver would be permanent, so the entry is hidden rather than
 * disabled; the whole button disappears once every driver is added.
 */
export function AddProviderMenu({
  providerInstances,
  onAdd
}: {
  providerInstances: Record<string, ProviderInstance>
  onAdd: (driverKind: string) => void
}): React.JSX.Element | null {
  const added = new Set(Object.values(providerInstances).map((i) => i.driver))
  const addable = Object.values(DRIVERS).filter((d) => !added.has(d.kind))
  if (addable.length === 0) return null
  return (
    <MenuButton
      label={<Plus size={13} strokeWidth={1.5} />}
      variant="ghost"
      align="right"
      aria-label="Add provider"
      items={addable.map((d) => ({ label: d.label, onSelect: () => onAdd(d.kind) }))}
    />
  )
}
