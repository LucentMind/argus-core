import { Plus } from 'lucide-react'
import { Chip, MenuButton } from '../ui'
import { DRIVERS, getDriver } from '../../../../shared/drivers'
import type { ProviderInstance } from '../../../../shared/settings'

/**
 * Provider-instance picker + "Add provider" affordance (settings has no other way to
 * select or create an instance — `AgentSettings` otherwise only ever renders the one
 * instance named by `activeInstanceId`). Deliberately no delete/rename/enable-toggle
 * here (YAGNI): those aren't trivially consistent with existing idioms and nothing
 * in this codebase can currently disable an instance either.
 */
export function ProviderInstances({
  providerInstances,
  activeInstanceId,
  onSelect,
  onAdd
}: {
  providerInstances: Record<string, ProviderInstance>
  activeInstanceId: string
  onSelect: (id: string) => void
  onAdd: (driverKind: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(providerInstances).map(([id, inst]) => {
          const driver = getDriver(inst.driver)
          const active = id === activeInstanceId
          const label = inst.displayName?.trim() || driver?.label || inst.driver
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              aria-label={`Switch to ${label}`}
              disabled={!inst.enabled}
              onClick={() => onSelect(id)}
              className={`flex items-center gap-1.5 rounded-r2 border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? 'border-signal/40 bg-signal/10 text-ink'
                  : 'border-hair text-dim hover:border-hair2 hover:text-ink'
              }`}
            >
              <span className="max-w-40 truncate">{label}</span>
              {driver?.shortLabel && (
                <Chip tone={active ? 'signal' : 'neutral'}>{driver.shortLabel}</Chip>
              )}
              {active && <Chip tone="signal">active</Chip>}
              {!inst.enabled && <Chip tone="neutral">disabled</Chip>}
            </button>
          )
        })}
      </div>
      <MenuButton
        label={
          <span className="flex items-center gap-1.5">
            <Plus size={13} strokeWidth={1.5} /> Add provider
          </span>
        }
        variant="ghost"
        align="left"
        aria-label="Add provider"
        items={Object.values(DRIVERS).map((d) => ({
          label: d.label,
          onSelect: () => onAdd(d.kind)
        }))}
      />
    </div>
  )
}
