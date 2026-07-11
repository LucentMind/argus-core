import { diffLines } from '../../lib/lineDiff'

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

export function DiffView({
  oldText,
  newText
}: {
  oldText: string | null
  newText: string
}): React.JSX.Element {
  const lines = diffLines(oldText ?? '', newText)
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">
      {lines.map((l, i) => (
        <div key={i} className={KIND_CLASS[l.kind]}>
          {KIND_PREFIX[l.kind]}
          {l.text}
        </div>
      ))}
    </pre>
  )
}
