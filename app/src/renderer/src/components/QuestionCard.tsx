import { useState } from 'react'
import { Chip, Btn, SectionLabel } from './ui'
import type { PendingDialog } from '../lib/agentStore'

/**
 * The AskUserQuestion "Question" card — a sibling of ApprovalCard (different data shape and
 * buttons). Each question shows its header + prompt and selectable options; single-select by
 * default, checkbox-style when multiSelect. A per-question free-text field maps to that
 * question's answer value (the implicit "Other"). Submit is disabled until every question has
 * an answer (a picked option or free text).
 */
export function QuestionCard({
  slug,
  sessionId,
  dialog
}: {
  slug: string
  sessionId: number
  dialog: PendingDialog
}): React.JSX.Element {
  const [picked, setPicked] = useState<Record<number, Set<number>>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, oi: number, multi: boolean): void =>
    setPicked((prev) => {
      const next = { ...prev }
      const cur = new Set(next[qi] ?? [])
      if (multi) {
        cur.has(oi) ? cur.delete(oi) : cur.add(oi)
      } else {
        cur.clear()
        cur.add(oi)
      }
      next[qi] = cur
      return next
    })

  // A question's answer: picked option labels (comma-joined), plus free text appended; free
  // text alone is a valid answer.
  const answerFor = (qi: number): string => {
    const q = dialog.questions[qi]
    const labels = [...(picked[qi] ?? [])].sort((a, b) => a - b).map((oi) => q.options[oi].label)
    const free = (other[qi] ?? '').trim()
    if (labels.length) return free ? `${labels.join(', ')}, ${free}` : labels.join(', ')
    return free
  }
  const allAnswered = dialog.questions.every((_, qi) => answerFor(qi).length > 0)

  const submit = (): void => {
    const answers: Record<string, string> = {}
    dialog.questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi)
    })
    const response = dialog.questions
      .map((_, qi) => (other[qi] ?? '').trim())
      .find((t) => t.length > 0)
    void window.argus.agent.answerDialog(slug, sessionId, {
      dialogId: dialog.dialogId,
      behavior: 'completed',
      result: { answers, ...(response ? { response } : {}) }
    })
  }

  const skip = (): void =>
    void window.argus.agent.answerDialog(slug, sessionId, {
      dialogId: dialog.dialogId,
      behavior: 'cancelled'
    })

  return (
    <div
      className="rounded-r3 border border-defect/40 bg-panel p-3"
      style={{
        background:
          'radial-gradient(ellipse at top right, rgba(243,195,82,0.08), transparent 60%), var(--bg-2)'
      }}
    >
      <div className="flex items-center gap-2">
        <SectionLabel>Question</SectionLabel>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-mute">{slug}</span>
      </div>
      <div className="mt-2 flex flex-col gap-4">
        {dialog.questions.map((q, qi) => {
          const sel = picked[qi] ?? new Set<number>()
          return (
            <div key={qi} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Chip tone="defect">{q.header}</Chip>
                <span className="text-sm text-ink">{q.question}</span>
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((o, oi) => (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggle(qi, oi, q.multiSelect)}
                    className={`flex flex-col items-start rounded-r2 border px-2 py-1.5 text-left transition-colors ${
                      sel.has(oi)
                        ? 'border-defect/70 bg-overlay'
                        : 'border-hair bg-overlay/40 hover:border-hair2'
                    }`}
                  >
                    <span className="text-xs text-ink">
                      <span className="mr-1.5 font-mono text-mute">
                        {q.multiSelect ? (sel.has(oi) ? '☑' : '☐') : sel.has(oi) ? '◉' : '○'}
                      </span>
                      {o.label}
                    </span>
                    {o.description ? (
                      <span className="ml-5 text-[11px] text-dim">{o.description}</span>
                    ) : null}
                  </button>
                ))}
              </div>
              <input
                className="h-7 min-w-0 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink placeholder:text-mute focus:border-hair2"
                placeholder="Other (free text)…"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Btn variant="primary" disabled={!allAnswered} onClick={submit}>
          Submit
        </Btn>
        <Btn variant="outline" onClick={skip}>
          Skip
        </Btn>
      </div>
    </div>
  )
}
