// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalDetail } from '../ProposalDetail'
import type { ProposalRecord } from '../../../../../shared/proposals'

const pending: ProposalRecord = {
  file: 'a.md',
  type: 'skill-edit',
  target: 'rca',
  caseSlug: 'NAV-100',
  date: '2026-07-10T12:00:00.000Z',
  title: 'Sharpen step 4',
  content: '# rca\nnew line\n',
  current: '# rca\nold line\n'
}

function renderDetail(over: Partial<Parameters<typeof ProposalDetail>[0]> = {}): {
  onAccept: ReturnType<typeof vi.fn>
  onReject: ReturnType<typeof vi.fn>
  onToggleEdit: ReturnType<typeof vi.fn>
  onViewMode: ReturnType<typeof vi.fn>
} {
  const onAccept = vi.fn()
  const onReject = vi.fn()
  const onToggleEdit = vi.fn()
  const onViewMode = vi.fn()
  render(
    <ProposalDetail
      proposal={pending}
      accepted={null}
      busy={false}
      editValue={null}
      onEditChange={vi.fn()}
      onToggleEdit={onToggleEdit}
      viewMode="unified"
      onViewMode={onViewMode}
      position={{ index: 1, total: 3 }}
      repoSet={true}
      onOpenHivemind={vi.fn()}
      onAccept={onAccept}
      onReject={onReject}
      selectedPath="SKILL.md"
      onSelectPath={vi.fn()}
      editedPaths={new Set()}
      {...over}
    />
  )
  return { onAccept, onReject, onToggleEdit, onViewMode }
}

// window.argus stub for SharePushDialog's lazy needs is added in the accepted-pane test only.

describe('ProposalDetail: pending', () => {
  it('renders header chips, unified diff, and the +/− stat', () => {
    renderDetail()
    expect(screen.getByText('Sharpen step 4')).toBeInTheDocument()
    expect(screen.getByText('Skill · edit')).toBeInTheDocument()
    expect(screen.getByText('→ rca')).toBeInTheDocument()
    expect(screen.getByText('- old line')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('switches view modes through the segmented control', () => {
    const { onViewMode } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    expect(onViewMode).toHaveBeenCalledWith('split')
  })

  it('renders split view when viewMode=split', () => {
    renderDetail({ viewMode: 'split' })
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.queryByText('- old line')).not.toBeInTheDocument()
  })

  it('Accept fires onAccept; Reject opens the reason row first', () => {
    const { onAccept, onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(onAccept).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    expect(onReject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject as overfit' }))
    expect(onReject).toHaveBeenCalledWith({ tag: 'overfit' })
  })

  it('reject with a note passes the note; skip reason passes undefined', () => {
    const { onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Reject note'), { target: { value: 'too narrow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reject as wrong' }))
    expect(onReject).toHaveBeenCalledWith({ tag: 'wrong', note: 'too narrow' })
  })

  it('a typed note can be confirmed on its own — Enter or the confirm button, tagged other', () => {
    const { onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Reject note'), { target: { value: 'my own words' } })
    fireEvent.keyDown(screen.getByLabelText('Reject note'), { key: 'Enter' })
    expect(onReject).toHaveBeenCalledWith({ tag: 'other', note: 'my own words' })

    onReject.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Reject with this note' }))
    expect(onReject).toHaveBeenCalledWith({ tag: 'other', note: 'my own words' })
  })

  it('with no note typed the confirm button rejects without a reason', () => {
    const { onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    expect(screen.queryByRole('button', { name: 'Reject with this note' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    expect(onReject).toHaveBeenCalledWith(undefined)
  })

  it('locked proposal disables Accept and explains why', () => {
    renderDetail({ proposal: { ...pending, locked: true } })
    expect(screen.getByRole('button', { name: 'Accept Sharpen step 4' })).toBeDisabled()
    expect(screen.getByText(/Ships with a pack/)).toBeInTheDocument()
  })

  it('edit mode swaps the diff for a textarea and hides the view bar', () => {
    renderDetail({ editValue: '# rca\nedited\n' })
    expect(screen.getByLabelText('Edit proposal content')).toHaveValue('# rca\nedited\n')
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()
  })

  // A new file has no `current`, so there is nothing to diff — the view toggle is gone and the
  // content renders formatted (user-directed, 2026-08-08). Frontmatter is held out of the
  // markdown so its keys stay literal.
  it('new file renders formatted content with no view bar and no diff', () => {
    renderDetail({
      proposal: {
        ...pending,
        type: 'skill-new',
        current: null,
        content: '---\nname: window-boundary-math\n---\n\n## When to use\nBody text\n'
      }
    })
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unified view' })).not.toBeInTheDocument()
    // Markdown, not a `+`-prefixed diff line.
    expect(screen.getByRole('heading', { name: 'When to use' })).toBeInTheDocument()
    expect(screen.queryByText('+ Body text')).not.toBeInTheDocument()
    expect(screen.getByText(/name: window-boundary-math/)).toBeInTheDocument()
  })

  // The +/− stat measured a diff that no longer renders — a "+6 −0" beside no diff is noise.
  it('new file shows no +/− stat', () => {
    renderDetail({ proposal: { ...pending, current: null, content: 'a\nb\n' } })
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('renders a basis line when the proposal carries one', () => {
    renderDetail({
      proposal: { ...pending, basis: 'transcript at msg 12: user confirmed the fix' }
    })
    expect(
      screen.getByText(/Basis: transcript at msg 12: user confirmed the fix/)
    ).toBeInTheDocument()
  })

  it('renders no basis line when the proposal carries none', () => {
    renderDetail()
    expect(screen.queryByText(/^Basis:/)).not.toBeInTheDocument()
  })

  it('renders a prior-reject warning banner with tag, case, and note, exposed as an a11y status region', () => {
    renderDetail({
      proposal: {
        ...pending,
        priorReject: { tag: 'overgeneric', caseSlug: 'NAV-42', note: 'too broad a claim' }
      }
    })
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(
      'Previously rejected as overgeneric (case NAV-42): too broad a claim'
    )
    expect(screen.getByText('overgeneric')).toBeInTheDocument()
  })

  it('renders the prior-reject banner without a note when none was recorded', () => {
    renderDetail({
      proposal: { ...pending, priorReject: { tag: 'wrong', caseSlug: 'NAV-42' } }
    })
    const banner = screen.getByText(/Previously rejected/).closest('div')!
    expect(banner).toHaveTextContent('Previously rejected as wrong (case NAV-42)')
    expect(banner.textContent).not.toContain(':')
  })

  it('renders no prior-reject banner when the proposal carries none', () => {
    renderDetail()
    expect(screen.queryByText(/previously rejected/i)).not.toBeInTheDocument()
  })

  it('case summary renders markdown, no view bar, no target chip', () => {
    renderDetail({
      proposal: { ...pending, type: 'case-summary', content: '## Summary\nBody text\n' }
    })
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()
    expect(screen.queryByText('→ rca')).not.toBeInTheDocument()
  })
})

describe('ProposalDetail: accepted pane', () => {
  // ProposalDetail never touches window.argus.settings itself — repoSet arrives as a prop.
  // SharePushDialog (mounted only after the Share button is clicked, which these two tests
  // don't do) calls window.argus.hivemind.pushPreview/pushStatus on mount, not `push` or
  // `settings.get` — verified by reading SharePushDialog.tsx directly, which differs from the
  // brief's draft stub. Stubbed here anyway so a future test that opens the dialog doesn't
  // silently hang on an unmocked IPC call.
  beforeEach(() => {
    ;(window as unknown as { argus: unknown }).argus = {
      hivemind: {
        pushPreview: vi.fn().mockResolvedValue('mock preview'),
        pushStatus: vi.fn().mockResolvedValue({ state: 'none' }),
        push: vi.fn()
      },
      openExternal: vi.fn()
    }
  })

  const acceptedEntry = {
    file: 'a.md',
    title: 'Sharpen step 4',
    caseSlug: 'NAV-100',
    date: '2026-07-10T12:00:00.000Z',
    type: 'skill-edit' as const,
    target: { kind: 'skill' as const, name: 'rca' },
    hasExec: false
  }

  it('shows the confirmation with Share to HiveMind when the repo is set', () => {
    renderDetail({ proposal: null, accepted: acceptedEntry, position: null })
    expect(screen.getByText(/accepted into your library/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share to HiveMind: rca' })).toBeInTheDocument()
  })

  it('offers HiveMind setup instead when no repo is set', () => {
    renderDetail({ proposal: null, accepted: acceptedEntry, position: null, repoSet: false })
    expect(screen.getByRole('button', { name: /Set up HiveMind/ })).toBeInTheDocument()
  })
})

describe('ProposalDetail: min-w-0 tripwire', () => {
  // Tripwire, not proof: jsdom does not lay out flexbox, so it cannot see the actual bug
  // (a long unbroken line silently clipped by the surface-card's overflow-hidden — live-verified
  // 2026-08-08). This only guards against someone removing the className that fixes it.
  it('keeps min-w-0 on the two flex ancestors of the diff body', () => {
    renderDetail()
    const heading = screen.getByText('Sharpen step 4')
    const root = heading.closest('.flex.min-h-0.min-w-0.flex-1.flex-col')
    expect(root).not.toBeNull()
    const content = root?.querySelector('.min-h-0.min-w-0.flex-1.overflow-y-auto')
    expect(content).not.toBeNull()
  })
})

const WITH_FILES: ProposalRecord = {
  file: '2026-08-19-acme-1-collect-logs',
  type: 'skill-new',
  target: 'collect-logs',
  caseSlug: 'acme-1',
  date: '2026-08-19T00:00:00.000Z',
  title: 'Collect logs',
  content: '---\ndescription: d\n---\n# Collect logs\n',
  current: null,
  files: [
    { path: 'scripts/collect.sh', content: '#!/bin/sh\n# collect\n', current: null, exec: true }
  ]
}

function renderFilesDetail(over: Record<string, unknown> = {}): {
  onSelectPath: ReturnType<typeof vi.fn>
} {
  const onSelectPath = vi.fn()
  render(
    <ProposalDetail
      proposal={WITH_FILES}
      accepted={null}
      busy={false}
      editValue={null}
      onEditChange={vi.fn()}
      onToggleEdit={vi.fn()}
      viewMode="unified"
      onViewMode={vi.fn()}
      position={{ index: 1, total: 1 }}
      repoSet={false}
      onOpenHivemind={vi.fn()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      selectedPath="SKILL.md"
      onSelectPath={onSelectPath}
      editedPaths={new Set()}
      {...over}
    />
  )
  return { onSelectPath }
}

describe('ProposalDetail with sibling files', () => {
  it('renders the rail', () => {
    renderFilesDetail()
    expect(screen.getByRole('tablist', { name: 'Files in this proposal' })).toBeInTheDocument()
  })

  it('shows the body when SKILL.md is selected', () => {
    renderFilesDetail()
    // The fixture's title and its markdown heading share the text "Collect logs" — the header
    // `<h2>` renders it too, so disambiguate by heading level: the body's Markdown pass produces
    // an `<h1>`, unlike the always-present `<h2>` title.
    expect(screen.getByRole('heading', { level: 1, name: 'Collect logs' })).toBeInTheDocument()
  })

  it('shows the selected sibling as CODE, not markdown', () => {
    renderFilesDetail({ selectedPath: 'scripts/collect.sh' })
    // A markdown pass would turn "# collect" into a heading. It must not.
    expect(screen.queryByRole('heading', { name: 'collect' })).not.toBeInTheDocument()
    expect(
      screen.getByText(
        (_, node) => node?.tagName === 'PRE' && node.textContent === '#!/bin/sh\n# collect\n'
      )
    ).toBeInTheDocument()
  })

  it('renders no rail for a flat proposal', () => {
    renderFilesDetail({ proposal: { ...WITH_FILES, files: undefined } })
    expect(
      screen.queryByRole('tablist', { name: 'Files in this proposal' })
    ).not.toBeInTheDocument()
  })

  it('edits the selected sibling through the same buffer props', () => {
    const onEditChange = vi.fn()
    renderFilesDetail({
      selectedPath: 'scripts/collect.sh',
      editValue: '#!/bin/sh\necho edited\n',
      onEditChange
    })
    const box = screen.getByLabelText('Edit proposal content')
    expect(box).toHaveValue('#!/bin/sh\necho edited\n')
    fireEvent.change(box, { target: { value: 'x' } })
    expect(onEditChange).toHaveBeenCalledWith('x')
  })

  // Controller resolution overrides the brief: CodeView replaces NewFileView only. A MODIFIED
  // sibling (non-null `current`) still diffs — UnifiedDiff/SplitDiff/ProposedView are already
  // plain `<pre>` line renderers that cannot eat a `#` as a heading, so there is no lossy-render
  // hazard on that path, and routing it through CodeView would silently drop the diff and the
  // view bar.
  it('shows a MODIFIED sibling as a diff, not CodeView, with the view bar present', () => {
    renderFilesDetail({
      selectedPath: 'scripts/collect.sh',
      proposal: {
        ...WITH_FILES,
        files: [
          {
            path: 'scripts/collect.sh',
            content: '#!/bin/sh\necho new\n',
            current: '#!/bin/sh\necho old\n',
            exec: true
          }
        ]
      }
    })
    expect(screen.getByText('+ echo new')).toBeInTheDocument()
    expect(screen.getByText('- echo old')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unified view' })).toBeInTheDocument()
  })
})
