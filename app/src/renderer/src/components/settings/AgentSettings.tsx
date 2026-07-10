import { useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, Chip } from '../ui'
import {
  SettingsSection,
  SettingRow,
  SelectField,
  FIELD,
  DraftInput,
  DraftTextarea
} from './settingsLayout'
import { AnnotatedForm } from './AnnotatedForm'
import { getDriver } from '../../../../shared/drivers'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type PermissionMode,
  type SettingsPayload
} from '../../../../shared/settings'
import type { AuthStatus } from '../../../../shared/types'

const MODE_BY_LABEL = Object.fromEntries(
  PERMISSION_MODES.map((m) => [PERMISSION_MODE_LABELS[m], m])
) as Record<string, PermissionMode>

export function AgentSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const a = payload.settings.agent
  const instId = a.activeInstanceId
  const inst = a.providerInstances[instId]
  const driver = inst ? getDriver(inst.driver) : null
  const cfg = (inst?.config ?? {}) as Record<string, unknown>
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [probing, setProbing] = useState(false)

  function patchAgent(p: Record<string, unknown>): void {
    void settingsStore.patch({ agent: p })
  }
  function patchInstance(p: Record<string, unknown>): void {
    patchAgent({ providerInstances: { [instId]: p } })
  }

  async function testConnection(): Promise<void> {
    setProbing(true)
    try {
      setAuth(await window.argus.agent.authStatus(true))
    } finally {
      setProbing(false)
    }
  }

  return (
    <>
      <SettingsSection title="Provider">
        <div className="flex items-center gap-2 px-4 py-3">
          {driver ? (
            <Chip tone="signal">{driver.label}</Chip>
          ) : (
            <Chip tone="danger">unavailable driver: {inst?.driver ?? 'none'}</Chip>
          )}
          <span className="font-mono text-xs text-mute">{instId}</span>
          <span className="ml-auto flex items-center gap-2">
            {auth && (
              <span title={auth.detail}>
                <Chip tone={auth.ok ? 'review' : 'danger'}>{auth.ok ? 'auth ✓' : 'auth ✗'}</Chip>
              </span>
            )}
            <Btn disabled={probing} onClick={() => void testConnection()}>
              {probing ? 'Testing…' : 'Test connection'}
            </Btn>
          </span>
        </div>
        <SettingRow
          label="Display name"
          isDefault={!inst?.displayName}
          onReset={() => patchInstance({ displayName: null })}
        >
          <DraftInput
            aria-label="Display name"
            className={`${FIELD} w-56`}
            value={inst?.displayName ?? ''}
            onCommit={(v) => patchInstance({ displayName: v || null })}
          />
        </SettingRow>
        {driver && (
          <AnnotatedForm
            annotations={driver.formAnnotations}
            value={cfg}
            onChange={(k, v) => patchInstance({ config: { [k]: v } })}
          />
        )}
      </SettingsSection>

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
