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
      findingsStaying: [
        { id: 11, summary: 'kept finding', reason: 'accepted' },
        { id: 12, summary: 'already rejected finding', reason: 'already-retracted' }
      ],
      externalActions: [{ tool: 'jira_comment', count: 2 }],
      files: { kind: 'native', restored: ['a.txt'], skipped: 1 }
    }
    render(<RewindConfirmBody preview={preview} />)

    expect(screen.getByText(/2 turns/)).toBeInTheDocument()
    expect(screen.getByText('stale finding')).toBeInTheDocument()
    expect(screen.getByText('kept finding')).toBeInTheDocument()
    // M5: the list can hold both an accepted finding and one that was already rejected, so the
    // heading cannot claim everything under it "stays accepted".
    expect(screen.getByText('already rejected finding')).toBeInTheDocument()
    expect(screen.getByText('(already retracted)')).toBeInTheDocument()
    expect(screen.getByText('Stays as it is')).toBeInTheDocument()
    expect(screen.getByText(/jira_comment/)).toBeInTheDocument()
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument()
    expect(screen.getByText(/keeps its full context up to this point/)).toBeInTheDocument()
  })

  /**
   * I3. "What context survives" and "what happens to files" are two different facts. They
   * correlate on every preview main produces today (both come from `nativeBranching`), which is
   * exactly why the context sentence used to live inside the file-restore block and could not
   * be told apart from it. This preview separates them: `branching` is the field that decides
   * the sentence, and a rendering keyed on `files.kind` fails here.
   */
  it('takes the context sentence from preview.branching, not from the file block', () => {
    const preview: RewindPreview = {
      anchorTurnId: 1,
      branching: 'digest',
      tail: [{ turnId: 2, userText: 'second' }],
      findingsToRetract: [],
      findingsStaying: [],
      externalActions: [],
      files: { kind: 'native', restored: ['a.txt'], skipped: 0 }
    }
    render(<RewindConfirmBody preview={preview} />)
    expect(screen.getByText(/receives a summary of the history/)).toBeInTheDocument()
    expect(screen.queryByText(/keeps its full context/)).toBeNull()
  })

  /** M4. A native preview that reports `files.error` (no checkpoints, or the anchor is not in
   *  the provider transcript) must say plainly that files stay as they are — not bury it after
   *  a "Files restored" heading and a "0 skipped" count, which read as a successful restore. */
  it('says files cannot be restored, and that the conversation is rewound anyway', () => {
    const preview: RewindPreview = {
      anchorTurnId: 1,
      branching: 'native',
      tail: [{ turnId: 2, userText: 'second' }],
      findingsToRetract: [],
      findingsStaying: [],
      externalActions: [],
      files: { kind: 'native', restored: [], skipped: 0, error: 'no checkpoints for this session' }
    }
    render(<RewindConfirmBody preview={preview} />)
    expect(
      screen.getByText(/Files cannot be restored: no checkpoints for this session/)
    ).toBeInTheDocument()
    expect(screen.getByText(/The conversation is still rewound/)).toBeInTheDocument()
    expect(screen.queryByText('Files restored')).toBeNull()
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
    expect(screen.getByText(/receives a summary of the history/)).toBeInTheDocument()
  })
})
