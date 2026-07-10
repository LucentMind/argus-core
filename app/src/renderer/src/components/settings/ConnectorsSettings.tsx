import { useState } from 'react'
import {
  CONNECTOR_FORMS,
  ROVO_FORM_EXTRAS,
  ROVO_PRESET,
  RESERVED_INSTANCE_IDS,
  collectSecretRefs,
  type ConnectorInstance,
  type ConnectorRuntimeState,
  type HttpConnectorConfig,
  type OAuthStatus
} from '../../../../shared/connectors'
import { connectorsStore, useConnectorsPayload } from '../../lib/connectorsStore'
import { AnnotatedForm } from './AnnotatedForm'
import { SettingsSection, SettingRow, Switch, DraftInput, FIELD } from './settingsLayout'
import { Btn, Card, Chip } from '../ui'

function statusChip(
  inst: ConnectorInstance,
  rt: ConnectorRuntimeState | undefined
): React.JSX.Element {
  if (!inst.enabled) return <Chip tone="neutral">disabled</Chip>
  switch (rt?.state) {
    case 'connected':
      return <Chip tone="review">connected</Chip>
    case 'error':
      return <Chip tone="danger">error</Chip>
    case 'needs-auth':
      return <Chip tone="danger">needs auth</Chip>
    default:
      return <Chip tone="neutral">never connected</Chip>
  }
}

function toolSummary(inst: ConnectorInstance): string | null {
  const tools = inst.lastDiscovered?.tools
  if (!tools?.length) return null
  const n = (r: string): number => tools.filter((t) => t.risk === r).length
  return `${tools.length} tools · ${n('low')} low · ${n('medium')} medium · ${n('high')} high`
}

const RISK_TONE = { low: 'review', medium: 'neutral', high: 'danger' } as const

/** Adapt raw config to AnnotatedForm scalars (args ↔ space-joined, env/headers ↔ JSON text). */
function formValue(kind: string, cfg: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'stdio')
    return {
      ...cfg,
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : '',
      env: cfg.env && Object.keys(cfg.env).length ? JSON.stringify(cfg.env) : ''
    }
  if (kind === 'http')
    return {
      ...cfg,
      headers:
        cfg.headers && Object.keys(cfg.headers as object).length ? JSON.stringify(cfg.headers) : ''
    }
  return cfg
}

function commitField(id: string, kind: string, key: string, v: unknown | null): void {
  let out: unknown = v
  if (kind === 'stdio' && key === 'args')
    out = v == null ? null : String(v).split(/\s+/).filter(Boolean)
  if ((kind === 'stdio' && key === 'env') || (kind === 'http' && key === 'headers')) {
    if (v == null) out = null
    else {
      try {
        out = JSON.parse(String(v))
      } catch {
        return // invalid JSON: keep the draft, commit nothing
      }
    }
  }
  void connectorsStore.patch({ [id]: { config: { [key]: out } } })
}

function commitSecret(id: string, key: string, plaintext: string | null): void {
  const name = `connector/${id}/${key}`
  if (plaintext == null) {
    void window.argus.secrets.delete(name)
    void connectorsStore.patch({ [id]: { config: { [key]: null } } })
    return
  }
  void window.argus.secrets
    .set(name, plaintext)
    .then(() => connectorsStore.patch({ [id]: { config: { [key]: { $secret: name } } } }))
    .catch((err: Error) => window.alert(`secret not saved: ${err.message}`))
}

function ConnectorCard({
  id,
  inst,
  rt,
  oauthStatus,
  secretsAvailable,
  editing,
  onToggleEdit
}: {
  id: string
  inst: ConnectorInstance
  rt: ConnectorRuntimeState | undefined
  oauthStatus: OAuthStatus | undefined
  secretsAvailable: boolean
  editing: boolean
  onToggleEdit: () => void
}): React.JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const supported = Boolean(CONNECTOR_FORMS[inst.kind])
  const cfg = (inst.config ?? {}) as Record<string, unknown>
  const isOauth = inst.kind === 'http' && (cfg as Partial<HttpConnectorConfig>).oauth === true
  const summary = toolSummary(inst)
  const secretGap = !secretsAvailable && collectSecretRefs(inst.config).length > 0
  const annotations = {
    ...(CONNECTOR_FORMS[inst.kind] ?? {}),
    ...(inst.preset === 'rovo' ? ROVO_FORM_EXTRAS : {})
  }

  function test(): void {
    setTesting(true)
    void window.argus.connectors.test(id).finally(() => setTesting(false))
  }

  function remove(): void {
    if (window.confirm(`Remove connector "${inst.displayName ?? id}"?`)) {
      void connectorsStore.patch({ [id]: null })
    }
  }

  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 p-3">
        <span className="font-medium text-ink">{inst.displayName ?? id}</span>
        {supported ? (
          <Chip tone="neutral">{inst.kind}</Chip>
        ) : (
          <Chip tone="danger">unsupported kind: {inst.kind}</Chip>
        )}
        {statusChip(inst, rt)}
        {rt?.state === 'error' && <span className="text-xs text-dim">{rt.reason}</span>}
        {isOauth &&
          (oauthStatus === 'authorized' ? (
            <>
              <Chip tone="review">authorized</Chip>
              <Btn variant="ghost" onClick={() => void window.argus.connectors.oauth(id)}>
                Re-authorize
              </Btn>
            </>
          ) : (
            <Btn variant="primary" onClick={() => void window.argus.connectors.oauth(id)}>
              {oauthStatus === 'error' ? 'Re-authorize' : 'Authorize…'}
            </Btn>
          ))}
        {secretGap && <Chip tone="danger">secret store unavailable</Chip>}
        <div className="ml-auto flex items-center gap-2">
          <Switch
            // renders off for an unsupported kind even if enabled:true is persisted
            checked={inst.enabled && supported}
            onChange={(v) => {
              // spec §2.6: an unsupported kind can be disabled but never enabled
              if (supported || v === false) void connectorsStore.patch({ [id]: { enabled: v } })
            }}
            aria-label={`enabled · ${id}`}
          />
          <Btn variant="outline" onClick={test} disabled={testing || !supported}>
            {testing ? 'Testing…' : 'Test connection'}
          </Btn>
          <Btn variant="ghost" onClick={onToggleEdit} aria-label={`edit · ${id}`}>
            Edit
          </Btn>
          <Btn variant="danger" onClick={remove} aria-label={`remove · ${id}`}>
            Remove
          </Btn>
        </div>
      </div>
      {summary && (
        <button
          className="px-3 pb-2 text-left text-xs text-dim"
          onClick={() => setToolsOpen((o) => !o)}
          aria-label={`tools · ${id}`}
        >
          {summary} <span aria-hidden="true">{toolsOpen ? '▾' : '▸'}</span>
        </button>
      )}
      {toolsOpen && inst.lastDiscovered && (
        <ul className="border-t border-hair px-3 py-2">
          {inst.lastDiscovered.tools.map((t) => (
            <li key={t.name} className="flex items-center gap-2 py-0.5">
              <span className="font-mono text-xs">{t.name}</span>
              <Chip tone={RISK_TONE[t.risk]}>{t.risk}</Chip>
              {t.description && <span className="truncate text-xs text-dim">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {editing && supported && (
        <div className="border-t border-hair p-3">
          <SettingRow label="Display name" isDefault={!inst.displayName}>
            <DraftInput
              value={inst.displayName ?? ''}
              onCommit={(v) => void connectorsStore.patch({ [id]: { displayName: v || null } })}
              aria-label={`display name · ${id}`}
              className={FIELD}
            />
          </SettingRow>
          <AnnotatedForm
            annotations={annotations}
            value={formValue(inst.kind, cfg)}
            onChange={(k, v) => commitField(id, inst.kind, k, v)}
            onSecret={(k, v) => commitSecret(id, k, v)}
          />
        </div>
      )}
    </Card>
  )
}

export function ConnectorsSettings(): React.JSX.Element {
  const payload = useConnectorsPayload()
  const [editing, setEditing] = useState<string | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  if (!payload) return <div className="text-dim">loading…</div>

  // The chooser stays open across selections (so several instances can be added
  // in one sitting) — it only closes via the explicit Cancel button.
  function addRovo(): void {
    if (!payload!.connectors[ROVO_PRESET.instanceId])
      void connectorsStore.patch({ [ROVO_PRESET.instanceId]: ROVO_PRESET.instance })
    setEditing(ROVO_PRESET.instanceId)
  }

  function addCustom(kind: 'http' | 'stdio'): void {
    let n = 1
    while (
      payload!.connectors[`${kind}-${n}`] ||
      (RESERVED_INSTANCE_IDS as readonly string[]).includes(`${kind}-${n}`)
    )
      n++
    const id = `${kind}-${n}`
    void connectorsStore.patch({ [id]: { kind, enabled: true, config: {} } })
    setEditing(id)
  }

  return (
    <div className="flex flex-col gap-4">
      {payload.loadError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <span className="flex-1">{payload.loadError}</span>
        </div>
      )}
      {payload.secretsLoadError && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          secrets.json could not be parsed — secrets unavailable until re-saved. (
          {payload.secretsLoadError})
        </div>
      )}
      <SettingsSection title="Connectors">
        {Object.entries(payload.connectors).map(([id, inst]) => (
          <ConnectorCard
            key={id}
            id={id}
            inst={inst}
            rt={payload.runtime[id]}
            oauthStatus={payload.oauth[id]}
            secretsAvailable={payload.secretsAvailable}
            editing={editing === id}
            onToggleEdit={() => setEditing((e) => (e === id ? null : id))}
          />
        ))}
        {Object.keys(payload.connectors).length === 0 && (
          <div className="p-3 text-sm text-dim">No connectors yet.</div>
        )}
      </SettingsSection>
      {chooserOpen ? (
        <div className="flex items-center gap-2">
          <Btn variant="primary" onClick={addRovo}>
            Atlassian Rovo
          </Btn>
          <Btn variant="outline" onClick={() => addCustom('http')}>
            Custom remote (HTTP)
          </Btn>
          <Btn variant="outline" onClick={() => addCustom('stdio')}>
            Custom local (stdio)
          </Btn>
          <Btn variant="ghost" onClick={() => setChooserOpen(false)}>
            Cancel
          </Btn>
        </div>
      ) : (
        <div>
          <Btn variant="primary" onClick={() => setChooserOpen(true)}>
            Add connector
          </Btn>
        </div>
      )}
    </div>
  )
}
