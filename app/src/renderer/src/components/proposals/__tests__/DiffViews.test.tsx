// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { UnifiedDiff, SplitDiff, ProposedView, diffStat } from '../DiffViews'

const CURRENT = 'keep\nold line\n'
const CONTENT = 'keep\nnew line\nadded tail\n'

describe('diffStat', () => {
  it('counts adds and dels from the line diff', () => {
    expect(diffStat(CURRENT, CONTENT)).toEqual({ adds: 2, dels: 1 })
  })
  it('treats a new file as all adds', () => {
    expect(diffStat(null, 'a\nb\n')).toEqual({ adds: 2, dels: 0 })
  })
})

describe('UnifiedDiff', () => {
  it('renders prefixed add/del/same lines (legacy format preserved)', () => {
    render(<UnifiedDiff current={CURRENT} content={CONTENT} />)
    expect(screen.getByText('- old line')).toBeInTheDocument()
    expect(screen.getByText('+ new line')).toBeInTheDocument()
    expect(screen.getByText('keep')).toBeInTheDocument()
  })
})

describe('SplitDiff', () => {
  it('pairs a del/add run side by side with line numbers', () => {
    render(<SplitDiff current={CURRENT} content={CONTENT} />)
    // pairRows: row 2 pairs left "old line" (del, no 2) with right "new line" (add, no 2)
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
    // "added tail" is an unpaired add: right cell filled, left cell is filler
    expect(screen.getByText('added tail')).toBeInTheDocument()
  })
})

describe('ProposedView', () => {
  it('renders the raw proposed content without diff markers', () => {
    render(<ProposedView content={CONTENT} />)
    expect(screen.getByText(/new line/)).toBeInTheDocument()
    expect(screen.queryByText('+ new line')).not.toBeInTheDocument()
  })
})
