// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import {
  UnifiedDiff,
  SplitDiff,
  ProposedView,
  NewFileView,
  diffStat,
  CodeView,
  isMarkdownPath
} from '../DiffViews'

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

/** A one-line edit at each end of a 40-line unchanged middle — the shape the hunking exists
 *  for: this used to render all 42 lines to show two changes. */
const LONG_BEFORE = ['head', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'tail'].join(
  '\n'
)
const LONG_AFTER = ['HEAD', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'TAIL'].join('\n')

/** A unified-diff row is two text nodes (prefix + text), which `getByText` will not match as
 *  one element — same reason the legacy-format test above uses a matcher function. */
const row = (text: string) => (_: string, node: Element | null) =>
  node?.textContent === text && node?.tagName === 'DIV'

describe('diff hunking', () => {
  it('collapses the unchanged middle and leaves both changes plus their context showing', () => {
    render(<UnifiedDiff current={LONG_BEFORE} content={LONG_AFTER} />)
    expect(screen.getByText('- head')).toBeInTheDocument()
    expect(screen.getByText('+ HEAD')).toBeInTheDocument()
    expect(screen.getByText('- tail')).toBeInTheDocument()
    // 3 lines of context survive at each end...
    expect(screen.getByText(row('  line 2'))).toBeInTheDocument()
    expect(screen.getByText(row('  line 37'))).toBeInTheDocument()
    // ...and the 34 between them are behind one bar.
    expect(screen.queryByText(row('  line 3'))).not.toBeInTheDocument()
    expect(screen.queryByText(row('  line 20'))).not.toBeInTheDocument()
    expect(screen.getByTestId('diff-gap')).toHaveTextContent('34 unchanged lines')
  })

  it('expands the collapsed run in place when the bar is clicked', () => {
    render(<UnifiedDiff current={LONG_BEFORE} content={LONG_AFTER} />)
    fireEvent.click(screen.getByTestId('diff-gap'))
    expect(screen.getByText(row('  line 20'))).toBeInTheDocument()
    expect(screen.queryByTestId('diff-gap')).not.toBeInTheDocument()
  })

  it('"show whole file" opens every gap at once', () => {
    render(<UnifiedDiff current={LONG_BEFORE} content={LONG_AFTER} />)
    expect(screen.getByText(/34 unchanged lines hidden/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'show whole file' }))
    expect(screen.getByText(row('  line 20'))).toBeInTheDocument()
    expect(screen.queryByText(/unchanged lines hidden/)).not.toBeInTheDocument()
  })

  it('a short diff is not hunked at all — no bar, no chrome', () => {
    render(<UnifiedDiff current={CURRENT} content={CONTENT} />)
    expect(screen.queryByTestId('diff-gap')).not.toBeInTheDocument()
    expect(screen.queryByText(/unchanged lines hidden/)).not.toBeInTheDocument()
  })

  it('the split view resumes real file line numbers after a gap', () => {
    render(<SplitDiff current={LONG_BEFORE} content={LONG_AFTER} />)
    // An unchanged line fills both columns, so it is two cells, not one.
    expect(screen.getAllByText('line 37')).toHaveLength(2)
    // ...numbered 39 on both sides: 1 head + 38 lines before it.
    expect(screen.getAllByText('39')).toHaveLength(2)
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

describe('isMarkdownPath', () => {
  it.each(['SKILL.md', 'templates/report.md', 'NOTES.MARKDOWN'])('accepts %s', (p) => {
    expect(isMarkdownPath(p)).toBe(true)
  })
  it.each(['scripts/collect.sh', 'data/x.json', 'bin/run'])('rejects %s', (p) => {
    expect(isMarkdownPath(p)).toBe(false)
  })
})

describe('CodeView', () => {
  const SCRIPT = '#!/bin/sh\n# collect logs\n    indented\n'

  it('renders a shell comment literally, not as a heading', () => {
    render(<CodeView content={SCRIPT} />)
    // The whole body is one <pre>; a Markdown pass would have produced an <h1> for "# collect
    // logs" and swallowed the leading spaces on the indented line.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(
      screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === SCRIPT)
    ).toBeInTheDocument()
  })

  it('preserves indentation exactly', () => {
    render(<CodeView content={SCRIPT} />)
    const pre = screen.getByText(
      (_, node) => node?.tagName === 'PRE' && node.textContent === SCRIPT
    )
    expect(pre.textContent).toContain('\n    indented\n')
  })
})
