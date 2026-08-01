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
   *  `TraitsChip`/`CollapsedMenu` so the two can't drift apart. */
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

/**
 * One chip for EVERY descriptor, at wide density — the trigger label joins each descriptor's
 * current value with ` · `, in descriptor order (e.g. `Ultracode · 200k · Fast Off · Thinking
 * On`), and the popup holds one `OptionSection` per descriptor, in a single menu. This
 * replaced a one-chip-per-descriptor design (`DescriptorChip`, since removed): a model
 * reporting all four descriptors plus Access and Tool results overflowed the row well before
 * any individual chip's label got long, so collapsing every descriptor into ONE chip — rather
 * than shortening each chip's own label — is what actually bought back width. See
 * `COLLAPSE_AT_PX` in Composer.tsx for the threshold this shape lets be much narrower than
 * the old five-chip worst case required.
 *
 * A select descriptor's value is used bare (`selectionLabel` alone) — its vocabulary is
 * self-describing (`High`, `Ultracode`, `200k`, `1M`, …), same reasoning `DescriptorChip` used
 * to keep those chips value-only. A BOOLEAN descriptor's value is prefixed with its own label
 * (`Fast Off`, `Thinking On`) rather than left bare: two boolean values sitting side by side in
 * one joined string are otherwise indistinguishable ("… · Off · On" — which is which?) in
 * exactly the way a bare "Off"/"On" chip used to be before `DescriptorChip` started naming the
 * toggle on its own trigger (see that fix's own history) — fusing the chips must not
 * reintroduce that ambiguity.
 *
 * Reuses `OptionSection` verbatim — the same component the narrow density's `CollapsedMenu`
 * renders per descriptor — so the wide chip's popup and the narrow collapsed menu can never
 * disagree about what a section looks like or how a selection is highlighted.
 */
export function TraitsChip({
  descriptors,
  selections,
  onChangeOption,
  labelFor,
  isLocked,
  lockNote,
  currentOverride
}: {
  descriptors: readonly RunOptionDescriptor[]
  selections: readonly RunOptionSelection[]
  onChangeOption: (d: RunOptionDescriptor, value: string | boolean) => void
  /** Per-descriptor override for the JOINED trigger label — used for Ultrathink, whose
   *  state lives in the prompt rather than in `selections`, so `selectionLabel` alone
   *  cannot report it. Falls back to `selectionLabel(d, selections)` (name-prefixed for a
   *  boolean descriptor — see this component's own doc comment). */
  labelFor?: (d: RunOptionDescriptor) => string | undefined
  /** Per-descriptor lock — used for Ultrathink's body lock. */
  isLocked?: (d: RunOptionDescriptor) => boolean
  lockNote?: string
  /** Per-descriptor selection override — used for Ultrathink's highlighted entry. */
  currentOverride?: (d: RunOptionDescriptor) => string | boolean | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = descriptors
    .map((d) => {
      const override = labelFor?.(d)
      if (override !== undefined) return override
      const value = selectionLabel(d, selections)
      return d.type === 'boolean' ? `${d.label} ${value}` : value
    })
    .join(' · ')
  return (
    <div className="relative">
      <button
        type="button"
        title="Traits"
        aria-label={`Traits: ${label}`}
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <ChevronDown size={10} strokeWidth={1.5} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label="Traits"
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
   *  the wide chip's `TraitsChip`, so the two densities cannot diverge. */
  isLocked?: (d: RunOptionDescriptor) => boolean
  lockNote?: string
  /** Per-descriptor selection override — used for Ultrathink's highlighted entry. Shares
   *  `OptionSection` with `TraitsChip`, so the two densities cannot diverge. */
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
