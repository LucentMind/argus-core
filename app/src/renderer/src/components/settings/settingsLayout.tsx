import type { ReactNode } from 'react'
import { Card, SectionLabel } from '../ui'

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
  children
}: {
  label: string
  description?: string
  isDefault?: boolean
  onReset?: () => void
  badge?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm text-ink">
          {label}
          {badge}
        </span>
        {description && <span className="text-xs text-mute">{description}</span>}
      </div>
      {!isDefault && onReset && (
        <button
          aria-label={`Reset ${label}`}
          className="text-xs text-mute transition-colors hover:text-ink"
          onClick={onReset}
        >
          reset
        </button>
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
