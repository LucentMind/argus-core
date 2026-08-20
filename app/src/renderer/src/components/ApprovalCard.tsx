import { useState } from 'react'
import { Chip, Btn, SectionLabel } from './ui'
import { isEditableTool } from '../../../shared/editableTools'
import { capabilitiesFor } from '../../../shared/drivers'
import { useSettingsPayload } from '../lib/settingsStore'
import type { SkillAssetContext } from '../../../shared/agent-events'

export function ApprovalCard({
  slug,
  sessionId,
  instanceId = null,
  request
}: {
  slug: string
  sessionId: number
  /** Provider instance running THIS chat. With several providers enabled, the global
   *  default's capabilities are not necessarily this session's. */
  instanceId?: string | null
  request: {
    requestId: string
    tool: string
    risk: string
    argsPreview: string
    grantKey: string | null
    input?: Record<string, unknown>
    /** Set only for a shell ask that resolved to a script inside a skill (spec §7.2). */
    assetContext?: SkillAssetContext
  }
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const settingsPayload = useSettingsPayload()
  // Editable per-field preview for connector (MCP) asks at MEDIUM risk — the RCA
  // comment path (spec §3.4). Excludes Argus's own native tools (also `mcp__*`,
  // e.g. `mcp__argus__update_case_status`) and HIGH-risk asks, which stay read-only,
  // except the narrow allowlist in shared/editableTools (e.g. write_memory), where
  // the args are pure reviewed content and editing is the review mechanism.
  // Additionally gated on THIS SESSION's driver capabilities.editableApprovals
  // (Task 11) — a driver that can't honor updatedInput (e.g. Copilot v1) must
  // never be offered an edit affordance it can't actually apply. Session-scoped
  // rather than global: two chats in the same case can run different providers,
  // and capabilitiesFor falls back conservatively when the instance is unknown.
  const editable =
    request.input != null &&
    request.risk === 'MEDIUM' &&
    isEditableTool(request.tool) &&
    capabilitiesFor(settingsPayload?.settings, instanceId).editableApprovals
  const edited = Object.entries(draft).some(([k, v]) => v !== request.input?.[k])

  const respond = (kind: 'allow' | 'allow-session' | 'deny'): void => {
    void window.argus.agent.respond(slug, sessionId, {
      requestId: request.requestId,
      kind,
      comment: comment || undefined,
      updatedInput:
        kind !== 'deny' && editable && edited ? { ...request.input, ...draft } : undefined
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
      {request.assetContext && <SkillAssetNotice ctx={request.assetContext} />}
      {editable ? (
        <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto">
          {Object.entries(request.input!).map(([k, v]) =>
            typeof v === 'string' ? (
              <label key={k} className="flex flex-col gap-1">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-mute">
                  {k}
                </span>
                <textarea
                  aria-label={k}
                  // `bg-well`, not `bg-overlay` (Task 12 review finding 1): this card's own fill
                  // is `var(--bg-2)` (the `bg-panel` utility below, plus a radial tint) — an
                  // opaque near-white in light, same defect class as AssetPane's create-mode
                  // inputs.
                  className="min-h-16 rounded-r1 border border-hair bg-well p-2 font-mono text-xs leading-relaxed text-ink focus:border-hair2"
                  value={draft[k] ?? v}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                />
              </label>
            ) : (
              <div key={k} className="font-mono text-xs text-dim">
                <span className="text-mute">{k}: </span>
                {JSON.stringify(v)}
              </div>
            )
          )}
        </div>
      ) : (
        /* wraps long commands; vertical scroll only — never horizontal.
           `bg-well`, not `bg-overlay` (Task 12 review finding 1): same on-card reasoning as the
           editable textarea above. */
        <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-r1 border border-hair bg-well p-2 font-mono text-xs leading-relaxed text-ink">
          {request.argsPreview}
        </pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Btn variant="primary" onClick={() => respond('allow')}>
          Approve
        </Btn>
        {/* A HIGH ask offers no session grant: the key would usually be broad enough that one
            approval covers things the user never saw. A skill-asset key is pinned to the
            file's sha256 and dies the instant the bytes change, so it is the exception. */}
        {request.grantKey && (!high || request.assetContext) && (
          <Btn variant="outline" onClick={() => respond('allow-session')}>
            Approve for session
          </Btn>
        )}
        <Btn variant="danger" onClick={() => respond('deny')}>
          Deny
        </Btn>
        {/* `bg-well`, not `bg-overlay` (Task 12 review finding 1): same on-card reasoning as the
            preview/textarea above. */}
        <input
          className="ml-1 h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-well px-2 text-xs text-ink placeholder:text-mute focus:border-hair2"
          placeholder="reason (sent to the agent on deny)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
    </div>
  )
}

const REVIEW_COPY: Record<SkillAssetContext['reviewState'], string> = {
  reviewed: 'reviewed on this machine',
  changed: 'CHANGED since you reviewed it',
  unreviewed: 'never reviewed here'
}

/**
 * What a reviewer needs before letting a skill's script run: which skill, which file, whether
 * these exact bytes were approved here, and the bytes themselves.
 *
 * Collapsed by default — the command is the headline and a 400-line script would bury the
 * buttons — but one click away, because approving bytes you were not shown is the failure this
 * whole mechanism exists to prevent.
 */
function SkillAssetNotice({ ctx }: { ctx: SkillAssetContext }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div
      data-testid="skill-asset-notice"
      className="mt-2 rounded-r1 border border-hair bg-well p-2"
    >
      <div className="text-xs text-ink">
        Runs <span className="font-mono">{ctx.relPath}</span> from the{' '}
        <span className="font-mono">{ctx.skill}</span> skill ({ctx.tier}) —{' '}
        {REVIEW_COPY[ctx.reviewState]}
      </div>
      <button
        type="button"
        className="mt-1 text-xs text-dim underline-offset-2 hover:text-ink hover:underline"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide script' : 'Show script'}
      </button>
      {open && (
        <>
          <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-r1 border border-hair bg-well p-2 font-mono text-xs leading-relaxed text-ink">
            {ctx.body}
          </pre>
          {ctx.bodyBytesOmitted > 0 && (
            // An explicit count, not an inline marker: a truncation marker gets re-truncated
            // downstream and read as the whole file.
            <div className="mt-1 font-mono text-[10.5px] text-mute">
              {ctx.bodyBytesOmitted} bytes omitted of {ctx.bodyBytesTotal}
            </div>
          )}
        </>
      )}
    </div>
  )
}
