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
    <div className="rounded-r2 border border-hair bg-panel">
      <button
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs text-dim">{item.name.replace('mcp__argus__', 'argus:')}</span>
      </button>
      {open && item.outputPreview && (
        <pre className="max-h-64 overflow-auto border-t border-hair p-2 font-mono text-[11px] text-mute">
          {item.outputPreview}
        </pre>
      )}
    </div>
  )
}
