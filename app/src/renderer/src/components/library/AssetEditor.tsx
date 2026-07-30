import { useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles } from 'lucide-react'
import { Btn } from '../ui'
import { ModalShell } from '../ModalShell'
import { diffLines } from '../../lib/lineDiff'
import { confirm } from '../../lib/confirmStore'
import {
  validateSkill,
  validateReference,
  hasErrors,
  type ValidationIssue
} from '../../../../shared/assetValidation'
import type { AuthoringKind } from '../../../../shared/authoringIpc'

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

// eslint-disable-next-line react-refresh/only-export-components -- templates co-located with the component that consumes them; Task 8 imports them too, see LibraryPage.tsx for the same pattern
export function skillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Use when … (name the situation, the artifacts involved, and the words a user would say)',
    '# roles: [triage, review]   # optional — omit to apply in both modes',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    '## Method',
    '',
    '1. ',
    ''
  ].join('\n')
}

// eslint-disable-next-line react-refresh/only-export-components -- templates co-located with the component that consumes them; Task 8 imports them too, see LibraryPage.tsx for the same pattern
export function referenceTemplate(name: string): string {
  const title = name.replace(/\.md$/, '').replace(/[-_]/g, ' ')
  return [
    `# ${title}`,
    '',
    'One-sentence overview — this seeds the references index.',
    '',
    '## ',
    ''
  ].join('\n')
}

export interface AssetEditorProps {
  kind: AuthoringKind
  /** Skill folder name / reference file name. In create mode, the initial value of the name field. */
  name: string
  mode: 'edit' | 'create'
  /** Absent in create mode. */
  load?: () => Promise<{ content: string; hash: string }>
  save: (args: { name: string; content: string; baseHash: string | null }) => Promise<void>
  onClose: () => void
  onSaved?: (name: string) => void
}

/**
 * The write half of the Library. Deliberately separate from MarkdownViewer, which stays a
 * ~55-line reader: this owns buffer/dirty state, validation, the assist overlay, and conflict
 * reporting. Both are driven by injected load/save callbacks, so one component serves skills,
 * references — and, later, pending proposals (spec §9).
 */
export function AssetEditor({
  kind,
  name: initialName,
  mode,
  load,
  save,
  onClose,
  onSaved
}: AssetEditorProps): React.JSX.Element {
  const template = kind === 'skill' ? skillTemplate : referenceTemplate
  const [name, setName] = useState(initialName)
  const [buffer, setBuffer] = useState(mode === 'create' ? template(initialName) : '')
  const [baseHash, setBaseHash] = useState<string | null>(null)
  const [pristine, setPristine] = useState(true)
  const [loaded, setLoaded] = useState(mode === 'create')
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [describe, setDescribe] = useState('')
  const [proposed, setProposed] = useState<string | null>(null)

  useEffect(() => {
    if (!load) return
    let live = true
    load().then(
      ({ content, hash }) => {
        if (!live) return
        setBuffer(content)
        setBaseHash(hash)
        setLoaded(true)
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
    // load is mount-stable: callers remount (key/conditional render) per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const issues: ValidationIssue[] = useMemo(
    () =>
      kind === 'skill'
        ? validateSkill({ name, content: buffer })
        : validateReference({ file: name, content: buffer }),
    [kind, name, buffer]
  )
  const blocked = hasErrors(issues)

  function edit(next: string): void {
    setBuffer(next)
    setPristine(false)
  }

  async function onSave(): Promise<void> {
    if (blocked) {
      setError(issues.find((i) => i.severity === 'error')!.message)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await save({ name, content: buffer, baseHash })
      onSaved?.(name)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function assist(which: 'draft' | 'improve'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const req = { kind, name, text: which === 'draft' ? describe : buffer }
      const { content } =
        which === 'draft'
          ? await window.argus.authoring.draft(req)
          : await window.argus.authoring.improve(req)
      // Nothing to lose against boilerplate, and a diff against a template is noise.
      if (which === 'draft' && pristine) {
        setBuffer(content)
        setPristine(false)
      } else {
        setProposed(content)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function requestClose(): Promise<void> {
    if (
      pristine ||
      (await confirm({ title: 'Discard your changes?', confirmLabel: 'Discard', danger: true }))
    ) {
      onClose()
    }
  }

  const label = `${kind} · ${name}`

  return (
    <ModalShell
      title={`${kind === 'skill' ? 'skills' : 'references'} / ${name}`}
      ariaLabel={label}
      onClose={() => void requestClose()}
      className="h-[80vh] w-[80vw] max-w-4xl"
      actions={
        <>
          <Btn variant="ghost" onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Preview'}
          </Btn>
          <Btn variant="ghost" disabled={busy} onClick={() => void requestClose()}>
            Cancel
          </Btn>
          <Btn variant="primary" disabled={busy || !loaded} onClick={() => void onSave()}>
            Save
          </Btn>
        </>
      }
    >
      {mode === 'create' && (
        <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
          <input
            aria-label={`${kind} name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56 rounded-r2 bg-black/20 px-2 py-1 font-mono text-xs outline-none"
          />
          <input
            aria-label="describe it"
            placeholder="Describe what it should do…"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            className="min-w-0 flex-1 rounded-r2 bg-black/20 px-2 py-1 text-xs outline-none placeholder:text-faint"
          />
          <Btn
            variant="outline"
            disabled={busy || !describe.trim()}
            onClick={() => void assist('draft')}
          >
            <Sparkles size={13} aria-hidden="true" />
            Draft
          </Btn>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-3 mt-2 rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {proposed !== null ? (
        <>
          <pre className="flex-1 overflow-auto px-4 py-3 font-mono text-xs">
            {diffLines(buffer, proposed).map((l, i) => (
              <div key={i} className={KIND_CLASS[l.kind]}>
                {KIND_PREFIX[l.kind]}
                {l.text}
              </div>
            ))}
          </pre>
          <div className="flex justify-end gap-2 border-t border-hair px-3 py-2">
            <Btn variant="ghost" onClick={() => setProposed(null)}>
              Discard
            </Btn>
            <Btn
              variant="primary"
              onClick={() => {
                edit(proposed)
                setProposed(null)
              }}
            >
              Accept
            </Btn>
          </div>
        </>
      ) : preview ? (
        <div className="markdown-body flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
          <Markdown remarkPlugins={[remarkGfm]}>{buffer}</Markdown>
        </div>
      ) : (
        <textarea
          aria-label={label}
          spellCheck={false}
          value={buffer}
          onChange={(e) => edit(e.target.value)}
          className="flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-ink outline-none"
        />
      )}

      {!preview && proposed === null && (
        <div className="flex items-center justify-between gap-2 border-t border-hair px-3 py-2">
          <span className="flex flex-col gap-0.5">
            {issues.map((i, n) => (
              <span
                key={n}
                role={i.severity === 'error' ? undefined : 'status'}
                className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-review'}`}
              >
                {i.severity === 'error' ? '⚠' : '•'} {i.message}
                {i.line !== undefined && ` (line ${i.line})`}
              </span>
            ))}
          </span>
          <Btn
            variant="outline"
            disabled={busy || !buffer.trim()}
            onClick={() => void assist('improve')}
          >
            <Sparkles size={13} aria-hidden="true" />
            Improve
          </Btn>
        </div>
      )}
    </ModalShell>
  )
}
