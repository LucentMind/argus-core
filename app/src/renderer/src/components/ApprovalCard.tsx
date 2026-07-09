import { useState } from 'react'
import { Chip, Btn } from './ui'

export function ApprovalCard({
  slug,
  request
}: {
  slug: string
  request: { requestId: string; tool: string; risk: string; argsPreview: string; grantKey: string | null }
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const respond = (kind: 'allow' | 'allow-session' | 'deny'): void => {
    void window.argus.agent.respond(slug, {
      requestId: request.requestId,
      kind,
      comment: comment || undefined
    })
  }
  const tone = request.risk === 'HIGH' ? 'danger' : 'defect'
  return (
    <div className={`rounded-r3 border p-3 ${request.risk === 'HIGH' ? 'border-danger/40' : 'border-defect/40'} bg-panel`}>
      <div className="flex items-center gap-2">
        <Chip tone={tone}>{request.risk}</Chip>
        <span className="font-mono text-xs text-dim">{request.tool}</span>
        <span className="ml-auto font-mono text-[11px] text-mute">{slug}</span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-r1 bg-overlay p-2 font-mono text-xs text-ink">
        {request.argsPreview}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <Btn variant="primary" onClick={() => respond('allow')}>Approve</Btn>
        {request.grantKey && request.risk !== 'HIGH' && (
          <Btn onClick={() => respond('allow-session')}>Approve for session</Btn>
        )}
        <Btn variant="danger" onClick={() => respond('deny')}>Deny</Btn>
        <input
          className="ml-2 flex-1 rounded-r1 border border-hair bg-overlay px-2 py-1 text-xs text-ink placeholder:text-mute"
          placeholder="reason (sent to the agent on deny)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
    </div>
  )
}
