import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from 'react'
import { ChevronDown, Sparkles, Lock, SquareTerminal, ArrowUp, Square } from 'lucide-react'
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
  resolveModelInfo,
  type AggregatedModel
} from '../../../shared/drivers'
import {
  PERMISSION_MODE_LABELS,
  MODE_BY_LABEL,
  type PermissionMode
} from '../../../shared/settings'
import {
  descriptorsFor,
  pruneSelections,
  selectionValue,
  hasUltrathink,
  applyUltrathink,
  stripUltrathink,
  type RunOptionDescriptor,
  type RunOptionSelection
} from '../../../shared/runOptions'
import type { SkillListItem } from '../../../shared/memoryIpc'
import type { SessionSummary } from '../../../shared/types'
import { useModelCatalog } from '../lib/catalogStore'
import { TraitsChip, CollapsedMenu, type CollapsedSection } from './OptionsMenu'

/**
 * Session-option picker: model and permission mode. Reasoning, Context Window, Fast Mode and
 * Thinking are rendered together as ONE fused chip — the descriptor-driven `TraitsChip` in
 * OptionsMenu.tsx — instead of one `OptionChip` each; see the `descriptors` map in the
 * Composer body below.
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
        // `min-w-0` rather than `shrink-0`: the Model chip renders inside a width-capped
        // wrapper (MODEL_CHIP_MAX) and has to truncate there instead of overflowing it. Every
        // other use sits in a `shrink-0` wrapper, so it still takes its natural width.
        className="flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <span className="flex shrink-0">{icon}</span>
        <span className="truncate">{value}</span>
        <ChevronDown size={10} strokeWidth={1.5} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={menuLabel}
            className="absolute bottom-full left-0 z-30 mb-1 min-w-40 rounded-r2 overlay-menu p-1"
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

/** Tailwind `gap-2` on the options row, in CSS px. The fit math has to add this back by
 *  hand: `gap` is real layout space between flex items but belongs to no element, so it
 *  appears in nobody's `offsetWidth`. */
const ROW_GAP_PX = 8

/** Width assumed for the `…` trigger until it has actually rendered once and can be
 *  measured. It is an icon-only button (`px-2` + a 14px glyph), so its width is a constant
 *  the moment it exists — this estimate is only ever used on the very first measurement pass
 *  of a row that starts out collapsed, and is replaced by the real value on the next one. */
const MORE_TRIGGER_PX = 30

/**
 * Widest the Model chip may grow before its label truncates.
 *
 * Load-bearing for the fit math, not just for looks: the algorithm below charges the Model
 * chip its measured width and everything else is sized around it, so the chip must NOT be
 * free to shrink in response to the layout it is an input to. Capping it makes its width a
 * constant of the label instead of a function of the row's own decision, which is what keeps
 * the computation a pure function of (container width, item widths) — see `useVisibleCount`.
 */
const MODEL_CHIP_MAX = 'max-w-52'

/** Shown on the Reasoning section when the word appears in the body rather than the leading
 *  marker we wrote — stripping it there would mangle the user's own message, so the section
 *  locks instead. */
const ULTRATHINK_LOCK_NOTE =
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.'

/**
 * How many of the collapsible controls currently fit, counted from the left.
 *
 * Replaces a single fixed `COLLAPSE_AT_PX` threshold that had exactly two states — every chip,
 * or every chip at once inside `…` — and was deliberately set BELOW the row's true worst-case
 * width (650 against a ~760-790px worst case). Both of that design's failures were real and
 * visible: between the threshold and the worst case the row simply overflowed and pushed Send
 * out of frame, and below it the row hid controls it still had room for.
 *
 * The old comment justified the fixed threshold by noting that measuring overflow
 * (`scrollWidth > clientWidth`) oscillates, because collapsing changes the very width the
 * condition is read from. That is true of that measurement, and it is why this one is built
 * differently: **every collapsible item is always rendered and always measured**, either in the
 * row or — when it does not fit — inside a 0×0 clipped container that keeps it out of flow (see
 * the ghost row in the JSX). So an item's measured width never depends on whether it is
 * currently shown, the container's width never depends on the decision, and `k` is therefore a
 * pure function of (container width, item widths). Nothing it reads can change as a result of
 * what it decides, so there is no loop to oscillate.
 *
 * Items are dropped from the END of the display order (Tool results, then Access, then
 * Traits), which is why the visible set is always a prefix and chips never reorder as the pane
 * narrows. The `…` trigger charges its own width whenever anything is hidden — forgetting that
 * is the classic priority-navigation bug where the last item fits only until the button meant
 * to hold it appears.
 */
function useVisibleCount(
  rowRef: RefObject<HTMLDivElement | null>,
  modelRef: RefObject<HTMLDivElement | null>,
  sendRef: RefObject<HTMLButtonElement | null>,
  moreRef: RefObject<HTMLDivElement | null>,
  itemEls: RefObject<(HTMLDivElement | null)[]>,
  itemCount: number
): number {
  const [visible, setVisible] = useState(itemCount)
  const moreWidth = useRef(MORE_TRIGGER_PX)
  // Layout effect, not a passive one: this runs between React's mutation of the DOM and the
  // browser's paint, so a row that needs to collapse never paints overflowing first.
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const available = row.clientWidth
      // A pane that is display:none or mid-teardown reports 0 and would collapse everything
      // for no reason. Keep the last good answer instead.
      if (available <= 0) return
      if (moreRef.current) moreWidth.current = moreRef.current.offsetWidth
      const fixed =
        (modelRef.current?.offsetWidth ?? 0) + ROW_GAP_PX + (sendRef.current?.offsetWidth ?? 0)
      const widths = itemEls.current.slice(0, itemCount).map((el) => el?.offsetWidth ?? 0)
      let k = itemCount
      for (; k > 0; k--) {
        let used = fixed
        for (let i = 0; i < k; i++) used += ROW_GAP_PX + widths[i]
        if (k < itemCount) used += ROW_GAP_PX + moreWidth.current
        if (used <= available) break
      }
      setVisible(k)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    // The items are observed too, not just the container: a chip's own label changes width
    // without the row changing size at all (switching model, or toggling Fast Mode, rewrites
    // the traits label), and that has to re-run the fit.
    for (const el of itemEls.current) if (el) ro.observe(el)
    return () => ro.disconnect()
  })
  // `itemCount` changes when a model with no descriptors drops the Traits chip entirely;
  // clamping here keeps the count honest before the effect re-runs.
  return Math.min(visible, itemCount)
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
  onPermissionModeChange,
  running,
  onStop
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
  /** The agent is currently generating — swaps the send button for a stop button. */
  running?: boolean
  /** Interrupt the running turn. */
  onStop?: () => void
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
  // shared resolver. Anything else and the composer offers options the wire then drops.
  // `resolveModelInfo` falls back to the static built-in capability table for the models the
  // CLI's alias menu omits but still runs (Opus 4.8/4.7, Sonnet 4.6); without that they would
  // merge into the picker with no options at all.
  const pinnedModel = session?.model ?? current?.slug
  const info = resolveModelInfo(catalog, pinnedModel)
  // `pinnedModel` is passed, not just resolved: it is what actually goes on the wire, and the
  // Context Window control keys off the suffix it carries (see `forcesOneMillion`). Main passes
  // the same string to the same function in `buildRunOptionQueryFields`.
  const descriptors: RunOptionDescriptor[] = info ? descriptorsFor(info, pinnedModel) : []
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

  // Drives the chip's Ultracode treatment (main.css `.argus-ultracode`). Deliberately the
  // SAME expression `claudeSettingsFor` reads to decide whether to send `ultracode: true`, so
  // the animation can only be showing while the wire actually carries the setting — a lit chip
  // over a plain xhigh run would be a false signal about what the send costs.
  //
  // Ultrathink vetoes it: it overrides this chip's Reasoning label (see `labelFor` below), so a
  // chip reading "Ultrathink" must not also be wearing the Ultracode treatment — and while the
  // marker is in the draft, `effectiveEffort` never sees the stored value anyway.
  const effortDescriptor = descriptors.find((d) => d.id === 'effort')
  const ultracodeOn =
    !ultrathinkOn &&
    !!effortDescriptor &&
    selectionValue(effortDescriptor, selections) === 'ultracode'

  // Drives both the trigger-label override (below) and the open menu's highlighted-entry
  // override (`currentOverride` on TraitsChip/CollapsedMenu). Reads the descriptor's
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

  // Staged text (a suggestion button like Analyze in the evidence library, a
  // panel's `sendToAgent`, a related-history citation) adopts into the box
  // under three cases, decided against what the box holds RIGHT NOW rather
  // than always replacing or always appending:
  //   1. Empty box -> adopt verbatim.
  //   2. Box holds exactly the previously staged block, untouched -> REPLACE.
  //      Two suggestion clicks in a row (Analyze the wrong file, notice it,
  //      Analyze the right one) is a correction, not two things to send —
  //      the seam's non-prose consumers stage slash commands
  //      (`CaseFiles.tsx`'s `/${skill} ${relPath}`), and appending would leave
  //      a second command on line 2, where it can never run as a command.
  //   3. Box holds anything else (typed prose, an edited staged block) ->
  //      APPEND. The staging surface is usually a modal covering this
  //      composer, so replacing here would silently destroy a half-written
  //      sentence with no undo.
  // Adjust-state-during-render pattern instead of a setState effect.
  const [lastPrefill, setLastPrefill] = useState(prefill)
  if (prefill !== lastPrefill) {
    setLastPrefill(prefill)
    // Staged blocks already end with `\n`; one separator keeps a typed line and
    // the block from running together without piling up blank lines. This is a
    // VALUE update, not a functional updater: a double-invoked StrictMode
    // render recomputes the same string from the same `text`/`lastPrefill`
    // closure and cannot double-append.
    if (prefill) setText(text && text !== lastPrefill ? `${text}\n${prefill}` : prefill)
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
  const modelRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const itemEls = useRef<(HTMLDivElement | null)[]>([])

  // Send is hoisted because it is one element shared verbatim by both densities. Tool
  // results is hoisted too, but NOT for identical markup: wide renders it as its own chip
  // (icon + label + state dot, own popup), narrow renders it as a labelled On/Off section
  // inside CollapsedMenu — both share this same `showToolCalls` state and toggle callback.
  const toolResultsButton = (
    <button
      type="button"
      aria-label={showToolCalls ? 'Hide tool results' : 'Show tool results'}
      title={showToolCalls ? 'Hide tool results' : 'Show tool results'}
      // `whitespace-nowrap` is not cosmetic: without it this label wrapped to two lines the
      // moment the row ran tight, growing the row taller instead of letting the fit
      // computation collapse the chip.
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-r2 px-2 py-1 text-xs transition-colors hover:bg-hair ${
        showToolCalls ? 'text-ink' : 'text-mute'
      }`}
      onClick={() => uiStore.toggleToolCalls()}
    >
      <SquareTerminal size={12} strokeWidth={1.5} />
      <span>Tool results</span>
      <span className={`h-1.5 w-1.5 rounded-full ${showToolCalls ? 'bg-review' : 'bg-faint'}`} />
    </button>
  )

  const sendButton = running ? (
    <button
      ref={sendRef}
      type="button"
      aria-label="Stop"
      title="Stop generating"
      className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger text-void transition-all hover:brightness-110"
      onClick={onStop}
    >
      <Square size={12} strokeWidth={2} className="fill-current" />
    </button>
  ) : (
    <button
      ref={sendRef}
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

  /**
   * The collapsible controls, in display order. Dropped from the END as the row narrows —
   * Tool results first, then Access, and the Traits chip survives longest because it carries
   * the most state (reasoning, context window, fast mode, thinking) behind one trigger.
   *
   * The Model chip and Send are deliberately absent: they are never collapsible.
   */
  const rowItems: { id: CollapsedSection; node: React.ReactNode }[] = [
    ...(descriptors.length > 0
      ? [
          {
            id: 'traits' as const,
            node: (
              <TraitsChip
                descriptors={descriptors}
                selections={selections}
                onChangeOption={changeOption}
                labelFor={(d) => (d.id === 'effort' && ultrathinkOn ? 'Ultrathink' : undefined)}
                isLocked={(d) => d.id === 'effort' && ultrathinkInBody}
                lockNote={ULTRATHINK_LOCK_NOTE}
                currentOverride={(d) => (ultrathinkOn ? promptInjectedValue(d) : undefined)}
                ultracode={ultracodeOn}
              />
            )
          }
        ]
      : []),
    {
      id: 'access' as const,
      node: (
        <OptionChip
          icon={<Lock size={12} strokeWidth={1.5} />}
          menuLabel="Permission mode"
          value={permission}
          onChange={(label) => onPermissionModeChange?.(MODE_BY_LABEL[label])}
          options={permissionOptions}
        />
      )
    },
    { id: 'toolResults' as const, node: toolResultsButton }
  ]

  const visibleCount = useVisibleCount(rowRef, modelRef, sendRef, moreRef, itemEls, rowItems.length)
  const hiddenSections = rowItems.slice(visibleCount).map((it) => it.id)

  /** One collapsible control plus the divider that precedes it, measured as a unit so the
   *  divider's own width and gap can never be forgotten by the fit math. */
  const rowItem = (item: (typeof rowItems)[number], index: number): React.JSX.Element => (
    <div
      key={item.id}
      data-composer-item={item.id}
      ref={(el) => {
        itemEls.current[index] = el
      }}
      className="flex shrink-0 items-center gap-2"
    >
      <Divider />
      {item.node}
    </div>
  )

  return (
    <div
      className={`relative border-t border-hair p-3 ${dynamic ? 'dyn-rail' : 'bg-void'}`}
      data-onboarding-anchor="composer"
    >
      {popupOpen && (
        <div className="absolute bottom-full left-3 z-30 mb-1 w-96 rounded-r2 overlay-menu p-1">
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
        // `relative` anchors the measurement ghost row at the bottom of this block.
        className={`relative flex flex-col gap-2 rounded-r4 border border-hair px-3 pb-2.5 pt-3 transition-colors focus-within:border-hair2 ${dynamic ? 'glass-panel' : 'bg-panel'}`}
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
          // `density` is kept as the coarse "is anything hidden" signal it always was;
          // `data-composer-visible` is the finer one collapse is now actually driven by.
          data-composer-density={visibleCount === rowItems.length ? 'wide' : 'narrow'}
          data-composer-visible={visibleCount}
          className="flex items-center gap-2"
        >
          {/* Model chip: never collapsible, and width-capped so the fit math below has a
              fixed quantity to size everything else against — see MODEL_CHIP_MAX. */}
          <div
            ref={modelRef}
            data-composer-model=""
            className={`flex shrink-0 items-center ${MODEL_CHIP_MAX}`}
          >
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
          </div>
          {rowItems.slice(0, visibleCount).map(rowItem)}
          {hiddenSections.length > 0 && (
            <div ref={moreRef} data-composer-more="" className="shrink-0">
              <CollapsedMenu
                sections={hiddenSections}
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
                // Only when the Traits chip is the thing that got collapsed. The `…` carries
                // the Ultracode treatment as a STAND-IN for that chip, so once collapse became
                // incremental — Traits on the row while Tool results hides in the menu — an
                // unconditional flag put the same animated pill on both at once.
                ultracode={ultracodeOn && hiddenSections.includes('traits')}
              />
            </div>
          )}
          {sendButton}
        </div>
        {/*
          Ghost row: the collapsed items, still rendered so they can still be MEASURED. This is
          what lets `useVisibleCount` avoid the oscillation the old fixed threshold existed to
          dodge — a hidden item's width is what decides whether it may come back, so it has to
          stay measurable the whole time it is hidden.

          Deliberately a SIBLING of the options row, not a child: it holds duplicates of real
          chips, so keeping it outside means "everything inside the row" is exactly "everything
          the user can actually see and click" — for tests, for the CDP scripts, and for
          anything else that queries the row.

          The 0×0 `overflow-hidden` wrapper is doing real work: it is out of flow AND clips its
          own content, so an over-wide ghost contributes nothing to any ancestor's scrollWidth
          (no phantom horizontal scrollbar). The inner `w-max` is what gives the ghosts their
          NATURAL width inside a zero-width parent — without it they would measure 0 and every
          hidden chip would look like it fits.

          `inert` keeps them out of tab order and the accessibility tree, so the duplicate
          triggers are unreachable rather than merely invisible.
        */}
        <div
          aria-hidden
          inert
          data-composer-ghosts=""
          className="pointer-events-none absolute h-0 w-0 overflow-hidden"
        >
          <div className="flex w-max items-center gap-2">
            {rowItems.map((it, i) => (i < visibleCount ? null : rowItem(it, i)))}
          </div>
        </div>
      </div>
    </div>
  )
}
