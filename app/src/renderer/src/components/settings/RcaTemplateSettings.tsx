import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, Pencil } from 'lucide-react'
import { Btn, Chip, IconBtn } from '../ui'
import { DisclosureBtn, RowActions } from './settingsLayout'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
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

/**
 * What the `auto` chip means, per slot — the tooltip a user gets when they ask why a row has no
 * instruction to edit. Keyed by slot rather than written once, because "where does this content
 * come from" is a different answer for each of them.
 */
const SLOT_SOURCE: Record<string, string> = {
  'root-cause': 'the findings marked as root cause',
  contributing: 'the findings marked as contributing factors',
  symptoms: 'the findings marked as symptoms, and their timeline',
  'ruled-out': 'the findings marked as ruled out',
  timeline: 'the case timeline',
  remediation: 'the findings marked as remediation',
  'tech-narrative': "the model's technical write-up, which brings its own headings"
}

/**
 * The one section that writes its own `## ` headings (`render.ts`'s `isSelfHeading`), and
 * therefore ships with an empty `heading` on purpose.
 *
 * It needs saying out loud here: rendered as an ordinary heading input it was a blank line with
 * an editable field that changes nothing, which reads as a bug rather than as a design. This row
 * gets a static label instead.
 */
function isSelfHeading(s: RcaSection): boolean {
  return s.kind === 'claims' && s.slot === 'tech-narrative'
}

/** The name every control in a row is addressed by. A section with no heading — the
 *  self-heading one ships that way — would otherwise give its checkbox and its move buttons
 *  accessible names like "Enable  in the technical report": a name that says nothing, and
 *  that collides with any other nameless row. */
const rowName = (s: RcaSection): string =>
  s.heading.trim() || (isSelfHeading(s) ? 'Analysis narrative' : 'Untitled section')

/** A new section's starting instruction. The exec text carries the non-technical prohibition
 *  because `RCA_CONTRACT` rule 6 enforces it whatever the instruction says — a new exec section
 *  should read the way the rule already behaves rather than inviting the user to write something
 *  the model will refuse. */
const NEW_INSTRUCTION: Record<ReportKey, string> = {
  exec: 'Describe what the model should write here, for a non-technical reader: no file paths, no code, no finding ids.',
  tech: 'Describe what the model should write here.'
}

/**
 * The RCA template editor, as one collapsed row inside the RCA report section (user-directed,
 * 2026-08-21).
 *
 * It used to render both reports open, every section as a bordered card, and every narrative
 * section's instruction as an always-visible textarea — nine textareas on the default template,
 * which made the settings page it lived on scroll for two screens before reaching its next row.
 * Three nested disclosures replace that: the template as a whole, then one report at a time,
 * then the instruction of the ONE section being edited. Everything else is a single line —
 * enabled checkbox, heading, and hover-revealed actions.
 */
export function RcaTemplateSettings({ template }: { template: RcaTemplate }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  /** The whole editor, shut by default. */
  const [openTemplate, setOpenTemplate] = useState(false)
  /** At most one report expanded — they are alternatives (write the exec summary, or the
   *  technical report), and two open lists is the wall this rework exists to remove. */
  const [openReport, setOpenReport] = useState<ReportKey | null>('exec')
  /** Section id whose instruction textarea is open, if any. */
  const [editingId, setEditingId] = useState<string | null>(null)
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
      // Open the offending row: with instructions hidden by default, an error naming a section
      // the user cannot see is an error they cannot act on.
      setEditingId(blank.id)
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
    const id = freshId(current.current, report)
    replace(report, [
      ...current.current[report],
      {
        id,
        heading: 'New section',
        kind: 'narrative',
        enabled: true,
        instruction: NEW_INSTRUCTION[report]
      }
    ])
    // A new section's whole point is its instruction, and it is the one row whose default text
    // is a placeholder — so it opens on creation rather than waiting for a second click.
    setOpenReport(report)
    setEditingId(id)
  }

  function remove(report: ReportKey, id: string): void {
    if (editingId === id) setEditingId(null)
    replace(
      report,
      current.current[report].filter((s) => s.id !== id)
    )
  }

  function renderList(report: ReportKey): React.JSX.Element {
    const label = REPORT_LABEL[report]
    const sections = draft[report]
    const on = sections.filter((s) => s.enabled).length
    const open = openReport === report
    return (
      <div className="overflow-hidden rounded-r2 border border-hair">
        {/* The header is the collapse toggle AND the summary line, so a shut report still says
            how many sections it has and how many are switched on. */}
        <div className="flex items-center gap-2 bg-hair/30 px-2 py-1.5">
          <button
            type="button"
            aria-label={`Toggle the ${label}`}
            aria-expanded={open}
            onClick={() => setOpenReport(open ? null : report)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronDown
              size={13}
              strokeWidth={1.5}
              className={`shrink-0 text-mute transition-transform ${open ? '' : '-rotate-90'}`}
              aria-hidden="true"
            />
            <span className="shrink-0 text-xs text-ink">
              {label[0].toUpperCase()}
              {label.slice(1)}
            </span>
            <span className="truncate text-[11px] text-mute">
              {sections.length} section{sections.length === 1 ? '' : 's'} ·{' '}
              {on === sections.length ? 'all on' : `${on} on`}
            </span>
          </button>
          <Btn aria-label={`Add a section to the ${label}`} onClick={() => add(report)}>
            <Plus size={12} strokeWidth={1.5} />
            Section
          </Btn>
        </div>
        {open && (
          <ul aria-label={`${label} sections`} className="flex flex-col gap-0.5 p-1.5">
            {sections.map((s, i) => {
              const editing = editingId === s.id
              return (
                <li
                  key={s.id}
                  className="group/row rounded-r2 border border-transparent hover:border-hair hover:bg-hair/30"
                >
                  <div className="flex items-center gap-2 px-1.5 py-1">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${rowName(s)} in the ${label}`}
                      checked={s.enabled}
                      onChange={() => update(report, s.id, { enabled: !s.enabled })}
                    />
                    {isSelfHeading(s) ? (
                      <span
                        className={`min-w-0 flex-1 px-1.5 py-0.5 text-xs italic ${
                          s.enabled ? 'text-dim' : 'text-faint'
                        }`}
                        title="This section supplies its own headings, so it has no name of its own."
                      >
                        Analysis narrative — writes its own headings
                      </span>
                    ) : (
                      <input
                        aria-label={`Heading for ${rowName(s)} in the ${label}`}
                        value={s.heading}
                        placeholder="Untitled section"
                        onChange={(e) => editLocal(report, s.id, { heading: e.target.value })}
                        onBlur={(e) => commitField(report, s.id, { heading: e.target.value })}
                        onKeyDown={blurOnEscape}
                        // Borderless until hovered or focused: a column of boxed inputs reads as a
                        // form waiting to be filled in, when every one of them is already correct.
                        className={`min-w-0 flex-1 rounded-r1 border border-transparent bg-transparent px-1.5 py-0.5 text-xs transition-colors placeholder:text-faint hover:border-hair focus:border-hair2 focus:bg-well focus:outline-none ${
                          s.enabled ? 'text-ink' : 'text-faint'
                        }`}
                      />
                    )}
                    {/* A claims section's content comes from the findings, so there is no
                        instruction to open. One chip says that where the old editor spent a
                        two-line paragraph per row saying it — and its tooltip names the source,
                        which is the question the chip alone provokes. */}
                    {s.kind === 'claims' && (
                      <Chip
                        tone="neutral"
                        title={`Written from ${SLOT_SOURCE[s.slot ?? ''] ?? 'the findings'} — rename it, reorder it or switch it off, but there is no instruction to give.`}
                      >
                        auto
                      </Chip>
                    )}
                    <RowActions>
                      <IconBtn
                        size="xs"
                        aria-label={`Move ${rowName(s)} up in the ${label}`}
                        title="Move up"
                        disabled={i === 0}
                        onClick={() => move(report, i, -1)}
                      >
                        <ChevronUp size={13} strokeWidth={1.5} />
                      </IconBtn>
                      <IconBtn
                        size="xs"
                        aria-label={`Move ${rowName(s)} down in the ${label}`}
                        title="Move down"
                        disabled={i === sections.length - 1}
                        onClick={() => move(report, i, 1)}
                      >
                        <ChevronDown size={13} strokeWidth={1.5} />
                      </IconBtn>
                      {s.kind === 'narrative' && (
                        <>
                          <IconBtn
                            size="xs"
                            aria-label={`${editing ? 'Hide' : 'Edit'} the instruction for ${rowName(s)} in the ${label}`}
                            aria-expanded={editing}
                            title={editing ? 'Hide instruction' : 'Edit instruction'}
                            onClick={() => setEditingId(editing ? null : s.id)}
                          >
                            <Pencil size={13} strokeWidth={1.5} />
                          </IconBtn>
                          <IconBtn
                            size="xs"
                            aria-label={`Remove ${rowName(s)} from the ${label}`}
                            title="Remove section"
                            className="hover:text-danger"
                            onClick={() => remove(report, s.id)}
                          >
                            <Trash2 size={13} strokeWidth={1.5} />
                          </IconBtn>
                        </>
                      )}
                    </RowActions>
                  </div>
                  {editing && s.kind === 'narrative' && (
                    <div className="pb-1.5 pl-7 pr-1.5">
                      <textarea
                        aria-label={`Instruction for ${rowName(s)} in the ${label}`}
                        value={s.instruction ?? ''}
                        rows={3}
                        onChange={(e) => editLocal(report, s.id, { instruction: e.target.value })}
                        onBlur={(e) => commitField(report, s.id, { instruction: e.target.value })}
                        onKeyDown={blurOnEscape}
                        className="w-full resize-y rounded-r1 border border-hair bg-well p-1.5 text-[11px] leading-relaxed text-ink focus:border-hair2 focus:outline-none"
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  return (
    // A bare row, not a `SettingRow`: the disclosed content sits BELOW the row at full width,
    // which SettingRow has no slot for — same shape as General's Default repositories row.
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
            Report template
            <Chip tone="neutral">
              {draft.exec.length} + {draft.tech.length} sections
            </Chip>
          </span>
          <span className="text-xs text-mute">
            The sections each report is built from. Changes apply to reports generated from now on —
            a draft already generated keeps the template it was generated under.
          </span>
        </div>
        <DisclosureBtn
          expanded={openTemplate}
          onToggle={() => setOpenTemplate((o) => !o)}
          label="report template"
        />
      </div>
      {/* Outside the `openTemplate` branch: a save can fail while the user is collapsing the
          editor, and an invisible error is an error that never gets fixed. */}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {openTemplate && (
        <div className="flex flex-col gap-2">
          {renderList('exec')}
          {renderList('tech')}
          {/* Bottom-right, under what it resets — and behind a confirm. It used to be the first
              control on the section's opening line, which made the one irreversible action here
              also the most prominent. */}
          <div className="flex justify-end">
            <Btn
              variant="ghost"
              onClick={() => {
                void confirm({
                  title: 'Reset the RCA template?',
                  message:
                    'Both reports go back to their default sections and instructions. Any section you added or reworded is lost. Reports already generated keep the template they were generated under.',
                  confirmLabel: 'Reset',
                  danger: true
                }).then((ok) => {
                  if (ok) void save(structuredClone(DEFAULT_RCA_TEMPLATE))
                })
              }}
            >
              Reset template to defaults
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}
