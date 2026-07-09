import { useState } from 'react'
import { Chip, Btn, SectionLabel } from './ui'

export function ApprovalCard({
  slug,
  request
}: {
  slug: string
  request: {
    requestId: string
    tool: string
    risk: string
    argsPreview: string
    grantKey: string | null
  }
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const respond = (kind: 'allow' | 'allow-session' | 'deny'): void => {
    void window.argus.agent.respond(slug, {
      requestId: request.requestId,
      kind,
      comment: comment || undefined
    })
  }
  const high = request.risk === 'HIGH'
  return (
    <div
      className={`rounded-r3 border bg-panel p-3 ${high ? 'border-danger/40' : 'border-defect/40'}`}
      style={{
        background: `radial-gradient(ellipse at top right, ${
          high ? 'rgba(242,122,107,0.08)' : 'rgba(243,195,82,0.08)'
        }, transparent 60%), var(--bg-2)`
      }}
    >
      <div className="flex items-center gap-2">
        <SectionLabel>Approval</SectionLabel>
        <Chip tone={high ? 'danger' : 'defect'}>{request.risk}</Chip>
        <span className="truncate font-mono text-xs text-dim">{request.tool}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-mute">{slug}</span>
      </div>
      {/* wraps long commands; vertical scroll only — never horizontal */}
      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-r1 border border-hair bg-overlay p-2 font-mono text-xs leading-relaxed text-ink">
        {request.argsPreview}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <Btn variant="primary" onClick={() => respond('allow')}>
          Approve
        </Btn>
        {request.grantKey && !high && (
          <Btn variant="outline" onClick={() => respond('allow-session')}>
            Approve for session
          </Btn>
        )}
        <Btn variant="danger" onClick={() => respond('deny')}>
          Deny
        </Btn>
        <input
          className="ml-1 h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink placeholder:text-mute focus:border-hair2"
          placeholder="reason (sent to the agent on deny)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
    </div>
  )
}
