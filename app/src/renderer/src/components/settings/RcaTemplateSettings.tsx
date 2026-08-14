import { useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { Btn } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
import { blurOnEscape } from '../../lib/escapeLayer'
import { DEFAULT_RCA_TEMPLATE } from '../../../../shared/rcaTemplate'
import type { RcaSection, RcaTemplate } from '../../../../shared/rcaTemplate'

type ReportKey = 'exec' | 'tech'

/** Every control's accessible name ends in one of these. Headings are NOT unique — the default
 *  template has a "Root cause" in each report — so a name built from the heading alone would
 *  address two different controls. Ids are unique but are internal plumbing a user never sees,
 *  so the report is what disambiguates. */
const REPORT_LABEL: Record<ReportKey, string> = {
  exec: 'executive summary',
  tech: 'technical report'
}

/** A section id must be unique across BOTH reports — the model returns one flat `sections`
 *  record keyed by id and `narrativeBody` resolves from the id alone, so a duplicate would make
 *  two sections that need different text collide on one key. */
function freshId(template: RcaTemplate, report: ReportKey): string {
  const taken = new Set([...template.exec, ...template.tech].map((s) => s.id))
  for (let n = 1; ; n++) {
    const id = `${report}-section-${n}`
    if (!taken.has(id)) return id
  }
}

export function RcaTemplateSettings({ template }: { template: RcaTemplate }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  /** Always sends BOTH lists. `settings.rca` is an atomic path for `stripDefaults`, so the
   *  template is persisted whole-or-absent: a patch carrying one list would drop the other. */
  function save(next: RcaTemplate): void {
    setError(null)
    void settingsStore.patch({ rca: { template: next } })
  }

  function replace(report: ReportKey, sections: RcaSection[]): void {
    save({ ...template, [report]: sections })
  }

  function update(report: ReportKey, id: string, patch: Partial<RcaSection>): void {
    replace(
      report,
      template[report].map((s) => (s.id === id ? { ...s, ...patch } : s))
    )
  }

  function move(report: ReportKey, index: number, delta: number): void {
    const next = [...template[report]]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    replace(report, next)
  }

  function add(report: ReportKey): void {
    replace(report, [
      ...template[report],
      {
        id: freshId(template, report),
        heading: 'New section',
        kind: 'narrative',
        enabled: true,
        instruction: 'Describe what the model should write here.'
      }
    ])
  }

  function remove(report: ReportKey, id: string): void {
    replace(
      report,
      template[report].filter((s) => s.id !== id)
    )
  }

  /** The settings schema rejects a narrative section with a blank instruction, so saving one
   *  would round-trip into `loadError` and leave the field looking accepted. Block it here and
   *  say why instead. */
  function commitInstruction(report: ReportKey, s: RcaSection, value: string): void {
    if (!value.trim()) {
      setError(`"${s.heading}" needs an instruction — it tells the model what to write there.`)
      return
    }
    update(report, s.id, { instruction: value })
  }

  function renderList(report: ReportKey): React.JSX.Element {
    const label = REPORT_LABEL[report]
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10.5px] font-medium uppercase tracking-wide text-mute">{label}</h3>
          <Btn aria-label={`Add a section to the ${label}`} onClick={() => add(report)}>
            <Plus size={12} strokeWidth={1.5} />
            Add section
          </Btn>
        </div>
        <ul aria-label={`${label} sections`} className="flex flex-col gap-1.5">
          {template[report].map((s, i) => (
            <li key={s.id} className="flex flex-col gap-1 rounded-r2 border border-hair p-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Enable ${s.heading} in the ${label}`}
                  checked={s.enabled}
                  onChange={() => update(report, s.id, { enabled: !s.enabled })}
                />
                <input
                  aria-label={`Heading for ${s.heading} in the ${label}`}
                  defaultValue={s.heading}
                  onBlur={(e) => update(report, s.id, { heading: e.target.value })}
                  onKeyDown={blurOnEscape}
                  className="min-w-0 flex-1 rounded-r1 border border-hair bg-overlay px-1.5 py-0.5 text-xs text-ink"
                />
                <button
                  type="button"
                  aria-label={`Move ${s.heading} up in the ${label}`}
                  disabled={i === 0}
                  onClick={() => move(report, i, -1)}
                  className="text-mute hover:text-ink disabled:opacity-40"
                >
                  <ChevronUp size={14} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${s.heading} down in the ${label}`}
                  disabled={i === template[report].length - 1}
                  onClick={() => move(report, i, 1)}
                  className="text-mute hover:text-ink disabled:opacity-40"
                >
                  <ChevronDown size={14} strokeWidth={1.5} />
                </button>
                {s.kind === 'narrative' && (
                  <button
                    type="button"
                    aria-label={`Remove ${s.heading} from the ${label}`}
                    onClick={() => remove(report, s.id)}
                    className="text-mute hover:text-danger"
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                )}
              </div>
              {s.kind === 'narrative' ? (
                <textarea
                  aria-label={`Instruction for ${s.heading} in the ${label}`}
                  defaultValue={s.instruction ?? ''}
                  rows={2}
                  onBlur={(e) => commitInstruction(report, s, e.target.value)}
                  onKeyDown={blurOnEscape}
                  className="rounded-r1 border border-hair bg-overlay px-1.5 py-1 text-[11px] text-ink"
                />
              ) : (
                <p className="text-[11px] text-mute">
                  Renders the report&apos;s {s.slot} structure. Reorder, rename, or switch it off —
                  its content comes from the findings, not from an instruction.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-mute">
          The sections each report is built from. Changes apply to reports generated from now on — a
          draft already generated keeps the template it was generated under.
        </p>
        <Btn onClick={() => save(structuredClone(DEFAULT_RCA_TEMPLATE))}>Reset to defaults</Btn>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {renderList('exec')}
      {renderList('tech')}
    </div>
  )
}
