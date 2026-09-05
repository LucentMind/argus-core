// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RewindConfirmBody } from '../RewindConfirmBody'
import type { RewindPreview } from '../../../../shared/branching'

describe('RewindConfirmBody', () => {
  it('renders the tail, finding split, external actions and native file restore', () => {
    const preview: RewindPreview = {
      anchorTurnId: 1,
      branching: 'native',
      tail: [
        { turnId: 2, userText: 'second' },
        { turnId: 3, userText: 'third' }
      ],
      findingsToRetract: [{ id: 10, summary: 'stale finding' }],
      findingsStaying: [{ id: 11, summary: 'kept finding', reason: 'accepted' }],
      externalActions: [{ tool: 'jira_comment', count: 2 }],
      files: { kind: 'native', restored: ['a.txt'], skipped: 1 }
    }
    render(<RewindConfirmBody preview={preview} />)

    expect(screen.getByText(/2 turns/)).toBeInTheDocument()
    expect(screen.getByText('stale finding')).toBeInTheDocument()
    expect(screen.getByText('kept finding')).toBeInTheDocument()
    expect(screen.getByText(/jira_comment/)).toBeInTheDocument()
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument()
  })

  it('renders the counts-only file summary and provider caveat for a digest driver', () => {
    const preview: RewindPreview = {
      anchorTurnId: 1,
      branching: 'digest',
      tail: [{ turnId: 2, userText: 'second' }],
      findingsToRetract: [],
      findingsStaying: [],
      externalActions: [],
      files: { kind: 'counts', writes: [{ tool: 'Edit', count: 3 }] }
    }
    render(<RewindConfirmBody preview={preview} />)

    expect(screen.getByText(/Edit ×3/)).toBeInTheDocument()
    expect(screen.getByText(/files are not restored on this provider/)).toBeInTheDocument()
  })
})
