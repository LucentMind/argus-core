import { useState } from 'react'
import { Globe, GlobeOff, X } from 'lucide-react'
import {
  CONNECTOR_FORMS,
  ROVO_FORM_EXTRAS,
  RESERVED_INSTANCE_IDS,
  collectSecretRefs,
  type ConnectorInstance,
  type ConnectorRuntimeState,
  type HttpConnectorConfig,
  type OAuthStatus
} from '../../../../shared/connectors'
import { connectorsStore, useConnectorsPayload } from '../../lib/connectorsStore'
import { settingsStore, useSettingsPayload } from '../../lib/settingsStore'
import { formValue, commitField, commitSecret } from '../../lib/connectorForm'
import { confirm } from '../../lib/confirmStore'
import { AnnotatedForm } from './AnnotatedForm'
import {
  SettingsSection,
  SettingRow,
  Switch,
  DraftInput,
  SelectField,
  SettingsSkeleton,
  FIELD
} from './settingsLayout'
import { SourceControl } from './SourceControl'
import { RcaTemplateSettings } from './RcaTemplateSettings'
import { Btn, Card, Chip, IconBtn, MenuButton } from '../ui'
import { DEFAULT_CLONE_LINK_TYPES, DEFAULT_WATERMARK_TEXT } from '../../../../shared/settings'

const WATERMARK_TARGETS = [
  { key: 'jira', label: 'Jira comments', hint: 'The RCA exec summary posted to the linked issue.' },
  { key: 'github', label: 'GitHub PR comments', hint: 'Findings posted to a bound pull request.' }
] as const

/** Labels for `settings.rca.techDestination` — kept here rather than in shared/settings.ts
 *  since they're display strings for exactly this one SelectField, and `SelectField`'s
 *  contract is label-in/label-out (see settingsLayout.tsx). */
const TECH_DESTINATION_LABELS = {
  attachment: 'Attach markdown to the Jira issue',
  'confluence-page': 'Publish a Confluence page'
} as const
const TECH_DESTINATION_BY_LABEL: Record<string, keyof typeof TECH_DESTINATION_LABELS> =
  Object.fromEntries(Object.entries(TECH_DESTINATION_LABELS).map(([k, v]) => [v, k])) as Record<
    string,
    keyof typeof TECH_DESTINATION_LABELS
  >

function statusChip(
  inst: ConnectorInstance,
  rt: ConnectorRuntimeState | undefined
): React.JSX.Element {
  if (!inst.enabled) return <Chip tone="neutral">disabled</Chip>
  switch (rt?.state) {
    case 'connected':
      return (
        <span title="connected" className="flex shrink-0 items-center">
          <Globe size={15} role="img" aria-label="connected" className="text-signal" />
        </span>
      )
    case 'error':
      return <Chip tone="danger">error</Chip>
    case 'needs-auth':
      return (
        <span title="needs auth" className="flex shrink-0 items-center">
          <GlobeOff size={15} role="img" aria-label="needs auth" className="text-danger" />
        </span>
      )
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

function ConnectorCard({
  id,
  inst,
  rt,
  oauthStatus,
  restError,
  secretsAvailable,
  editing,
  onToggleEdit
}: {
  id: string
  inst: ConnectorInstance
  rt: ConnectorRuntimeState | undefined
  oauthStatus: OAuthStatus | undefined
  restError: string | undefined
  secretsAvailable: boolean
  editing: boolean
  onToggleEdit: () => void
}): React.JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
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
    void confirm({
      title: `Remove connector "${inst.displayName ?? id}"?`,
      confirmLabel: 'Remove',
      danger: true
    }).then((ok) => {
      if (ok) void connectorsStore.patch({ [id]: null })
    })
  }

  function authorize(): void {
    setAuthError(null)
    void window.argus.connectors.oauth(id).then((r: { ok: boolean; error?: string }) => {
      if (!r.ok) setAuthError(r.error ?? 'authorization failed')
    })
  }

  return (
    <Card className="flex flex-col">
      {/* controls column sits beside BOTH text lines so Edit + toggle center vertically on the card */}
      <div className="flex items-center gap-2 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{inst.displayName ?? id}</span>
            {supported ? (
              <Chip tone="neutral">{inst.kind}</Chip>
            ) : (
              <Chip tone="danger">unsupported kind: {inst.kind}</Chip>
            )}
            {statusChip(inst, rt)}
            {restError && (
              <Chip tone="danger" title={restError}>
                REST auth
              </Chip>
            )}
            {rt?.state === 'error' && <span className="text-xs text-dim">{rt.reason}</span>}
            {isOauth && oauthStatus === 'authorized' && <Chip tone="review">authorized</Chip>}
            {isOauth && oauthStatus !== 'authorized' && (
              <Btn
                variant="primary"
                disabled={!String((cfg as Partial<HttpConnectorConfig>).url ?? '')}
                aria-label={`authorize · ${id}`}
                onClick={authorize}
              >
                Authorize…
              </Btn>
            )}
            {isOauth && authError && <span className="text-xs text-danger">{authError}</span>}
            {secretGap && <Chip tone="danger">secret store unavailable</Chip>}
          </div>
          {summary && (
            <button
              className="text-left text-xs text-dim"
              onClick={() => setToolsOpen((o) => !o)}
              aria-label={`tools · ${id}`}
            >
              {summary} <span aria-hidden="true">{toolsOpen ? '▾' : '▸'}</span>
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MenuButton
            label="Edit"
            aria-label={`actions · ${id}`}
            items={[
              { label: 'Edit details', onSelect: onToggleEdit },
              {
                label: testing ? 'Testing…' : 'Test connection',
                onSelect: test,
                disabled: testing || !supported
              },
              ...(isOauth && oauthStatus === 'authorized'
                ? [{ label: 'Re-authorize', onSelect: authorize }]
                : []),
              { label: 'Remove', onSelect: remove, tone: 'danger' as const }
            ]}
          />
          <Switch
            // renders off for an unsupported kind even if enabled:true is persisted
            checked={inst.enabled && supported}
            onChange={(v) => {
              // spec §2.6: an unsupported kind can be disabled but never enabled
              if (supported || v === false) void connectorsStore.patch({ [id]: { enabled: v } })
            }}
            aria-label={`enabled · ${id}`}
          />
        </div>
      </div>
      {toolsOpen && inst.lastDiscovered && (
        <ul className="border-t border-hair px-3 py-2">
          {inst.lastDiscovered.tools.map((t) => (
            <li key={t.name} className="flex items-center gap-2 py-0.5">
              <span className="font-mono text-xs">{t.name}</span>
              <Chip tone={RISK_TONE[t.risk]}>{t.risk}</Chip>
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
  const settingsPayload = useSettingsPayload()
  const [editing, setEditing] = useState<string | null>(null)
  const [newLinkType, setNewLinkType] = useState('')
  if (!payload) return <SettingsSkeleton />
  const rca = settingsPayload?.settings.rca
  const watermark = settingsPayload?.settings.watermark
  const jira = settingsPayload?.settings.jira

  /** Patch `null`, not `[]`, once the last entry is gone: an empty ARRAY does not equal the
   *  non-empty default, so `stripDefaults` would keep it on disk and clone discovery would
   *  silently match nothing forever. `null` is the repo's reset idiom — deepMerge deletes the
   *  key and the next parse re-seeds ["Cloners"], which is what the row's copy promises. */
  function setCloneLinkTypes(next: string[]): void {
    const clean = next.map((t) => t.trim()).filter(Boolean)
    void settingsStore.patch({ jira: { cloneLinkTypes: clean.length ? clean : null } })
  }

  function addPreset(pid: string): void {
    if (!payload!.connectors[pid]) {
      const p = payload!.presets[pid]
      void connectorsStore.patch({
        [pid]: {
          kind: p.kind,
          displayName: p.displayName,
          preset: pid,
          enabled: true,
          config: p.config
        }
      })
    }
    setEditing(pid)
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
      {/* GitHub first (user-directed, 2026-08-08). It is the one connection every case depends on
          — PR lookup, pushes, HiveMind — and it was buried under the MCP list, the Add-connector
          button and the RCA section, three scrolls down. */}
      <SourceControl />
      {/* Untitled — same reason as GeneralSettings: the header masthead already names the page. */}
      <SettingsSection>
        {Object.entries(payload.connectors).map(([id, inst]) => (
          <ConnectorCard
            key={id}
            id={id}
            inst={inst}
            rt={payload.runtime[id]}
            oauthStatus={payload.oauth[id]}
            restError={payload.rest[id]}
            secretsAvailable={payload.secretsAvailable}
            editing={editing === id}
            onToggleEdit={() => setEditing((e) => (e === id ? null : id))}
          />
        ))}
        {Object.keys(payload.connectors).length === 0 && (
          <div className="p-3 text-sm text-dim">No connectors yet.</div>
        )}
      </SettingsSection>
      <div>
        <MenuButton
          label="Add connector"
          variant="primary"
          align="left"
          aria-label="add connector"
          items={[
            ...Object.entries(payload.presets)
              .filter(([pid]) => !(RESERVED_INSTANCE_IDS as readonly string[]).includes(pid))
              .map(([pid, p]) => ({
                label: p.displayName,
                onSelect: () => addPreset(pid)
              })),
            { label: 'Custom remote (HTTP)', onSelect: () => addCustom('http') },
            { label: 'Custom local (stdio)', onSelect: () => addCustom('stdio') }
          ]}
        />
      </div>
      {rca && (
        <SettingsSection title="RCA report">
          <SettingRow
            label="Technical report destination"
            description="Where a confirmed RCA's technical drill-down is posted — the exec summary always goes as a Jira comment."
            isDefault={rca.techDestination === 'attachment'}
            onReset={() => void settingsStore.patch({ rca: { techDestination: null } })}
          >
            <SelectField
              aria-label="Technical report destination"
              value={TECH_DESTINATION_LABELS[rca.techDestination]}
              options={Object.values(TECH_DESTINATION_LABELS)}
              onChange={(v) =>
                void settingsStore.patch({ rca: { techDestination: TECH_DESTINATION_BY_LABEL[v] } })
              }
            />
          </SettingRow>
          {rca.techDestination === 'confluence-page' && (
            <SettingRow
              label="Confluence space key"
              description='The space the technical report is published into, e.g. "ENG".'
              isDefault={!rca.confluenceSpaceKey}
              onReset={() => void settingsStore.patch({ rca: { confluenceSpaceKey: null } })}
            >
              <DraftInput
                value={rca.confluenceSpaceKey}
                onCommit={(v) =>
                  void settingsStore.patch({ rca: { confluenceSpaceKey: v.trim() } })
                }
                aria-label="Confluence space key"
                className={FIELD}
                placeholder="ENG"
              />
            </SettingRow>
          )}
          {/* Outside the confluence-page branch above: the template drives BOTH reports and
              must stay reachable whatever the tech destination is. */}
          <RcaTemplateSettings template={rca.template} />
        </SettingsSection>
      )}
      {jira && (
        <SettingsSection title="Jira">
          <SettingRow
            label="Clone link types"
            description={`Jira link-type names that mean "this ticket is a clone of that one" — what source-ticket discovery looks for on an issue. Compared case-insensitively. Remove every entry to go back to Jira's default ("${DEFAULT_CLONE_LINK_TYPES.join('", "')}").`}
            isDefault={
              jira.cloneLinkTypes.length === DEFAULT_CLONE_LINK_TYPES.length &&
              jira.cloneLinkTypes.every((t, i) => t === DEFAULT_CLONE_LINK_TYPES[i])
            }
            onReset={() => void settingsStore.patch({ jira: { cloneLinkTypes: null } })}
            stacked
          >
            <div className="flex flex-col gap-1">
              {jira.cloneLinkTypes.map((t, i) => (
                <div key={`${i}:${t}`} className="flex items-center gap-1">
                  <DraftInput
                    value={t}
                    onCommit={(v) =>
                      setCloneLinkTypes(jira.cloneLinkTypes.map((old, j) => (j === i ? v : old)))
                    }
                    aria-label={`Clone link type ${t}`}
                    className={FIELD}
                  />
                  <IconBtn
                    aria-label={`Remove ${t}`}
                    title={`Remove ${t}`}
                    size="sm"
                    onClick={() => setCloneLinkTypes(jira.cloneLinkTypes.filter((_, j) => j !== i))}
                  >
                    <X size={12} />
                  </IconBtn>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <input
                  className={FIELD}
                  aria-label="New clone link type"
                  placeholder="Cloners"
                  value={newLinkType}
                  onChange={(e) => setNewLinkType(e.target.value)}
                />
                <Btn
                  variant="outline"
                  disabled={!newLinkType.trim()}
                  onClick={() => {
                    setCloneLinkTypes([...jira.cloneLinkTypes, newLinkType])
                    setNewLinkType('')
                  }}
                >
                  Add
                </Btn>
              </div>
            </div>
          </SettingRow>
        </SettingsSection>
      )}
      {watermark && (
        <SettingsSection title="Comment watermark">
          {WATERMARK_TARGETS.map(({ key, label, hint }) => (
            <div key={key}>
              <SettingRow label={label} description={hint}>
                <Switch
                  checked={watermark[key].enabled}
                  onChange={(v) =>
                    void settingsStore.patch({ watermark: { [key]: { enabled: v } } })
                  }
                  aria-label={`Watermark ${label}`}
                />
              </SettingRow>
              <SettingRow
                label="Footer text"
                description="Markdown, including links like [Argus](https://…). The default assumes a human approves the post — soften it if this workspace posts unattended."
                isDefault={watermark[key].text === DEFAULT_WATERMARK_TEXT}
                onReset={() => void settingsStore.patch({ watermark: { [key]: { text: null } } })}
              >
                <DraftInput
                  value={watermark[key].text}
                  onCommit={(v) =>
                    void settingsStore.patch({ watermark: { [key]: { text: v.trim() } } })
                  }
                  aria-label={`${key === 'jira' ? 'Jira' : 'GitHub'} watermark text`}
                  className={`${FIELD} w-96`}
                  disabled={!watermark[key].enabled}
                  placeholder="No footer"
                />
              </SettingRow>
            </div>
          ))}
        </SettingsSection>
      )}
    </div>
  )
}
