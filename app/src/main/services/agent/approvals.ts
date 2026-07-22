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

export type DialogOutcome =
  | { behavior: 'completed'; result: { answers: Record<string, string>; response?: string } }
  | { behavior: 'cancelled' }

interface PendingDialog {
  settle: (outcome: DialogOutcome) => void
}

/** Twin of PendingApprovals for the AskUserQuestion pipeline. Keyed by a harness dialogId. */
export class PendingDialogs {
  private pending = new Map<string, PendingDialog>()

  get size(): number {
    return this.pending.size
  }

  open(dialogId: string, signal?: AbortSignal): Promise<DialogOutcome> {
    return new Promise((resolve) => {
      const settle = (outcome: DialogOutcome): void => {
        if (!this.pending.delete(dialogId)) return
        resolve(outcome)
      }
      this.pending.set(dialogId, { settle })
      signal?.addEventListener('abort', () => settle({ behavior: 'cancelled' }), { once: true })
    })
  }

  resolve(dialogId: string, outcome: DialogOutcome): boolean {
    const p = this.pending.get(dialogId)
    if (!p) return false
    p.settle(outcome)
    return true
  }

  drain(): string[] {
    const ids = [...this.pending.keys()]
    for (const p of [...this.pending.values()]) p.settle({ behavior: 'cancelled' })
    return ids
  }
}
