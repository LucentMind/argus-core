import { useEffect, useRef, useState } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import {
  selectionLabel,
  selectionValue,
  type RunOptionDescriptor,
  type RunOptionSelection
} from '../../../shared/runOptions'

/** A choice as the controls below consume it — `RunOptionChoice` for a select, the two
 *  synthesised positions for a boolean.
 *
 *  `name` overrides the accessible name when the visible label alone would be ambiguous: one
 *  menu holds several Off/On pairs (Fast Mode, Thinking, Ultrathink), and three menuitems all
 *  named "On" is a menu a screen reader cannot navigate. */
type Choice = { value: string | boolean; label: string; name?: string }

/**
 * A row of side-by-side positions in one recessed track — the shape Claude Code's own
 * settings use for a short, closed set (Off/On, 200k/1M).
 *
 * Every position stays a `role="menuitem"` button whose accessible name is its own label,
 * and the selected one keeps `text-ink` against the others' `text-dim`. That is deliberate:
 * this replaced a vertical list of exactly those buttons, and keeping the role, the name and
 * the selected-state class means the change is purely visual to anything reading the menu —
 * a screen reader, or the composer's own tests.
 */
function Segmented({
  choices,
  current,
  onChange,
  locked,
  className
}: {
  choices: readonly Choice[]
  current: string | boolean | undefined
  onChange: (value: string | boolean) => void
  locked?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={`flex gap-0.5 rounded-r2 bg-hair p-0.5${className ? ` ${className}` : ''}`}>
      {choices.map((c) => (
        <button
          key={String(c.value)}
          type="button"
          role="menuitem"
          aria-label={c.name}
          disabled={locked}
          className={`flex-1 whitespace-nowrap rounded-r1 px-2 py-0.5 text-xs transition-colors disabled:opacity-40 ${
            c.value === current
              ? 'bg-hi text-ink shadow-sm'
              : 'text-dim hover:text-ink disabled:hover:text-dim'
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
 * An ordered scale as a slider — Claude Code's Effort control. Used instead of {@link Segmented}
 * once a descriptor offers enough positions that naming all of them side by side stops fitting
 * (Reasoning runs Low → Max plus Ultracode); the current value is named once in the section
 * header instead, and the track carries only dots.
 *
 * Each stop is still a `role="menuitem"` button — named via `aria-label`, since the visible
 * content is a dot — so the same reading holds as for `Segmented`: role, accessible name and
 * the `text-ink`/`text-dim` selected state all survive the redesign.
 *
 * It is draggable as well as clickable. The two paths are deliberately separate rather than
 * unified through one hit-test:
 *
 *  - Click is the stop buttons' own `onClick`, untouched. It needs no geometry, so it keeps
 *    working in jsdom — where every `getBoundingClientRect()` is a zero-sized box and a
 *    position-from-x calculation would land on stop 0 no matter where the click was.
 *  - Drag runs off `pointermove` on `window` (started by a `pointerdown` anywhere on the
 *    track) and bails whenever the track measures zero-width, so it can never fire in that
 *    same jsdom case and fight the click.
 *
 * Pointer *capture* is avoided on purpose: capturing retargets the subsequent `click` to the
 * capturing element, which would swallow the stop buttons' own clicks. Window listeners give
 * the same "keep tracking past the edge" behaviour without touching click dispatch. A drag
 * that starts and ends on different stops fires its `click` at the wrapper (their common
 * ancestor), not at a button, so the two paths never both apply a value.
 */
function Scale({
  choices,
  current,
  onChange,
  locked,
  minLabel,
  maxLabel
}: {
  choices: readonly Choice[]
  current: string | boolean | undefined
  onChange: (value: string | boolean) => void
  locked?: boolean
  minLabel: string
  maxLabel: string
}): React.JSX.Element {
  const selected = choices.findIndex((c) => c.value === current)
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  // Latest values for the window listeners below, which are installed once per drag and must
  // not go stale on the re-render each step of that drag causes.
  const live = useRef({ choices, current, onChange })
  useEffect(() => {
    live.current = { choices, current, onChange }
  })

  useEffect(() => {
    if (!dragging) return
    function apply(clientX: number): void {
      const el = trackRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return
      const { choices: cs, current: cur, onChange: fire } = live.current
      // Stops sit at the CENTRE of equal slices, so the boundary between two of them is the
      // midpoint between their dots — `round(t*n - 0.5)`, clamped, is exactly that.
      const i = Math.min(
        cs.length - 1,
        Math.max(0, Math.round(((clientX - r.left) / r.width) * cs.length - 0.5))
      )
      if (cs[i].value !== cur) fire(cs[i].value)
    }
    const move = (e: PointerEvent): void => apply(e.clientX)
    const stop = (): void => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging])

  /** Arrow keys walk the scale, so it is operable without a pointer at all. */
  function onKeyDown(e: React.KeyboardEvent): void {
    if (locked || selected < 0) return
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0
    if (step === 0) return
    const next = Math.min(choices.length - 1, Math.max(0, selected + step))
    if (next !== selected) {
      e.preventDefault()
      onChange(choices[next].value)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between pb-1 text-[10px] text-mute">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <div
        ref={trackRef}
        className={`relative h-5 touch-none select-none ${locked ? '' : 'cursor-pointer'}`}
        onPointerDown={() => {
          if (!locked) setDragging(true)
        }}
        onKeyDown={onKeyDown}
      >
        <div className="absolute inset-0 rounded-full bg-hair" />
        {/* The travelled part of the track, so the scale reads as a magnitude and not just as
            six equivalent dots. Stops at the CENTRE of the selected stop, which is where the
            thumb sits.

            `bg-faint`, not `bg-hair2`: the two hairlines are 4 percentage points of alpha
            apart (0.06 vs 0.10 in dark), which is a border-vs-border distinction and is
            invisible as a fill — seen live, the track read as uniformly dark. `--faint` is
            the lowest FOREGROUND step, so it clears the surface in both themes. */}
        {selected >= 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-faint"
            style={{ width: `${((selected + 0.5) / choices.length) * 100}%` }}
          />
        )}
        <div className="absolute inset-0 flex">
          {choices.map((c, i) => (
            <button
              key={String(c.value)}
              type="button"
              role="menuitem"
              aria-label={c.label}
              title={c.label}
              disabled={locked}
              className={`flex flex-1 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                i === selected ? 'text-ink' : 'text-dim hover:text-ink disabled:hover:text-dim'
              }`}
              onClick={() => onChange(c.value)}
            >
              {i === selected ? (
                <span
                  className={`h-3.5 w-3.5 rounded-r1 bg-ink transition-transform ${
                    dragging ? 'scale-110' : ''
                  }`}
                />
              ) : (
                /* Ultracode is not another notch further along the same axis — it is a
                   different kind of run that happens to sit at the far end — so its dot takes
                   the accent the chip's own `.argus-ultracode` treatment uses. */
                <span
                  className={`h-1 w-1 rounded-full ${
                    c.value === 'ultracode' ? 'bg-analytics' : 'bg-current opacity-60'
                  }`}
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Below this many positions a select is named in full, side by side; at or above it the
 *  labels stop fitting and the scale takes over. Two (Context Window) and three sit
 *  comfortably; Reasoning's five-to-six do not. */
const SCALE_AT = 4

/** One labelled control per descriptor. Shared verbatim by the wide chips and the
 *  narrow collapsed popup, so the two can never drift apart.
 *
 *  A prompt-injected value (Ultrathink) is pulled OUT of its descriptor's own control and
 *  given a row of its own: it is not a position on the Reasoning scale — it is prompt text
 *  that overrides whatever position is set — so sitting it on the track next to `Max` would
 *  claim an ordering that does not exist. It is read off `promptInjected` rather than by
 *  name, the same field `Composer`'s `changeOption` dispatches on. */
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
  const all: Choice[] =
    descriptor.type === 'select'
      ? descriptor.options.map((o) => ({ value: o.value as string | boolean, label: o.label }))
      : [
          { value: false as string | boolean, label: 'Off' },
          { value: true as string | boolean, label: 'On' }
        ]
  const injected =
    descriptor.type === 'select' ? (descriptor.promptInjected ?? []) : ([] as readonly string[])
  const choices = all.filter((c) => !injected.includes(String(c.value)))
  const extras = all.filter((c) => injected.includes(String(c.value)))
  const scale = choices.length >= SCALE_AT
  const currentLabel = all.find((c) => c.value === current)?.label

  return (
    <div className="px-2 pb-1.5 pt-1.5">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <span className="text-xs font-medium text-mute">{descriptor.label}</span>
        {/* The value is named here only when the control itself cannot name it — the scale
            shows dots, and a boolean's own row is a two-word toggle sitting right beside this. */}
        {scale && currentLabel ? (
          <span className="whitespace-nowrap text-xs text-ink">{currentLabel}</span>
        ) : null}
      </div>
      {locked && lockNote ? <div className="pb-1.5 text-xs text-mute">{lockNote}</div> : null}
      {scale ? (
        <Scale
          choices={choices}
          current={current}
          onChange={onChange}
          locked={locked}
          minLabel="Faster"
          maxLabel="Smarter"
        />
      ) : (
        <Segmented choices={choices} current={current} onChange={onChange} locked={locked} />
      )}
      {extras.map((c) => {
        const on = c.value === current
        return (
          <div key={String(c.value)} className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-xs text-dim">{c.label}</span>
            <Segmented
              className="w-24 shrink-0"
              choices={[
                { value: false, label: 'Off', name: `${c.label} Off` },
                { value: true, label: 'On', name: `${c.label} On` }
              ]}
              current={on}
              locked={locked}
              // The row is dispatched as a TOGGLE — `Composer`'s `changeOption` reads the
              // marker in the draft as the state and flips it — so this fires only when the
              // requested position differs from the current one. Firing unconditionally would
              // make clicking the already-selected segment turn the thing off, which is the
              // one thing a segmented control must never do.
              onChange={(want) => {
                if (want !== on) onChange(c.value)
              }}
            />
          </div>
        )
      })}
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
  currentOverride,
  ultracode
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
  /** Reasoning is on Ultracode: the trigger takes the animated treatment (main.css's
   *  `.argus-ultracode` — an outline in classic, a filled pill under `.dyn`). Passed in
   *  rather than derived here so ONE place decides what "on Ultracode" means, and the
   *  Ultrathink override — which relabels this same chip — can veto it. */
  ultracode?: boolean
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
        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink${
          ultracode ? ' argus-ultracode' : ''
        }`}
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
            className="absolute bottom-full left-0 z-30 mb-1 min-w-56 rounded-r2 overlay-menu p-1"
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

/** Which controls this menu is currently standing in for. The row hands over only the
 *  controls it could not fit, so the menu is never a duplicate of what is already on screen. */
export type CollapsedSection = 'traits' | 'access' | 'toolResults'

/** The controls the row could not fit, in one popup. Sections are the same `OptionSection`
 *  the wide chips use, so the two renderings cannot diverge.
 *
 *  Renders ONLY the sections named in `sections`: collapse is now incremental, so this menu
 *  routinely holds a strict subset. Listing a control here while its own chip is still visible
 *  in the row would give one setting two live controls a few pixels apart. */
export function CollapsedMenu({
  sections,
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
  onToggleToolCalls,
  ultracode
}: {
  sections: readonly CollapsedSection[]
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
  /** Reasoning is on Ultracode — same treatment `TraitsChip` gives its own trigger, on the
   *  collapsed `…` button, so the one state the user asked to be able to SEE does not vanish
   *  when the chip carrying it is folded away.
   *
   *  The caller must pass this ONLY when the Traits chip is itself collapsed. This button
   *  stands in for that chip; if both are on screen at once — which incremental collapse makes
   *  routine — the treatment would appear twice and read as two separate Ultracode states. */
  ultracode?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="More options"
        title="More options"
        className={`flex items-center rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink${
          ultracode ? ' argus-ultracode' : ''
        }`}
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
            className="absolute bottom-full left-0 z-30 mb-1 min-w-56 rounded-r2 overlay-menu p-1"
          >
            {sections.includes('traits') &&
              descriptors.map((d) => (
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
            {sections.includes('access') && (
              /* Access stays a stack rather than a `Segmented` row: its labels are sentences
                 ("Auto-approve edits"), not the one-word positions a segmented track fits. It
                 takes the same selected pill so it still reads as one family with them. */
              <div className="px-2 pb-1.5 pt-1.5">
                <div className="pb-1 text-xs font-medium text-mute">Access</div>
                <div className="flex flex-col gap-0.5 rounded-r2 bg-hair p-0.5">
                  {permissionOptions.map((label) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      className={`w-full whitespace-nowrap rounded-r1 px-2 py-0.5 text-left text-xs transition-colors ${
                        label === permission
                          ? 'bg-hi text-ink shadow-sm'
                          : 'text-dim hover:text-ink'
                      }`}
                      onClick={() => {
                        onPermissionChange(label)
                        setOpen(false)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {sections.includes('toolResults') && (
              <div className="px-2 pb-1.5 pt-1.5">
                <div className="pb-1 text-xs font-medium text-mute">Tool results</div>
                <Segmented
                  choices={[
                    { value: false, label: 'Off' },
                    { value: true, label: 'On' }
                  ]}
                  current={showToolCalls}
                  onChange={(v) => {
                    if (v !== showToolCalls) onToggleToolCalls()
                    setOpen(false)
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
