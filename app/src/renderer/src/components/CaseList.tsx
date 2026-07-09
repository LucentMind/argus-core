import { useState } from 'react'
import type { CaseRecord, NewCaseInput } from '../../../shared/types'

interface Props {
  cases: CaseRecord[]
  selectedSlug: string | null
  onSelect: (slug: string) => void
  onCreate: (input: NewCaseInput) => void
}

export function CaseList({ cases, selectedSlug, onSelect, onCreate }: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')

  function submit(): void {
    if (!slug.trim() || !title.trim()) return
    const s = slug.trim()
    onCreate({ slug: s, title: title.trim(), jiraKey: /^[A-Z][A-Z0-9]+-\d+$/.test(s) ? s : undefined })
    setCreating(false)
    setSlug('')
    setTitle('')
  }

  return (
    <aside className="w-64 shrink-0 border-r border-neutral-700 p-3 flex flex-col gap-2">
      <button className="rounded bg-blue-600 px-2 py-1 text-sm" onClick={() => setCreating(!creating)}>
        New Case
      </button>
      {creating && (
        <div className="flex flex-col gap-1">
          <input
            className="rounded border border-neutral-600 bg-transparent px-2 py-1 text-sm"
            placeholder="slug (e.g. NAVAPI-12345)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <input
            className="rounded border border-neutral-600 bg-transparent px-2 py-1 text-sm"
            placeholder="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="rounded bg-green-700 px-2 py-1 text-sm" onClick={submit}>
            Create
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {cases.map((c) => (
          <li
            key={c.slug}
            onClick={() => onSelect(c.slug)}
            className={`cursor-pointer rounded px-2 py-1 text-sm ${
              c.slug === selectedSlug ? 'bg-neutral-700' : 'hover:bg-neutral-800'
            }`}
          >
            <div className="font-medium">{c.slug}</div>
            <div className="truncate text-xs text-neutral-400">{c.title}</div>
            <div className="text-xs text-neutral-500">{c.status}</div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
