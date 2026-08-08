import { diffLines } from '../../lib/lineDiff'

export type DiffViewMode = 'unified' | 'split' | 'proposed'

// Same prefixes/classes the old ProposalsPage used — existing tests (and eyes)
// key on the "+ "/"- " text format, so the unified view keeps it verbatim.
export const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
export const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

export function diffStat(current: string | null, content: string): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const l of diffLines(current ?? '', content)) {
    if (l.kind === 'add') adds++
    else if (l.kind === 'del') dels++
  }
  return { adds, dels }
}
