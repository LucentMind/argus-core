import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { ChevronDown, Sparkles, Lock, SquareTerminal, ArrowUp } from 'lucide-react'
import { uiStore } from '../lib/uiStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { AttachmentTray } from './AttachmentTray'
import type { Attachment } from '../lib/composerAttachments'
import {
  allVisibleModels,
  capabilitiesFor,
  catalogModelRows,
  defaultInstanceId,
  defaultModelRef,
  findModelRow,
  instanceModels,
  type AggregatedModel
} from '../../../shared/drivers'
import { findModelEntry } from '../../../shared/modelIdentity'
import {
  PERMISSION_MODE_LABELS,
  MODE_BY_LABEL,
  type PermissionMode
} from '../../../shared/settings'
import {
  descriptorsFor,
  pruneSelections,
  hasUltrathink,
  applyUltrathink,
  stripUltrathink,
  type RunOptionDescriptor,
  type RunOptionSelection
} from '../../../shared/runOptions'
import type { SkillListItem } from '../../../shared/memoryIpc'
import type { SessionSummary } from '../../../shared/types'
import { useModelCatalog } from '../lib/catalogStore'
import { DescriptorChip, CollapsedMenu } from './OptionsMenu'

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

/**
 * Collapse threshold in CSS px.
 *
 * The widest row a model can produce is Model + FOUR descriptor chips (Reasoning, Context
 * Window, Fast Mode, Thinking — the previous docstring enumerated only three and omitted
 * Thinking) + Access + Tool results + Send, with a divider and a `gap-2` between each. At
 * `text-xs` those add up to roughly:
 *
 *   Model ~130 · Reasoning ~90 · Context ~56 · Fast Mode ~100 · Thinking ~95 ·
 *   Access ~125-155 · Tool results ~114 · Send 32 · dividers+gaps ~62   =>  ~800-830px
 *
 * The threshold is deliberately set BELOW that worst case rather than at it. Collapsing a
 * row that would still have fit costs the user every chip at once, on panes that are common;
 * the 700-830 band instead just runs tight, and only for a model that reports all four
 * descriptors while the Access chip carries its longest label. 560 was well under even the
 * typical row and is what let five chips crowd together unlabelled.
 *
 * Deliberately a fixed threshold rather than an overflow measurement
 * (`scrollWidth > clientWidth`): collapsing changes the width, which can un-trigger
 * the condition and oscillate.
 */
const COLLAPSE_AT_PX = 700

/** Shown on the Reasoning section when the word appears in the body rather than the leading
 *  marker we wrote — stripping it there would mangle the user's own message, so the section
 *  locks instead. */
const ULTRATHINK_LOCK_NOTE =
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.'

function useDensity(ref: RefObject<HTMLDivElement | null>): 'wide' | 'narrow' {
  const [density, setDensity] = useState<'wide' | 'narrow'>('wide')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = (): void =>
      setDensity(el.clientWidth > 0 && el.clientWidth < COLLAPSE_AT_PX ? 'narrow' : 'wide')
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return density
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
  const catalogRows = catalogModelRows(catalog)
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
  //
  // `findModelRow` is the SHARED resolver (shared/modelIdentity.ts) the Claude driver's
  // `catalogFor` also uses. Plain `slug === session.model` used to be the comparison here,
  // and it never matched once a runtime catalog loaded: catalog rows are keyed by CLI alias
  // (`fable`), sessions are pinned by wire slug (`claude-fable-5`). Every chat therefore fell
  // through to `models[0]` and its chip read "Default (recommended)".
  const fallback = settingsPayload ? defaultModelRef(settingsPayload.settings) : undefined
  const ownInstance = models.filter((m) => m.instanceId === session?.instanceId)
  const pinnedRow =
    findModelRow(ownInstance, session?.model) ?? findModelRow(models, session?.model)
  const current =
    pinnedRow ??
    // Only when the session names no model of its own — a session pinned to something we
    // cannot resolve must NOT silently display the settings default (see `unresolvedLabel`).
    (session?.model
      ? null
      : (findModelRow(
          models.filter((m) => m.instanceId === fallback?.instanceId),
          fallback?.slug
        ) ?? models[0]))
  // A session pinned to a model the loaded catalog no longer offers (say `claude-opus-4-8`
  // after the CLI dropped it) resolves to no row at all. Name it anyway — the static
  // catalog's display name when we still know it, else the raw slug — rather than showing
  // some other model's name as if it were this chat's. Gated on `settingsPayload`, because
  // before it arrives there are no rows to fail against yet: that is "still loading", not
  // "unresolvable", and the static placeholder below is the better thing to show.
  const unresolvedLabel =
    !current && session?.model && settingsPayload
      ? (instanceModels(settingsPayload.settings, session.instanceId ?? undefined).find(
          (m) => m.slug === session.model
        )?.name ?? session.model)
      : null
  const model = current
    ? modelOptionLabel(current, showProvider)
    : (unresolvedLabel ?? modelOptions[0])

  // Run-option descriptors come from what the CLI reports about the model THIS SESSION IS
  // PINNED TO — the same string `catalogFor` resolves in the main process, through the same
  // shared matcher. Anything else and the composer offers options the wire then drops.
  const info = findModelEntry(catalog, session?.model ?? current?.slug, (m) => m)
  const descriptors: RunOptionDescriptor[] = info ? descriptorsFor(info) : []
  const selections = session?.runOptions ?? []

  // Ultrathink is prompt text, not a stored selection, so its state is read back out
  // of the draft. That is what makes it impossible to desync from what is sent.
  const ultrathinkOn = hasUltrathink(text)
  // If the user edits the marker itself into something that no longer matches
  // `stripUltrathink`'s regex (e.g. deletes the colon, leaving "Ultrathink\nfix it"),
  // stripping it leaves the word still present — so this reads as the word appearing in
  // the BODY, same as if the user had typed "please ultrathink" from scratch, and the
  // section locks. That's a defensible reading (the text genuinely is no longer the
  // marker) but is easy to trip over by accident, hence this note.
  const ultrathinkInBody = ultrathinkOn && hasUltrathink(stripUltrathink(text))

  // Drives both the trigger-label override (below) and the open menu's highlighted-entry
  // override (`currentOverride` on DescriptorChip/CollapsedMenu). Reads the descriptor's
  // own `promptInjected` array — the same field `changeOption` below checks — instead of
  // hardcoding the string 'ultrathink', so it stays correct if another prompt-injected
  // option is ever added.
  function promptInjectedValue(d: RunOptionDescriptor): string | boolean | undefined {
    return d.type === 'select' ? d.promptInjected?.[0] : undefined
  }

  function changeOption(d: RunOptionDescriptor, value: string | boolean): void {
    if (d.type === 'select' && d.promptInjected?.includes(String(value))) {
      setText(applyUltrathink(text))
      return
    }
    if (ultrathinkInBody && d.id === 'effort') return
    if (ultrathinkOn && d.id === 'effort') setText(stripUltrathink(text))
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

  const rowRef = useRef<HTMLDivElement>(null)
  const density = useDensity(rowRef)

  // Send is hoisted because it is one element shared verbatim by both densities. Tool
  // results is hoisted too, but NOT for identical markup: wide renders it as its own chip
  // (icon + label + state dot, own popup), narrow renders it as a labelled On/Off section
  // inside CollapsedMenu — both share this same `showToolCalls` state and toggle callback.
  const toolResultsButton = (
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
      <span className={`h-1.5 w-1.5 rounded-full ${showToolCalls ? 'bg-review' : 'bg-faint'}`} />
    </button>
  )

  const sendButton = (
    <button
      type="button"
      aria-label="Send"
      title="Send (⏎)"
      disabled={
        disabled || (!text.trim() && citations.length === 0 && sendableAttachments.length === 0)
      }
      className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal text-void transition-all hover:brightness-110 disabled:opacity-40"
      onClick={send}
    >
      <ArrowUp size={14} strokeWidth={2} />
    </button>
  )

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
        <div
          ref={rowRef}
          data-testid="composer-options"
          data-composer-density={density}
          className="flex items-center gap-2"
        >
          {/* Model chip: unchanged, survives both densities */}
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
          {density === 'wide' ? (
            <>
              {descriptors.map((d) => (
                <Fragment key={d.id}>
                  <Divider />
                  <DescriptorChip
                    descriptor={d}
                    selections={selections}
                    onChange={(v) => changeOption(d, v)}
                    label={d.id === 'effort' && ultrathinkOn ? 'Ultrathink' : undefined}
                    currentOverride={ultrathinkOn ? promptInjectedValue(d) : undefined}
                    locked={d.id === 'effort' && ultrathinkInBody}
                    lockNote={
                      d.id === 'effort' && ultrathinkInBody ? ULTRATHINK_LOCK_NOTE : undefined
                    }
                  />
                </Fragment>
              ))}
              <Divider />
              <OptionChip
                icon={<Lock size={12} strokeWidth={1.5} />}
                menuLabel="Permission mode"
                value={permission}
                onChange={(label) => onPermissionModeChange?.(MODE_BY_LABEL[label])}
                options={permissionOptions}
              />
              <Divider />
              {toolResultsButton}
            </>
          ) : (
            <CollapsedMenu
              descriptors={descriptors}
              selections={selections}
              onChangeOption={changeOption}
              isLocked={(d) => d.id === 'effort' && ultrathinkInBody}
              lockNote={ULTRATHINK_LOCK_NOTE}
              currentOverride={(d) => (ultrathinkOn ? promptInjectedValue(d) : undefined)}
              permissionOptions={permissionOptions}
              permission={permission}
              onPermissionChange={(label) => onPermissionModeChange?.(MODE_BY_LABEL[label])}
              showToolCalls={showToolCalls}
              onToggleToolCalls={() => uiStore.toggleToolCalls()}
            />
          )}
          {sendButton}
        </div>
      </div>
    </div>
  )
}
