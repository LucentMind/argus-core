import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, Eraser } from 'lucide-react'
import { Card, IconBtn, SectionLabel, SkeletonRows } from '../ui'
import { pushEscapeLayer } from '../../lib/escapeLayer'
import { uiStore } from '../../lib/uiStore'

// `bg-well` (Task 12), not `bg-overlay`: every FIELD/TEXTAREA_FIELD sits inside a SettingsSection
// card, and `--bg-over` is tuned for the wash, not a near-white card fill — it read as no fill
// at all there. `--well` is the on-card counterpart.
export const FIELD =
  'h-7 rounded-r2 border border-hair bg-well px-2 text-xs text-ink placeholder:text-mute transition-colors focus:border-hair2 focus:outline-none'

/** Multi-line counterpart of {@link FIELD}. `FIELD`'s `h-7` is single-line-only, so a
 *  textarea that reused it would collapse; this keeps the same border/bg/focus tokens but
 *  fills its row and grows vertically instead. {@link DraftTextarea} applies it by default —
 *  the memory editors previously passed no class at all and fell back to the UA's ~20-column
 *  unpadded box, which rendered as a cramped scrolling sliver. */
export const TEXTAREA_FIELD =
  'w-full min-h-32 resize-y rounded-r2 border border-hair bg-well p-2 font-mono text-xs leading-relaxed text-ink placeholder:text-mute transition-colors focus:border-hair2 focus:outline-none'

/**
 * The settings-wide disclosure affordance: a chevron icon button that rotates when open.
 * Shared so the provider rows and the pack rows read as the same control — each previously
 * grew its own variant (the packs one even spelled out "N tools", which the pack row's own
 * badges already implied).
 */
export function DisclosureBtn({
  expanded,
  onToggle,
  label
}: {
  expanded: boolean
  onToggle: () => void
  /** Noun phrase for the a11y name, e.g. "provider details" → "Expand provider details". */
  label: string
}): React.JSX.Element {
  return (
    <IconBtn
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      aria-expanded={expanded}
      title={expanded ? 'Collapse' : 'Expand'}
      onClick={onToggle}
    >
      <ChevronDown
        size={14}
        strokeWidth={1.5}
        className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
      />
    </IconBtn>
  )
}

export function SettingsSection({
  title,
  subtitle,
  action,
  count,
  collapsed,
  onToggle,
  children
}: {
  /**
   * Omit it and the section renders as a bare card with no heading row.
   *
   * That is for the page whose ONLY section is the page itself — General, Connectors — where the
   * heading repeated the page label already showing in the header masthead (user-directed,
   * 2026-08-02). Every other page's sections name a genuine subdivision and keep their titles.
   *
   * A collapsible section must still pass one: the toggle takes its accessible name from the
   * title, so a titleless section has nothing to render the toggle *in*. Not expressible in this
   * prop type without a union that would cost more than it buys — the header row simply does not
   * render, which is loud rather than subtle if anyone tries it.
   */
  title?: string
  /** Supporting copy under the header — states what the section's rows have in common. */
  subtitle?: string
  /** Controls rendered on the section header line, right-aligned (e.g. a refresh button). */
  action?: ReactNode
  /** Item count shown beside the title in collapsible mode. */
  count?: number
  collapsed?: boolean
  /** When set, the header becomes a toggle button and `collapsed` hides the children. */
  onToggle?: () => void
  children: ReactNode
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
  const heading = title !== undefined && (
    <SectionLabel>
      {title}
      {count !== undefined && <span className="ml-1.5 normal-case text-faint">· {count}</span>}
    </SectionLabel>
  )
  return (
    <section className="flex flex-col gap-2">
      {/* Row skipped entirely when there is nothing to put in it — rendering an empty one would
          leave the section's `gap-2` above the card as a stray blank line. */}
      {(heading || action) && (
        <div className="flex items-center justify-between gap-2">
          {/* `&& heading`, not `onToggle` alone: the toggle's accessible name is built from the
            title, so without one this would render a button named "Toggle section · undefined".
            Untitled sections are not collapsible — falling through to the (empty) heading is the
            honest outcome. */}
          {onToggle && heading ? (
            <button
              type="button"
              aria-label={`Toggle section · ${title}`}
              aria-expanded={!collapsed}
              onClick={onToggle}
              className="flex items-center gap-1.5 text-left"
            >
              <ChevronDown
                size={12}
                strokeWidth={1.5}
                className={`text-mute transition-transform ${collapsed ? '-rotate-90' : ''}`}
                aria-hidden="true"
              />
              {heading}
            </button>
          ) : (
            heading
          )}
          {action}
        </div>
      )}
      {subtitle && <p className="text-xs text-mute">{subtitle}</p>}
      {!collapsed && (
        <Card className={`flex flex-col divide-y divide-hair ${dynamic ? 'glass-panel' : ''}`}>
          {children}
        </Card>
      )}
    </section>
  )
}

/**
 * Page-level placeholder for a settings page whose payload has not arrived yet (user-directed,
 * 2026-08-08).
 *
 * Replaces the bare `loading…` word that every page printed from its `if (!payload)` branch. A
 * settings page is a stack of cards full of rows, so the honest placeholder is a card full of
 * rows: it reserves roughly the space the content is about to take, which one short grey line
 * never did — every page snapped from a nearly-empty screen to a full one. The rail already uses
 * `SkeletonRows` for exactly this (see `ReposSection`), so this is the same material, not a new
 * one.
 *
 * `role="status"` + `aria-label` carry what the word carried for screen readers: `SkeletonRows`
 * is `aria-hidden`, so without a name here the loading state would be silent.
 */
export function SettingsSkeleton({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" aria-busy="true">
      <SettingsSection>
        <div className="px-4 py-1">
          <SkeletonRows count={rows} />
        </div>
      </SettingsSection>
    </div>
  )
}

/**
 * A row's hover-revealed action column (user-directed, 2026-08-01).
 *
 * **Only opacity changes.** The buttons occupy their space at rest, so crossing a row with the
 * pointer never reflows it: the description column beside them keeps exactly the width it had,
 * instead of being squeezed, wrapping to a second line, and growing the row's height under the
 * cursor. That reflow is what made a long-description row (Subscribed's `hive-log-triage`) jump
 * as the pointer arrived. The `Reveal` this replaced animated `width` from 0, which is precisely
 * the thing that cannot be done without moving everything to its left.
 *
 * **`group-has-[:focus-visible]`, not `group-focus-within`.** A plain focus-within reveal never
 * un-reveals after a mouse click: clicking a row's title button (or any action) leaves focus
 * inside the row, so the buttons stayed lit after the pointer left, on every row the user had
 * touched. `:focus-visible` is not set by a mouse click in Chromium, so keyboard users still get
 * the reveal on Tab and mouse users get it only while hovering.
 */
export function RowActions({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100">
      {children}
    </div>
  )
}

/**
 * The fixed slot a row's toggle sits in — rendered even when there is no toggle, so a row that
 * has one and a row that does not put their actions at the same x. Without it, the Library's
 * reference rows (no toggle) ran their buttons 36px further right than the skill rows above
 * them, and the column read as ragged.
 *
 * `w-9` is `Switch`'s own width; `h-5` keeps an empty slot from collapsing the row's line box.
 */
export function RowToggle({ children }: { children?: ReactNode }): React.JSX.Element {
  return <div className="flex h-5 w-9 shrink-0 items-center">{children}</div>
}

export function SettingRow({
  label,
  description,
  isDefault = true,
  onReset,
  badge,
  hint,
  stacked,
  trailing,
  onOpen,
  children
}: {
  label: string
  description?: ReactNode
  isDefault?: boolean
  onReset?: () => void
  badge?: ReactNode
  /** Tooltip text for the label (title attr) — e.g. explaining a field's purpose. */
  hint?: string
  /** Uncramped variant for rows whose controls need more than a shrink-to-fit column (e.g. a growing path input + Browse button). */
  stacked?: boolean
  /** Rendered at the far right of line 1 (after reset), stacked variant only — e.g. a status chip that shouldn't crowd the control row. */
  trailing?: ReactNode
  /** When set, renders the label as a clickable button with aria-label. */
  onOpen?: () => void
  children: ReactNode
}): React.JSX.Element {
  /**
   * `flex-wrap` is load-bearing, not cosmetic. The label and every badge share one flex line, so
   * without it a badge-heavy row (a shadowing Library skill carries six chips) shrinks EVERY item
   * to min-content at once the moment they stop fitting — measured at a 900px window: the name
   * `triage-a-flaky-test` collapsed to 44px and broke mid-word across four lines, while the line
   * still overflowed its column by 170px, clipping the trailing chips. Wrapping lets the badges
   * fall to a second line and leaves the name at its natural width. See
   * `scripts/library-layout-probe.mjs`, which measures this against the real renderer (jsdom
   * loads no stylesheet, so no vitest assertion can see it).
   */
  const labelClass = `flex flex-wrap items-center gap-2 text-sm text-ink${hint ? ' cursor-help underline decoration-dotted decoration-mute underline-offset-2' : ''}`
  const labelContent = onOpen ? (
    <>
      <button
        type="button"
        aria-label={`open · ${label}`}
        onClick={onOpen}
        className="cursor-pointer text-left hover:underline hover:underline-offset-2"
      >
        {label}
      </button>
      {badge}
    </>
  ) : (
    <>
      {label}
      {badge}
    </>
  )
  if (stacked) {
    return (
      <div className="group/row flex flex-col gap-0.5 px-4 py-3">
        <div className="flex items-center gap-4">
          <span className={`min-w-0 flex-1 ${labelClass}`} title={hint}>
            {labelContent}
          </span>
          {!isDefault && onReset && (
            <IconBtn aria-label={`Reset ${label}`} title="Reset to default" onClick={onReset}>
              <Eraser size={13} />
            </IconBtn>
          )}
          {trailing}
        </div>
        {description && <span className="text-xs text-mute">{description}</span>}
        <div className="flex flex-wrap items-center gap-2 pt-2">{children}</div>
      </div>
    )
  }
  return (
    <div className="group/row flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={labelClass} title={hint}>
          {labelContent}
        </span>
        {/* Capped at two lines: a HiveMind skill's description is free prose from its
            frontmatter and has no length bound, so one long one otherwise made its row twice
            the height of every neighbour. Two lines is what the longest description in the
            shipped set already occupies, so nothing in practice is truncated today — the clamp
            is the bound, not a trim. */}
        {description && <span className="line-clamp-2 text-xs text-mute">{description}</span>}
      </div>
      {!isDefault && onReset && (
        <IconBtn aria-label={`Reset ${label}`} title="Reset to default" onClick={onReset}>
          <Eraser size={13} />
        </IconBtn>
      )}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onChange: (v: boolean) => void
  'aria-label': string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`h-5 w-9 rounded-full border transition-colors ${
        checked ? 'border-signal/40 bg-signal/30' : 'border-hair2 bg-hair'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full bg-ink transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}

interface DraftFieldProps {
  value: string
  onCommit: (v: string) => void
  'aria-label': string
  className?: string
  placeholder?: string
}

/**
 * Local-draft text input: typing only updates local state, so the store
 * patch (and the disk write it triggers) fires once on blur/Enter instead of
 * per keystroke. Resyncs from the `value` prop when not focused — the same
 * adjust-state-during-render idiom Composer uses for its `prefill` prop —
 * so external changes (reset buttons, another window) still show up.
 */
export function DraftInput({
  value,
  onCommit,
  'aria-label': ariaLabel,
  className,
  placeholder,
  type
}: DraftFieldProps & { type?: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  const [focused, setFocused] = useState(false)
  if (value !== lastValue) {
    setLastValue(value)
    if (!focused) setDraft(value)
  }
  return (
    <input
      type={type ?? 'text'}
      aria-label={ariaLabel}
      className={className}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (draft === value) return
        onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (draft === value) return
          onCommit(draft)
        } else if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** Textarea counterpart of {@link DraftInput}: commits on blur only (no Enter commit — newlines are valid input). */
export function DraftTextarea({
  value,
  onCommit,
  'aria-label': ariaLabel,
  className,
  placeholder
}: DraftFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  const [focused, setFocused] = useState(false)
  if (value !== lastValue) {
    setLastValue(value)
    if (!focused) setDraft(value)
  }
  return (
    <textarea
      rows={3}
      aria-label={ariaLabel}
      className={className ?? TEXTAREA_FIELD}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (draft === value) return
        onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * The settings dropdown (user-directed, 2026-08-01).
 *
 * A button + an `.overlay-menu` popup, **not** a native `<select>`. The OS-drawn select popup is
 * the one surface in the app Argus does not paint: it renders in the platform's own chrome, with
 * the platform's own highlight colour and frame, and Electron gives it a fixed height that
 * clipped the longer lists (the model picker) to a partial, scrolling stub. Fourteen settings
 * controls read as a foreign widget dropped into the page. This is the same popup material and
 * geometry `MenuButton` already uses, so every dropdown in the app is now one thing.
 *
 * `role="combobox"` on the trigger, `role="listbox"`/`role="option"` on the panel: the
 * select-only combobox pattern (WAI-ARIA 1.2). That keeps the control addressable exactly as the
 * native one was — `getByRole('combobox', { name })` and `getByLabelText(name)` both still find
 * the trigger.
 */
export function SelectField({
  value,
  options,
  onChange,
  disabled,
  'aria-label': ariaLabel
}: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  /** Greys the control out — e.g. a setting whose prerequisites aren't configured. */
  disabled?: boolean
  'aria-label': string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** Flip above the trigger when there is no room below — same guard as `MenuButton`'s. */
  const [openUp, setOpenUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  /**
   * Escape is claimed by a real layer while the popup is open, rather than by `blurOnEscape`.
   *
   * The native `<select>` this replaced was a *field*, and `escapeLayer`'s dispatcher skips
   * fields on purpose — which is why it needed `blurOnEscape` to hand the key back. A button is
   * not a field, so with no layer here the first Escape would sail past the open popup and close
   * the whole Settings view behind it. Pushed only while open, so Escape on a closed trigger
   * still falls through to whatever owns the view — which is what a button should do.
   */
  useEffect(() => {
    if (!open) return
    return pushEscapeLayer({ onEscape: () => setOpen(false) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        // `max-w-72` bounds the trigger: a model slug is long, and an unbounded button would
        // push the row's label to min-content the way the badge row does without `flex-wrap`.
        className={`${FIELD} inline-flex max-w-72 items-center justify-between gap-2`}
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect()
          setOpenUp(Boolean(rect && window.innerHeight - rect.bottom < 220 && rect.top > 220))
          setOpen((o) => !o)
        }}
      >
        <span className="truncate">{value}</span>
        <ChevronDown
          size={12}
          strokeWidth={1.5}
          className="shrink-0 text-mute"
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          // `max-h-72` + scroll rather than the OS's own arbitrary cap: a long list stays a
          // list, and it scrolls inside the popup instead of being cut off by it.
          className={`absolute right-0 z-30 max-h-72 min-w-full overflow-y-auto rounded-r2 overlay-menu p-1 ${
            openUp ? 'bottom-full mb-1' : 'mt-1'
          }`}
        >
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={o === value}
              className={`block w-full whitespace-nowrap rounded-r1 px-2 py-1 text-left text-xs transition-colors hover:bg-hair/50 ${
                o === value ? 'text-ink' : 'text-dim'
              }`}
              onClick={() => {
                setOpen(false)
                if (o !== value) onChange(o)
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
