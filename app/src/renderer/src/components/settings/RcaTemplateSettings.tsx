import { useEffect, useRef, useState } from 'react'
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

/** One section changed, both lists returned whole. */
function withEdit(
  t: RcaTemplate,
  report: ReportKey,
  id: string,
  patch: Partial<RcaSection>
): RcaTemplate {
  return { ...t, [report]: t[report].map((s) => (s.id === id ? { ...s, ...patch } : s)) }
}

/** A new section's starting instruction. The exec text carries the non-technical prohibition
 *  because `RCA_CONTRACT` rule 6 enforces it whatever the instruction says — a new exec section
 *  should read the way the rule already behaves rather than inviting the user to write something
 *  the model will refuse. */
const NEW_INSTRUCTION: Record<ReportKey, string> = {
  exec: 'Describe what the model should write here, for a non-technical reader: no file paths, no code, no finding ids.',
  tech: 'Describe what the model should write here.'
}

export function RcaTemplateSettings({ template }: { template: RcaTemplate }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  /**
   * The edit-in-progress template. `settingsStore.patch` is async with no optimistic update, so
   * the `template` prop only refreshes once main has round-tripped and written settings.json.
   * Composing each payload from the prop meant a second edit inside that window rebuilt from
   * pre-first-edit state, and since `deepMerge` replaces arrays wholesale the later stale write
   * won on disk — two quick "Add section" clicks minted the same id and lost a section.
   */
  const [draft, setDraft] = useState<RcaTemplate>(template)
  /**
   * The authoritative copy, and what every handler computes from. `draft` state exists only to
   * render. React state does not update until the next render, so two handlers firing in ONE
   * tick — a double-clicked "Add section", or a value-set immediately followed by blur — would
   * both read the pre-first-edit value and the second would overwrite the first with identical
   * content. A ref assigned synchronously in `save`/`editLocal` is visible to the very next
   * handler in the same tick, which state is not.
   */
  const current = useRef<RcaTemplate>(template)
  /** Patches we have sent but not yet seen echoed back. While any are outstanding the prop is
   *  behind local state, so adopting it would undo the very edits still in flight. */
  const inflight = useRef(0)

  useEffect(() => {
    if (inflight.current !== 0) return
    current.current = template
    setDraft(template)
  }, [template])

  /** Commit both representations at once: the ref for the next handler, state for the next paint. */
  function land(next: RcaTemplate): void {
    current.current = next
    setDraft(next)
  }

  /** Always sends BOTH lists. `settings.rca` is an atomic path for `stripDefaults`, so the
   *  template is persisted whole-or-absent: a patch carrying one list would drop the other. */
  async function save(next: RcaTemplate): Promise<void> {
    // The schema rejects a narrative section with a blank instruction, and a rejected parse
    // round-trips into `loadError`. Guard here rather than at the one field that can blank it:
    // local state means a LATER unrelated edit would otherwise carry the blank along.
    const blank = [...next.exec, ...next.tech].find(
      (s) => s.kind === 'narrative' && !(s.instruction ?? '').trim()
    )
    if (blank) {
      setError(
        `"${blank.heading || blank.id}" needs an instruction — it tells the model what to write there.`
      )
      return
    }
    setError(null)
    land(next)
    inflight.current++
    try {
      await settingsStore.patch({ rca: { template: next } })
    } finally {
      inflight.current--
    }
  }

  /** Keystroke-level edit: local only, so typing never round-trips. Committed on blur. */
  function editLocal(report: ReportKey, id: string, patch: Partial<RcaSection>): void {
    land(withEdit(current.current, report, id, patch))
  }

  /** Commit whatever the field now holds, applied on top of the latest known template. Taking
   *  the value from the DOM rather than from state keeps this correct even when no re-render
   *  has happened between the last keystroke and the blur. */
  function commitField(report: ReportKey, id: string, patch: Partial<RcaSection>): void {
    void save(withEdit(current.current, report, id, patch))
  }

  function replace(report: ReportKey, sections: RcaSection[]): void {
    void save({ ...current.current, [report]: sections })
  }

  function update(report: ReportKey, id: string, patch: Partial<RcaSection>): void {
    void save(withEdit(current.current, report, id, patch))
  }

  function move(report: ReportKey, index: number, delta: number): void {
    const next = [...current.current[report]]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    replace(report, next)
  }

  function add(report: ReportKey): void {
    replace(report, [
      ...current.current[report],
      {
        id: freshId(current.current, report),
        heading: 'New section',
        kind: 'narrative',
        enabled: true,
        instruction: NEW_INSTRUCTION[report]
      }
    ])
  }

  function remove(report: ReportKey, id: string): void {
    replace(
      report,
      current.current[report].filter((s) => s.id !== id)
    )
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
          {draft[report].map((s, i) => (
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
                  value={s.heading}
                  onChange={(e) => editLocal(report, s.id, { heading: e.target.value })}
                  onBlur={(e) => commitField(report, s.id, { heading: e.target.value })}
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
                  disabled={i === draft[report].length - 1}
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
                  value={s.instruction ?? ''}
                  rows={2}
                  onChange={(e) => editLocal(report, s.id, { instruction: e.target.value })}
                  onBlur={(e) => commitField(report, s.id, { instruction: e.target.value })}
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
        <Btn onClick={() => void save(structuredClone(DEFAULT_RCA_TEMPLATE))}>
          Reset to defaults
        </Btn>
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
