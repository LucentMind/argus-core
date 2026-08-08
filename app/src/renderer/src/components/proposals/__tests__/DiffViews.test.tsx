// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { UnifiedDiff, SplitDiff, ProposedView, NewFileView, diffStat } from '../DiffViews'

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
    // Verify the two-space prefix is rendered for 'same' lines (RTL's normalizer trims whitespace
    // in default mode, so we check raw textContent to catch regressions like KIND_PREFIX.same = '')
    expect(
      screen.getByText((_, node) => node?.textContent === '  keep' && node?.tagName === 'DIV')
    ).toBeInTheDocument()
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

describe('NewFileView', () => {
  it('splits frontmatter out and renders the body as markdown', () => {
    render(<NewFileView content={'---\nname: rca\ndescription: d\n---\n\n# Title\n\n- one\n'} />)
    // Frontmatter verbatim, in one block — a reviewer reads those keys literally.
    expect(screen.getByText(/name: rca/)).toBeInTheDocument()
    // Body as markdown: a heading element, not a line of `#` text.
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('one')
  })

  it('renders content with no frontmatter as markdown on its own', () => {
    render(<NewFileView content={'# Ref\n\nbody\n'} />)
    expect(screen.getByRole('heading', { name: 'Ref' })).toBeInTheDocument()
    // A leading `---` is the only frontmatter marker; without one nothing is held back.
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  // `---` inside the body (a thematic break under a heading) is not frontmatter: the fence has
  // to open on line 1, or the split would eat real content.
  it('does not treat a mid-document rule as frontmatter', () => {
    render(<NewFileView content={'# Ref\n\n---\n\nbody\n'} />)
    expect(screen.getByRole('heading', { name: 'Ref' })).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })
})
