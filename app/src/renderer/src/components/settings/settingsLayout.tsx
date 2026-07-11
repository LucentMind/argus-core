import { useState, type ReactNode } from 'react'
import { Eraser } from 'lucide-react'
import { Card, IconBtn, SectionLabel } from '../ui'

export const FIELD =
  'h-7 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink placeholder:text-mute transition-colors focus:border-hair2 focus:outline-none'

export function SettingsSection({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{title}</SectionLabel>
      <Card className="flex flex-col divide-y divide-hair">{children}</Card>
    </section>
  )
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
  children
}: {
  label: string
  description?: string
  isDefault?: boolean
  onReset?: () => void
  badge?: ReactNode
  /** Tooltip text for the label (title attr) — e.g. explaining a field's purpose. */
  hint?: string
  /** Uncramped variant for rows whose controls need more than a shrink-to-fit column (e.g. a growing path input + Browse button). */
  stacked?: boolean
  /** Rendered at the far right of line 1 (after reset), stacked variant only — e.g. a status chip that shouldn't crowd the control row. */
  trailing?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const labelClass = `flex items-center gap-2 text-sm text-ink${hint ? ' cursor-help underline decoration-dotted decoration-mute underline-offset-2' : ''}`
  if (stacked) {
    return (
      <div className="flex flex-col gap-0.5 px-4 py-3">
        <div className="flex items-center gap-4">
          <span className={`min-w-0 flex-1 ${labelClass}`} title={hint}>
            {label}
            {badge}
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
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={labelClass} title={hint}>
          {label}
          {badge}
        </span>
        {description && <span className="text-xs text-mute">{description}</span>}
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
        if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function SelectField({
  value,
  options,
  onChange,
  'aria-label': ariaLabel
}: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  'aria-label': string
}): React.JSX.Element {
  return (
    <select
      aria-label={ariaLabel}
      className={FIELD}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}
