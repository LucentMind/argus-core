import type { FieldAnnotation } from '../../../../shared/drivers'
import { FIELD, SettingRow, SelectField, Switch, DraftInput, DraftTextarea } from './settingsLayout'

/**
 * Generic settings form rendered from a driver's field annotations
 * (t3code schema-annotation pattern). Empty text/number → onChange(key, null)
 * so the caller can delete the key (defaults refill).
 */
export function AnnotatedForm({
  annotations,
  value,
  onChange
}: {
  annotations: Record<string, FieldAnnotation>
  value: Record<string, unknown>
  onChange: (key: string, v: unknown | null) => void
}): React.JSX.Element {
  const fields = Object.entries(annotations).sort((a, b) => a[1].order - b[1].order)
  return (
    <>
      {fields.map(([key, a]) => (
        <SettingRow
          key={key}
          label={a.label}
          isDefault={value[key] == null || value[key] === '' || value[key] === a.defaultValue}
          onReset={() => onChange(key, null)}
        >
          {a.control === 'switch' ? (
            <Switch
              checked={Boolean(value[key])}
              onChange={(v) => onChange(key, v)}
              aria-label={a.label}
            />
          ) : a.control === 'select' ? (
            <SelectField
              aria-label={a.label}
              value={String(value[key] ?? '')}
              options={a.options ?? []}
              onChange={(v) => onChange(key, v)}
            />
          ) : a.control === 'number' ? (
            <input
              type="number"
              aria-label={a.label}
              className={`${FIELD} w-24`}
              value={value[key] == null ? '' : String(value[key])}
              onChange={(e) => onChange(key, e.target.value === '' ? null : Number(e.target.value))}
            />
          ) : a.control === 'textarea' ? (
            <DraftTextarea
              aria-label={a.label}
              className="w-72 rounded-r2 border border-hair bg-overlay p-2 font-mono text-xs text-ink placeholder:text-mute focus:border-hair2 focus:outline-none"
              placeholder={a.placeholder}
              value={String(value[key] ?? '')}
              onCommit={(v) => onChange(key, v === '' ? null : v)}
            />
          ) : (
            <DraftInput
              type={a.control === 'password' ? 'password' : 'text'}
              aria-label={a.label}
              className={`${FIELD} w-56 font-mono`}
              placeholder={a.placeholder}
              value={String(value[key] ?? '')}
              onCommit={(v) => onChange(key, v === '' ? null : v)}
            />
          )}
        </SettingRow>
      ))}
    </>
  )
}
