import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Sparkles, Lock, SquareTerminal, ArrowUp } from 'lucide-react'
import { uiStore } from '../lib/uiStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { AttachmentTray } from './AttachmentTray'
import type { Attachment } from '../lib/composerAttachments'
import {
  allVisibleModels,
  capabilitiesFor,
  defaultInstanceId,
  defaultModelRef,
  mergeCatalogModels,
  type AggregatedModel
} from '../../../shared/drivers'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type PermissionMode
} from '../../../shared/settings'
import {
  descriptorsFor,
  pruneSelections,
  type RunOptionDescriptor,
  type RunOptionSelection
} from '../../../shared/runOptions'
import type { SkillListItem } from '../../../shared/memoryIpc'
import type { SessionSummary } from '../../../shared/types'
import { useModelCatalog } from '../lib/catalogStore'
import { DescriptorChip } from './OptionsMenu'

/**
 * Session-option picker: model and permission mode. Reasoning and Context Window use the
 * descriptor-driven `DescriptorChip` in OptionsMenu.tsx instead — see the `descriptors` map
 * in the Composer body below.
 */
function OptionChip({
  icon,
  options,
  value,
  onChange,
  menuLabel
}: {
  icon: React.ReactNode
  options: string[]
  value: string
  onChange: (v: string) => void
  menuLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        title={menuLabel}
        className="flex items-center gap-1.5 rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span>{value}</span>
        <ChevronDown size={10} strokeWidth={1.5} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={menuLabel}
            className="absolute bottom-full left-0 z-20 mb-1 min-w-40 rounded-r2 border border-hair bg-overlay p-1 shadow-lg"
          >
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                role="menuitem"
                className={`block w-full whitespace-nowrap rounded-r1 px-2 py-1 text-left text-xs transition-colors hover:bg-hi ${
                  opt === value ? 'text-ink' : 'text-dim'
                }`}
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Menu key for a cross-provider model. Two enabled instances can expose the same slug, so
 *  the provider qualifies it — and the label doubles as what the user reads in the menu. */
function modelOptionLabel(m: AggregatedModel, showProvider: boolean): string {
  return showProvider ? `${m.name} · ${m.providerLabel}` : m.name
}

function Divider(): React.JSX.Element {
  return <span className="h-4 w-px shrink-0 bg-hair2" />
}

export function Composer({
  disabled,
  onSend,
  prefill,
  citations = [],
  onRemoveCitation,
  onCitationsConsumed,
  attachments = [],
  onRemoveAttachment,
  onAttachFiles,
  session,
  onModelChange,
  onRunOptionsChange,
  onPermissionModeChange
}: {
  disabled: boolean
  onSend: (text: string) => void
  prefill?: string
  citations?: { relPath: string; line: number }[]
  onRemoveCitation?: (index: number) => void
  onCitationsConsumed?: () => void
  /** Evidence staged by paste or drop, appended to the body on send. */
  attachments?: Attachment[]
  /** Detach from the message — does NOT delete the evidence. */
  onRemoveAttachment?: (id: string) => void
  /** Hand pasted/dropped files to the owner, which ingests them. `fromClipboard` marks
   *  paste — the owner needs it because Chromium synthesises a filename (e.g. `image.png`)
   *  for clipboard images, so `file.name` alone can't distinguish a screenshot from a
   *  real file. */
  onAttachFiles?: (files: File[], opts?: { fromClipboard?: boolean }) => void
  /** The chat this composer belongs to — supplies the pinned model and the provider whose
   *  capabilities gate the permission picker. Absent while the session list is loading. */
  session?: SessionSummary | null
  /** Re-pin the session to another provider instance + model. */
  onModelChange?: (instanceId: string, slug: string) => void
  /** Replace this chat's option selections. */
  onRunOptionsChange?: (sel: RunOptionSelection[]) => void
  /** Pin this chat's permission mode. */
  onPermissionModeChange?: (mode: PermissionMode) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [skills, setSkills] = useState<SkillListItem[]>([])
  const showToolCalls = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get().showToolCalls
  )
  const dynamic = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get().dynamicTheme
  )

  useEffect(() => {
    void window.argus.skills.list().then((p) => setSkills(p.skills))
  }, [])

  const settingsPayload = useSettingsPayload()

  // The catalog describes ONE instance's CLI — the session's. It substitutes that single
  // instance's rows (see allVisibleModels' rowOverrides); every OTHER enabled instance keeps
  // its normal visibility/ordering-preference rows untouched. This is the fix for the
  // regression where a loaded catalog used to replace the ENTIRE picker, silently removing
  // Claude ↔ Codex ↔ Copilot ↔ Cursor switching from the composer chip.
  const catalogInstanceId = session?.instanceId ?? null
  const catalog = useModelCatalog(catalogInstanceId)
  const catalogRows = mergeCatalogModels([], catalog)
  const rowOverrides =
    catalogInstanceId && catalogRows.length > 0 ? { [catalogInstanceId]: catalogRows } : undefined
  // Every enabled provider's models in one list. Provider names are appended only when more
  // than one is enabled, so the single-provider case stays uncluttered.
  const models: AggregatedModel[] = settingsPayload
    ? allVisibleModels(settingsPayload.settings, rowOverrides)
    : []
  const showProvider = new Set(models.map((m) => m.instanceId)).size > 1
  const modelOptions = models.length
    ? models.map((m) => modelOptionLabel(m, showProvider))
    : // static fallback until the settings payload first arrives
      ['Claude Fable 5', 'Claude Opus 4.8', 'Claude Sonnet 5', 'Claude Haiku 4.5']

  // What this chat is pinned to. A session created before multi-provider has a null model,
  // so fall back to the settings default (which still honours a hand-set config.model) —
  // the chip is never blank, and it shows what a send would actually use.
  const fallback = settingsPayload ? defaultModelRef(settingsPayload.settings) : undefined
  const current =
    models.find((m) => m.instanceId === session?.instanceId && m.slug === session?.model) ??
    models.find((m) => m.slug === session?.model) ??
    models.find((m) => m.instanceId === fallback?.instanceId && m.slug === fallback?.slug) ??
    models[0]
  const model = current ? modelOptionLabel(current, showProvider) : modelOptions[0]

  // Run-option descriptors come from what the CLI reports about the PINNED model, not the
  // static AggregatedModel row — `current.slug` looks the catalog row up directly, falling
  // back to a `[1m]`-stripped match so a session pinned at the 1M suffix still finds its
  // base row's capabilities.
  const info = current
    ? (catalog.find((m) => m.value === current.slug) ??
      catalog.find((m) => m.resolvedModel?.replace(/\[1m\]$/, '') === current.slug) ??
      null)
    : null
  const descriptors: RunOptionDescriptor[] = info ? descriptorsFor(info) : []
  const selections = session?.runOptions ?? []

  function changeOption(d: RunOptionDescriptor, value: string | boolean): void {
    const next = pruneSelections(descriptors, [
      ...selections.filter((s) => s.id !== d.id),
      { id: d.id, value }
    ])
    onRunOptionsChange?.(next)
  }

  // Permission modes come from THIS session's provider, not the global default — with two
  // providers enabled they can differ, and offering a mode the running driver drops would
  // be a false signal.
  const permissionOptions = capabilitiesFor(
    settingsPayload?.settings,
    session?.instanceId ?? (settingsPayload ? defaultInstanceId(settingsPayload.settings) : null)
  ).permissionModes.map((m) => PERMISSION_MODE_LABELS[m])

  // The session's own mode wins (it is what a send actually uses); the settings default is
  // only a fallback for a chat that has never had its permission mode set.
  const permission = session?.permissionMode
    ? PERMISSION_MODE_LABELS[session.permissionMode]
    : settingsPayload
      ? PERMISSION_MODE_LABELS[settingsPayload.settings.agent.defaultPermissionMode]
      : 'Ask approvals'

  // suggestion buttons (e.g. Analyze in the evidence library) overwrite the
  // draft — adjust-state-during-render pattern instead of a setState effect
  const [lastPrefill, setLastPrefill] = useState(prefill)
  if (prefill !== lastPrefill) {
    setLastPrefill(prefill)
    if (prefill) setText(prefill)
  }

  const showSkills = text.startsWith('/') && !text.includes(' ')
  const matches = skills.filter((s) => s.name.startsWith(text.slice(1)) && s.enabled)

  // keyboard state for the skills popup: highlight follows Arrow keys, Tab
  // completes, Escape hides the popup until the text next changes
  const [highlight, setHighlight] = useState(0)
  const [skillsDismissed, setSkillsDismissed] = useState(false)
  const popupOpen = showSkills && !skillsDismissed && matches.length > 0
  const highlighted = Math.min(highlight, matches.length - 1)

  function updateText(v: string): void {
    setText(v)
    setHighlight(0)
    setSkillsDismissed(false)
  }

  function completeSkill(name: string): void {
    setText(`/${name} `)
  }

  // pending and errored attachments have no relPath yet — only what landed is sendable.
  // Hoisted so `send()` and the send button's `disabled` check share one predicate and
  // can't drift apart.
  const sendableAttachments = attachments.filter((a) => a.status === 'ready' && a.relPath)

  function send(): void {
    const t = text.trim()
    const cites = citations.map((c) => `[${c.relPath}:${c.line}]`).join(' ')
    const atts = sendableAttachments.map((a) => `[${a.relPath}]`).join('\n')
    const body = [t, cites, atts].filter(Boolean).join('\n\n')
    if (!body) return
    onSend(body)
    setText('')
    onCitationsConsumed?.()
  }

  return (
    <div
      className={`relative border-t border-hair p-3 ${dynamic ? 'dyn-rail' : 'bg-deep'}`}
      data-onboarding-anchor="composer"
    >
      {popupOpen && (
        <div className="absolute bottom-full left-3 z-20 mb-1 w-96 rounded-r2 border border-hair bg-overlay p-1 shadow-lg">
          {matches.map((s, i) => (
            <button
              key={s.name}
              className={`block w-full rounded-r1 px-2 py-1 text-left transition-colors hover:bg-hi ${
                i === highlighted ? 'bg-signal/20' : ''
              }`}
              onClick={() => completeSkill(s.name)}
            >
              <span className="font-mono text-xs text-defect">/{s.name}</span>
              <span className="ml-2 text-xs text-mute">{s.description}</span>
            </button>
          ))}
        </div>
      )}
      <AttachmentTray attachments={attachments} onRemove={(id) => onRemoveAttachment?.(id)} />
      {citations.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {citations.map((c, i) => (
            <button
              key={`${c.relPath}:${c.line}:${i}`}
              type="button"
              className="flex items-center gap-1 rounded-r2 border border-hair bg-hi px-2 py-0.5 font-mono text-[11px] text-dim transition-colors hover:text-ink"
              title="Remove citation"
              onClick={() => onRemoveCitation?.(i)}
            >
              <span>
                {c.relPath}:{c.line}
              </span>
              <span className="text-mute">×</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={`flex flex-col gap-2 rounded-r4 border border-hair px-3 pb-2.5 pt-3 transition-colors focus-within:border-hair2 ${dynamic ? 'glass-panel' : 'bg-panel'}`}
      >
        <textarea
          rows={3}
          className="w-full resize-none bg-transparent px-1 text-sm text-ink placeholder:text-mute focus:outline-none"
          placeholder="Message the analyst — / for skills"
          value={text}
          disabled={disabled}
          onChange={(e) => updateText(e.target.value)}
          onPaste={(e) => {
            // Only intercept when the clipboard actually carries files. A plain text
            // paste — including from an image-bearing app — leaves `.files` empty and
            // must fall through to the browser untouched.
            const files = Array.from(e.clipboardData?.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            onAttachFiles?.(files, { fromClipboard: true })
          }}
          onDragOver={(e) => {
            if (onAttachFiles) e.preventDefault() // required for onDrop to fire
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            onAttachFiles?.(files)
          }}
          onKeyDown={(e) => {
            if (popupOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const delta = e.key === 'ArrowDown' ? 1 : -1
                setHighlight((highlighted + delta + matches.length) % matches.length)
                return
              }
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault()
                completeSkill(matches[highlighted].name)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSkillsDismissed(true)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="flex items-center gap-2">
          <OptionChip
            icon={<Sparkles size={12} strokeWidth={1.5} />}
            menuLabel="Model"
            value={model}
            onChange={(label) => {
              const picked = models.find((m) => modelOptionLabel(m, showProvider) === label)
              if (picked) onModelChange?.(picked.instanceId, picked.slug)
            }}
            options={modelOptions}
          />
          {descriptors.map((d) => (
            <Fragment key={d.id}>
              <Divider />
              <DescriptorChip
                descriptor={d}
                selections={selections}
                onChange={(v) => changeOption(d, v)}
              />
            </Fragment>
          ))}
          <Divider />
          <OptionChip
            icon={<Lock size={12} strokeWidth={1.5} />}
            menuLabel="Permission mode"
            value={permission}
            onChange={(label) => {
              const mode = PERMISSION_MODES.find((m) => PERMISSION_MODE_LABELS[m] === label)
              if (mode) onPermissionModeChange?.(mode)
            }}
            options={permissionOptions}
          />
          <Divider />
          <button
            type="button"
            aria-label={showToolCalls ? 'Hide tool results' : 'Show tool results'}
            title={showToolCalls ? 'Hide tool results' : 'Show tool results'}
            className={`flex items-center gap-1.5 rounded-r2 px-2 py-1 text-xs transition-colors hover:bg-hair ${
              showToolCalls ? 'text-ink' : 'text-mute'
            }`}
            onClick={() => uiStore.toggleToolCalls()}
          >
            <SquareTerminal size={12} strokeWidth={1.5} />
            <span>Tool results</span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${showToolCalls ? 'bg-review' : 'bg-faint'}`}
            />
          </button>
          <button
            type="button"
            aria-label="Send"
            title="Send (⏎)"
            disabled={
              disabled ||
              (!text.trim() && citations.length === 0 && sendableAttachments.length === 0)
            }
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal text-void transition-all hover:brightness-110 disabled:opacity-40"
            onClick={send}
          >
            <ArrowUp size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
