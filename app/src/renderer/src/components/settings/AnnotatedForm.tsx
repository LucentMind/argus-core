import { useState } from 'react'
import type { FieldAnnotation } from '../../../../shared/drivers'
import { isSecretRef } from '../../../../shared/connectors'
import { FIELD, SettingRow, SelectField, Switch, DraftInput, DraftTextarea } from './settingsLayout'

/**
 * Password input for `sensitive` fields. Unlike DraftInput it never mirrors a
 * stored value: the draft starts empty and is cleared synchronously on commit
 * (blur/Enter) and on Escape, so committed plaintext never lingers in
 * renderer state or the DOM — only the placeholder signals set/not-set.
 */
function SecretInput({
  placeholder,
  onCommit,
  'aria-label': ariaLabel
}: {
  placeholder: string
  onCommit: (plaintext: string) => void
  'aria-label': string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    if (draft) onCommit(draft)
    setDraft('')
  }
  return (
    <input
      type="password"
      aria-label={ariaLabel}
      className={FIELD}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') {
          setDraft('')
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * Generic settings form rendered from a driver's field annotations
 * (t3code schema-annotation pattern). Empty text/number → onChange(key, null)
 * so the caller can delete the key (defaults refill).
 */
export function AnnotatedForm({
  annotations,
  value,
  onChange,
  onSecret,
  badges
}: {
  annotations: Record<string, FieldAnnotation>
  value: Record<string, unknown>
  onChange: (key: string, v: unknown | null) => void
  /** Required to render `sensitive` fields; they commit plaintext here, never through onChange. */
  onSecret?: (key: string, plaintext: string | null) => void
  /** Extra node rendered beside a field's label (e.g. a "Create API token" link), keyed by annotation key. */
  badges?: Record<string, React.ReactNode>
}): React.JSX.Element {
  const fields = Object.entries(annotations).sort((a, b) => a[1].order - b[1].order)
  return (
    <>
      {fields.map(([key, a]) => {
        if (a.sensitive && onSecret) {
          const isSet = isSecretRef(value[key])
          return (
            <SettingRow
              key={key}
              label={a.label}
              isDefault={!isSet}
              onReset={() => onSecret(key, null)}
              hint={a.help}
              badge={badges?.[key]}
            >
              <SecretInput
                placeholder={isSet ? '•••• (set)' : (a.placeholder ?? '(not set)')}
                onCommit={(v) => onSecret(key, v)}
                aria-label={a.label}
              />
            </SettingRow>
          )
        }
        return (
          <SettingRow
            key={key}
            label={a.label}
            isDefault={value[key] == null || value[key] === '' || value[key] === a.defaultValue}
            onReset={() => onChange(key, null)}
            hint={a.help}
            badge={badges?.[key]}
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
                onChange={(e) =>
                  onChange(key, e.target.value === '' ? null : Number(e.target.value))
                }
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
        )
      })}
    </>
  )
}
