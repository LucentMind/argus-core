import type { Risk } from '../../../shared/agent-events'

export interface ApprovalRequest {
  requestId: string
  tool: string
  risk: Risk
  grantKey: string | null
  argsPreview: string
}

export type ResolvedDecision = 'allow' | 'allow-session' | 'deny' | 'cancelled'
export interface ApprovalOutcome {
  decision: ResolvedDecision
  comment?: string
  updatedInput?: Record<string, unknown>
}

interface Pending {
  request: ApprovalRequest
  settle: (outcome: ApprovalOutcome) => void
}

export class PendingApprovals {
  private pending = new Map<string, Pending>()

  get size(): number {
    return this.pending.size
  }

  open(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.pending.delete(request.requestId)) return
        resolve(outcome)
      }
      this.pending.set(request.requestId, { request, settle })
      signal?.addEventListener('abort', () => settle({ decision: 'cancelled' }), { once: true })
    })
  }

  resolve(
    requestId: string,
    decision: 'allow' | 'allow-session' | 'deny',
    comment?: string,
    updatedInput?: Record<string, unknown>
  ): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    p.settle({ decision, comment, updatedInput })
    return true
  }

  drain(): string[] {
    const ids = [...this.pending.keys()]
    for (const p of [...this.pending.values()]) p.settle({ decision: 'cancelled' })
    return ids
  }
}

export class SessionGrants {
  private keys = new Set<string>()
  has(key: string): boolean {
    return this.keys.has(key)
  }
  add(key: string): void {
    this.keys.add(key)
  }
}
