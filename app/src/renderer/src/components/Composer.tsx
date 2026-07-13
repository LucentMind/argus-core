import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Sparkles, Lock, Gauge, SquareTerminal, ArrowUp } from 'lucide-react'
import { uiStore } from '../lib/uiStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { orderedVisibleModels, effectiveDefaultModel } from '../../../shared/drivers'
import { PERMISSION_MODE_LABELS } from '../../../shared/settings'
import type { SkillListItem } from '../../../shared/memoryIpc'

/**
 * Placeholder session-option pickers (model / reasoning / permission mode).
 * Purely cosmetic for now — the selection is local UI state and is not sent
 * to the agent session yet.
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
        title={`${menuLabel} (not wired yet)`}
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

function Divider(): React.JSX.Element {
  return <span className="h-4 w-px shrink-0 bg-hair2" />
}

export function Composer({
  disabled,
  onSend,
  prefill,
  citations = [],
  onRemoveCitation,
  onCitationsConsumed
}: {
  disabled: boolean
  onSend: (text: string) => void
  prefill?: string
  citations?: { relPath: string; line: number }[]
  onRemoveCitation?: (index: number) => void
  onCitationsConsumed?: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [skills, setSkills] = useState<SkillListItem[]>([])
  const [model, setModel] = useState('Claude Fable 5')
  const [reasoning, setReasoning] = useState('High · 200k')
  const [permission, setPermission] = useState('Ask approvals')
  const showToolCalls = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get().showToolCalls
  )

  useEffect(() => {
    void window.argus.skills.list().then((p) => setSkills(p.skills))
  }, [])

  // seed the pickers from settings once the payload first arrives — adjust-
  // state-during-render, matching the `prefill` idiom below; user changes
  // stay session-local after that (not wired to the SDK yet)
  const settingsPayload = useSettingsPayload()
  const [seeded, setSeeded] = useState(false)
  if (!seeded && settingsPayload) {
    setSeeded(true)
    setModel(effectiveDefaultModel(settingsPayload.settings) ?? 'Claude Fable 5')
    setPermission(PERMISSION_MODE_LABELS[settingsPayload.settings.agent.defaultPermissionMode])
  }

  // static display-name fallback until the settings payload first arrives;
  // once loaded, the picker follows the driver's model catalog ordering
  // (favorites first, hidden excluded) instead of this placeholder list
  const modelOptions = settingsPayload
    ? orderedVisibleModels(settingsPayload.settings).map((m) => m.slug)
    : ['Claude Fable 5', 'Claude Opus 4.8', 'Claude Sonnet 5', 'Claude Haiku 4.5']

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

  function send(): void {
    const t = text.trim()
    const cites = citations.map((c) => `[${c.relPath}:${c.line}]`).join(' ')
    const body = cites ? (t ? `${t}\n\n${cites}` : cites) : t
    if (!body) return
    onSend(body)
    setText('')
    onCitationsConsumed?.()
  }

  return (
    <div className="relative border-t border-hair bg-deep p-3">
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
      <div className="flex flex-col gap-2 rounded-r4 border border-hair bg-panel px-3 pb-2.5 pt-3 transition-colors focus-within:border-hair2">
        <textarea
          rows={3}
          className="w-full resize-none bg-transparent px-1 text-sm text-ink placeholder:text-mute focus:outline-none"
          placeholder="Message the analyst — / for skills"
          value={text}
          disabled={disabled}
          onChange={(e) => updateText(e.target.value)}
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
            onChange={setModel}
            options={modelOptions}
          />
          <Divider />
          <OptionChip
            icon={<Gauge size={12} strokeWidth={1.5} />}
            menuLabel="Reasoning"
            value={reasoning}
            onChange={setReasoning}
            options={['Max · 200k', 'High · 200k', 'Medium · 64k', 'Low · 16k']}
          />
          <Divider />
          <OptionChip
            icon={<Lock size={12} strokeWidth={1.5} />}
            menuLabel="Permission mode"
            value={permission}
            onChange={setPermission}
            options={Object.values(PERMISSION_MODE_LABELS)}
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
            disabled={disabled || (!text.trim() && citations.length === 0)}
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
