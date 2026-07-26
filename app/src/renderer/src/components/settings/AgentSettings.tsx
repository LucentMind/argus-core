import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { Btn, Chip, IconBtn } from '../ui'
import {
  SettingsSection,
  SettingRow,
  SelectField,
  FIELD,
  DraftInput,
  DraftTextarea
} from './settingsLayout'
import { AnnotatedForm } from './AnnotatedForm'
import { DistillationSection } from './DistillationSection'
import { ProviderModels } from './ProviderModels'
import { ProviderRow } from './ProviderRow'
import { AddProviderMenu, LastChecked } from './providerHeader'
import { defaultInstanceId, getDriver, nextInstanceId } from '../../../../shared/drivers'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type PermissionMode,
  type SettingsPayload
} from '../../../../shared/settings'
import type { ProviderStatus } from '../../../../shared/types'

const MODE_BY_LABEL = Object.fromEntries(
  PERMISSION_MODES.map((m) => [PERMISSION_MODE_LABELS[m], m])
) as Record<string, PermissionMode>

/** Used as BOTH the danger row's description and the confirm dialog's body, so the promise
 *  made before the click and the one made during it cannot drift apart. */
const REMOVE_MESSAGE =
  "This deletes the provider's configuration and model preferences. Chats already using it fall back to the default provider."

const DISTILL_NOTE =
  'It is also your distillation provider — distillation will revert to auto-resolve.'

const LAST_PROVIDER_NOTE = "Your only provider can't be removed."

export function AgentSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const a = payload.settings.agent
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Statuses are pushed from the main process (periodic re-probe, settings change), so the
  // page never has to poll — it just re-reads whenever it's told something moved.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.argus.providers.statuses().then((s) => {
        if (alive) setStatuses(s)
      })
    }
    load()
    const off = window.argus.providers.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])

  function patchAgent(p: Record<string, unknown>): void {
    void settingsStore.patch({ agent: p })
  }
  function patchInstance(id: string, p: Record<string, unknown>): void {
    patchAgent({ providerInstances: { [id]: p } })
  }

  /**
   * Several providers may be enabled at once — the chat's model picker aggregates across
   * them. Disabling the one currently designated the default hands that role to another
   * enabled instance, so new chats and provider probes never point at a switched-off
   * provider. Distillation and reference sync resolve their own provider — see
   * DistillationSection.
   */
  function setEnabled(id: string, enabled: boolean): void {
    const next: Record<string, unknown> = { providerInstances: { [id]: { enabled } } }
    if (!enabled && a.activeInstanceId === id) {
      const fallback = Object.entries(a.providerInstances).find(
        ([otherId, i]) => otherId !== id && i.enabled
      )?.[0]
      if (fallback) next.activeInstanceId = fallback
    }
    patchAgent(next)
  }

  /** Designate the instance new chats and probes should use. Only ever called for an enabled,
   *  non-default instance, so the "the default is always runnable" invariant holds without
   *  a guard here — see canSetDefault at the call site. */
  function setDefault(id: string): void {
    patchAgent({ activeInstanceId: id })
  }

  function addInstance(driverKind: string): void {
    const id = nextInstanceId(a.providerInstances, driverKind)
    patchAgent({ providerInstances: { [id]: { driver: driverKind, enabled: true, config: {} } } })
    setExpandedId(id)
  }

  /**
   * Delete an instance outright — additive to disabling it. A provider added by mistake, or
   * one whose account is gone, should not have to live on as a permanent "Disabled" row.
   * `null` is the settings delete idiom (see deepMerge) and applies to a whole map entry.
   *
   * One atomic patch, so a partial application cannot leave a dangling reference. Of the keys
   * touched, only `distillProvider` is a correctness fix: `defaultInstanceId()` and the
   * modelPreferences lookup both tolerate a dangling id at read time, but
   * `resolveDistillProvider()` hard-fails on one instead of falling back to auto-resolve.
   *
   * The distillation warning is keyed to the EXPLICIT setting, not `resolveDistillProvider()`'s
   * result, so the dialog promises exactly what the patch delivers. With `distillProvider`
   * unset, distillation already auto-resolves and there is no setting to clear.
   */
  function removeInstance(id: string, label: string): void {
    const isDistill = a.distillProvider?.instanceId === id
    void confirm({
      title: `Remove ${label}?`,
      message: isDistill ? `${REMOVE_MESSAGE} ${DISTILL_NOTE}` : REMOVE_MESSAGE,
      confirmLabel: 'Remove',
      danger: true
    }).then((ok) => {
      if (!ok) return
      if (expandedId === id) setExpandedId(null)
      const next: Record<string, unknown> = {
        providerInstances: { [id]: null },
        // Emitted unconditionally rather than probed for: deleting an absent key is a no-op,
        // and this stops a stale hidden/favourite list resurfacing when the same generated id
        // (`<driverKind>-<n>`, with n reused after a deletion) is handed to a future instance.
        modelPreferences: { [id]: null }
      }
      if (isDistill) next.distillProvider = null
      if (a.activeInstanceId === id) {
        const others = Object.entries(a.providerInstances).filter(([otherId]) => otherId !== id)
        const fallback = (others.find(([, i]) => i.enabled) ?? others[0])?.[0]
        if (fallback) next.activeInstanceId = fallback
      }
      patchAgent(next)
    })
  }

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      setStatuses(await window.argus.providers.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  // The tag must name the instance that is ACTUALLY serving as default. When the stored id
  // points at a disabled or unknown instance, defaultInstanceId() falls back to the first
  // enabled one at read time — and that fallback is what new chats and probes really use.
  const effectiveDefaultId = defaultInstanceId(payload.settings)

  const entries = Object.entries(a.providerInstances)
  // Deleting the last instance would persist an empty map: providerInstances only receives its
  // seed when the key is ABSENT, so `{}` is a durable zero-provider state, not a healed one.
  const canRemove = entries.length > 1
  return (
    <>
      <SettingsSection
        title="Providers"
        action={
          <span className="flex items-center gap-2">
            <LastChecked statuses={statuses} />
            <IconBtn
              aria-label="Refresh provider status"
              title="Refresh provider status"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw
                size={13}
                strokeWidth={1.5}
                className={refreshing ? 'animate-spin' : undefined}
              />
            </IconBtn>
            <AddProviderMenu providerInstances={a.providerInstances} onAdd={addInstance} />
          </span>
        }
      >
        {entries.map(([id, instance]) => {
          const d = getDriver(instance.driver)
          const label = instance.displayName?.trim() || d?.shortLabel || d?.label || instance.driver
          if (!d) {
            return (
              <div key={id} className="px-4 py-3">
                <Chip tone="danger">unavailable driver: {instance.driver}</Chip>
              </div>
            )
          }
          return (
            <ProviderRow
              key={id}
              instanceId={id}
              driverKind={d.kind}
              label={label}
              status={statuses.find((s) => s.instanceId === id) ?? null}
              enabled={instance.enabled}
              expanded={expandedId === id}
              isDefault={id === effectiveDefaultId}
              canSetDefault={instance.enabled && id !== effectiveDefaultId}
              onToggleEnabled={(v) => setEnabled(id, v)}
              onToggleExpanded={() => setExpandedId(expandedId === id ? null : id)}
              onSetDefault={() => setDefault(id)}
            >
              <SettingRow
                label="Display name"
                isDefault={!instance.displayName}
                onReset={() => patchInstance(id, { displayName: null })}
              >
                <DraftInput
                  aria-label={`Display name · ${id}`}
                  className={`${FIELD} w-56`}
                  value={instance.displayName ?? ''}
                  onCommit={(v) => patchInstance(id, { displayName: v || null })}
                />
              </SettingRow>
              <AnnotatedForm
                annotations={d.formAnnotations}
                value={(instance.config ?? {}) as Record<string, unknown>}
                onChange={(k, v) => patchInstance(id, { config: { [k]: v } })}
              />
              <ProviderModels settings={payload.settings} instanceId={id} />
              <SettingRow
                label="Remove provider"
                description={canRemove ? REMOVE_MESSAGE : LAST_PROVIDER_NOTE}
              >
                <Btn
                  variant="danger"
                  disabled={!canRemove}
                  aria-label={`Remove ${label}`}
                  onClick={() => removeInstance(id, label)}
                >
                  Remove
                </Btn>
              </SettingRow>
            </ProviderRow>
          )
        })}
      </SettingsSection>

      <DistillationSection payload={payload} />

      <SettingsSection title="Session defaults">
        <SettingRow
          label="Persona append"
          description="Appended to the Argus persona for new sessions"
          isDefault={a.personaAppend === ''}
          onReset={() => patchAgent({ personaAppend: null })}
        >
          <DraftTextarea
            aria-label="Persona append"
            className="w-72 rounded-r2 border border-hair bg-overlay p-2 font-mono text-xs text-ink placeholder:text-mute focus:border-hair2 focus:outline-none"
            value={a.personaAppend}
            onCommit={(v) => patchAgent({ personaAppend: v || null })}
          />
        </SettingRow>
        <SettingRow
          label="Default permission mode"
          isDefault={a.defaultPermissionMode === 'default'}
          onReset={() => patchAgent({ defaultPermissionMode: null })}
        >
          <SelectField
            aria-label="Default permission mode"
            value={PERMISSION_MODE_LABELS[a.defaultPermissionMode]}
            options={PERMISSION_MODES.map((m) => PERMISSION_MODE_LABELS[m])}
            onChange={(label) => patchAgent({ defaultPermissionMode: MODE_BY_LABEL[label] })}
          />
        </SettingRow>
        <SettingRow
          label="Max concurrent sessions"
          description="Least-recently-used idle session is reaped at the cap"
          isDefault={a.maxSessions === 3}
          onReset={() => patchAgent({ maxSessions: null })}
        >
          <input
            type="number"
            min={1}
            max={16}
            aria-label="Max concurrent sessions"
            className={`${FIELD} w-20`}
            value={a.maxSessions}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 1 && n <= 16) patchAgent({ maxSessions: n })
            }}
          />
        </SettingRow>
        <SettingRow
          label="Probe timeout (ms)"
          isDefault={a.probeTimeoutMs === 10000}
          onReset={() => patchAgent({ probeTimeoutMs: null })}
        >
          <input
            type="number"
            min={1000}
            max={120000}
            step={500}
            aria-label="Probe timeout (ms)"
            className={`${FIELD} w-24`}
            value={a.probeTimeoutMs}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 1000 && n <= 120000) patchAgent({ probeTimeoutMs: n })
            }}
          />
        </SettingRow>
      </SettingsSection>
    </>
  )
}
