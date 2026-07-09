import { useState } from 'react'
import type { TranscriptItem } from '../lib/agentStore'

export function ToolCallCard({
  item
}: {
  item: Extract<TranscriptItem, { kind: 'tool' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const dot = !item.done ? 'bg-signal animate-pulse' : item.isError ? 'bg-danger' : 'bg-review'
  return (
    <div className="rounded-r2 border border-hair bg-deep transition-colors hover:border-hair2">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate font-mono text-xs text-dim">
          {item.name.replace('mcp__argus__', 'argus:')}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-mute">{open ? '−' : '+'}</span>
      </button>
      {open && item.outputPreview && (
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-hair p-2.5 font-mono text-[11px] leading-relaxed text-mute">
          {item.outputPreview}
        </pre>
      )}
    </div>
  )
}
