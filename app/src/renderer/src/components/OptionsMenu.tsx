import { useState } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import {
  selectionLabel,
  selectionValue,
  type RunOptionDescriptor,
  type RunOptionSelection
} from '../../../shared/runOptions'

/** One labelled radio group per descriptor. Shared verbatim by the wide chips and the
 *  narrow collapsed popup, so the two can never drift apart. */
export function OptionSection({
  descriptor,
  selections,
  onChange,
  locked,
  lockNote,
  currentOverride
}: {
  descriptor: RunOptionDescriptor
  selections: readonly RunOptionSelection[]
  onChange: (value: string | boolean) => void
  locked?: boolean
  lockNote?: string
  /** Overrides which entry reads as selected — used for Ultrathink, whose state lives in
   *  the prompt rather than in `selections`. Mirrors the trigger-label override on
   *  `DescriptorChip`/`CollapsedMenu` so the two can't drift apart. */
  currentOverride?: string | boolean
}): React.JSX.Element {
  const current = currentOverride ?? selectionValue(descriptor, selections)
  const choices =
    descriptor.type === 'select'
      ? descriptor.options.map((o) => ({ value: o.value as string | boolean, label: o.label }))
      : [
          { value: true as string | boolean, label: 'On' },
          { value: false as string | boolean, label: 'Off' }
        ]
  return (
    <div>
      <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-mute">{descriptor.label}</div>
      {locked && lockNote ? <div className="px-2 pb-1.5 text-xs text-mute">{lockNote}</div> : null}
      {choices.map((c) => (
        <button
          key={String(c.value)}
          type="button"
          role="menuitem"
          disabled={locked}
          className={`block w-full whitespace-nowrap rounded-r1 px-2 py-1 text-left text-xs transition-colors hover:bg-hi disabled:opacity-40 ${
            c.value === current ? 'text-ink' : 'text-dim'
          }`}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

/** One chip per descriptor, reusing `OptionChip`'s overlay and positioning verbatim so the
 *  two popups (this wide row, and Task 13's narrow collapsed menu) cannot drift apart. */
export function DescriptorChip({
  descriptor,
  selections,
  onChange,
  label,
  locked,
  lockNote,
  currentOverride
}: {
  descriptor: RunOptionDescriptor
  selections: readonly RunOptionSelection[]
  onChange: (value: string | boolean) => void
  /** Overrides the derived label — used for Ultrathink, whose state lives in the prompt. */
  label?: string
  locked?: boolean
  lockNote?: string
  /** Overrides which entry the popup highlights as selected — see `OptionSection`. */
  currentOverride?: string | boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const text = label ?? selectionLabel(descriptor, selections)
  // A boolean chip showing only its value renders as a bare "On"/"Off", and Fast Mode and
  // Thinking sit next to each other — two identical chips, tellable apart only by hovering
  // for the tooltip. So booleans show WHICH toggle they are and put the state in a dot,
  // exactly the idiom the Tool results button beside them already uses. Select chips keep
  // value-only: their vocabularies (High/Extra High/Max/Ultracode… and 200k/1M) are unique
  // and self-describing, and the row has no width to spare — see COLLAPSE_AT_PX.
  const isBoolean = descriptor.type === 'boolean'
  const on = selectionValue(descriptor, selections) === true
  return (
    <div className="relative">
      <button
        type="button"
        title={descriptor.label}
        // The visible text is the toggle's NAME for a boolean, so its state has to reach the
        // accessibility tree some other way than the label.
        {...(isBoolean ? { 'aria-label': `${descriptor.label}: ${text}` } : {})}
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <span>{isBoolean ? descriptor.label : text}</span>
        {isBoolean && (
          <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-review' : 'bg-faint'}`} />
        )}
        <ChevronDown size={10} strokeWidth={1.5} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={descriptor.label}
            className="absolute bottom-full left-0 z-20 mb-1 min-w-40 rounded-r2 border border-hair bg-overlay p-1 shadow-lg"
          >
            <OptionSection
              descriptor={descriptor}
              selections={selections}
              locked={locked}
              lockNote={lockNote}
              currentOverride={currentOverride}
              onChange={(v) => {
                onChange(v)
                setOpen(false)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** Every control except Model and Send, in one popup. Sections are the same
 *  `OptionSection` the wide chips use, so the two renderings cannot diverge. */
export function CollapsedMenu({
  descriptors,
  selections,
  onChangeOption,
  isLocked,
  lockNote,
  currentOverride,
  permissionOptions,
  permission,
  onPermissionChange,
  showToolCalls,
  onToggleToolCalls
}: {
  descriptors: readonly RunOptionDescriptor[]
  selections: readonly RunOptionSelection[]
  onChangeOption: (d: RunOptionDescriptor, value: string | boolean) => void
  /** Per-descriptor lock — used for Ultrathink's body lock. Shares `OptionSection` with
   *  the wide chip's `DescriptorChip`, so the two densities cannot diverge. */
  isLocked?: (d: RunOptionDescriptor) => boolean
  lockNote?: string
  /** Per-descriptor selection override — used for Ultrathink's highlighted entry. Shares
   *  `OptionSection` with `DescriptorChip`, so the two densities cannot diverge. */
  currentOverride?: (d: RunOptionDescriptor) => string | boolean | undefined
  permissionOptions: string[]
  permission: string
  onPermissionChange: (label: string) => void
  showToolCalls: boolean
  onToggleToolCalls: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="More options"
        title="More options"
        className="flex items-center rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={14} strokeWidth={1.5} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label="Session options"
            className="absolute bottom-full left-0 z-20 mb-1 min-w-44 rounded-r2 border border-hair bg-overlay p-1 shadow-lg"
          >
            {descriptors.map((d) => (
              <OptionSection
                key={d.id}
                descriptor={d}
                selections={selections}
                locked={isLocked?.(d)}
                lockNote={lockNote}
                currentOverride={currentOverride?.(d)}
                onChange={(v) => onChangeOption(d, v)}
              />
            ))}
            <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-mute">Access</div>
            {permissionOptions.map((label) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className={`block w-full whitespace-nowrap rounded-r1 px-2 py-1 text-left text-xs transition-colors hover:bg-hi ${
                  label === permission ? 'text-ink' : 'text-dim'
                }`}
                onClick={() => {
                  onPermissionChange(label)
                  setOpen(false)
                }}
              >
                {label}
              </button>
            ))}
            <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-mute">Tool results</div>
            {[
              { label: 'On', on: true },
              { label: 'Off', on: false }
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="menuitem"
                className={`block w-full rounded-r1 px-2 py-1 text-left text-xs transition-colors hover:bg-hi ${
                  o.on === showToolCalls ? 'text-ink' : 'text-dim'
                }`}
                onClick={() => {
                  if (o.on !== showToolCalls) onToggleToolCalls()
                  setOpen(false)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
