// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssetTab } from '../AssetTab'
import type { DraftRecord, EditorOpenRequest } from '../../../../../shared/editorIpc'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: vi.fn(() => ({ ok: true, text: 'via claude' }))
}))

// CodeMirror measures real DOM and jsdom has no layout, so the surface is a textarea here (see
// the long note in AssetPane.test.tsx). These three cases are about what the loader *resolves*
// and hands down, so the surface only has to report the document it was mounted with.
interface MockSurfaceProps {
  initialDoc: string
  ariaLabel: string
  onDocChange: (doc: string) => void
}
vi.mock('../CodeSurface', () => ({
  CodeSurface: ({ initialDoc, ariaLabel, onDocChange }: MockSurfaceProps): React.JSX.Element => (
    <textarea
      aria-label={ariaLabel}
      defaultValue={initialDoc}
      onChange={(e) => onDocChange(e.target.value)}
    />
  )
}))

const SKILL_BODY = '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# hi\n'
const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }

const readDraft = vi.fn<() => Promise<DraftRecord | null>>()
const skillsRead = vi.fn()
const listDrafts = vi.fn<() => Promise<DraftRecord[]>>()

beforeEach(() => {
  readDraft.mockReset().mockResolvedValue(null)
  listDrafts.mockReset().mockResolvedValue([])
  skillsRead.mockReset().mockResolvedValue({ content: SKILL_BODY, hash: 'h1' })
  window.argus = {
    editor: {
      draftChanged: vi.fn(),
      readDraft,
      discardDraft: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
      listDrafts,
      onDraftSaved: () => () => {}
    },
    skills: { read: skillsRead, write: vi.fn() },
    refsync: { readRef: vi.fn(), writeRef: vi.fn() },
    authoring: { draft: vi.fn(), improve: vi.fn() }
  } as never
})

const mount = (req: EditorOpenRequest = SKILL): void => {
  render(<AssetTab req={req} onDirtyChange={vi.fn()} />)
}

/**
 * `AssetTab` is a loader: it reads disk and the draft store, picks the opening banner, and mounts
 * `AssetPane` with resolved values. Everything the buffer does afterwards is `AssetPane`'s, and is
 * covered in `AssetPane.test.tsx` — the `generation` / mount-echo / re-file cases Increment 2
 * needed described machinery that no longer exists.
 */
describe('AssetTab', () => {
  it('opens the file from disk when there is no draft', async () => {
    mount()
    expect(await screen.findByLabelText('skill · my-skill')).toHaveValue(SKILL_BODY)
    expect(screen.queryByText(/Restored unsaved draft/)).not.toBeInTheDocument()
  })

  it('opens the draft text under a restore banner when there is one', async () => {
    readDraft.mockResolvedValue({
      kind: 'skill',
      name: 'my-skill',
      mode: 'edit',
      content: `${SKILL_BODY}drafted`,
      baseHash: 'h1',
      updatedAt: '2026-07-30T15:42:00.000Z'
    })
    mount()
    expect(await screen.findByLabelText('skill · my-skill')).toHaveValue(`${SKILL_BODY}drafted`)
    expect(screen.getByText(/Restored unsaved draft from/)).toBeInTheDocument()
  })

  it('does not query the draft list in edit mode', async () => {
    // The resumable-drafts banner is create-mode only (spec §4.5). An edit-mode tab asking for
    // every draft on disk is both wasted IPC and the shape a leak into edit mode would take.
    mount()
    expect(await screen.findByLabelText('skill · my-skill')).toBeInTheDocument()
    expect(listDrafts).not.toHaveBeenCalled()
  })

  it('reports the failure instead of hanging on Loading forever', async () => {
    // mode: 'edit', no draft, and the disk read fails (readAsset swallows the rejection to null)
    // — the same shape a transient IPC failure produces for a real, existing asset. The user has
    // to be told, not left on a permanent, silent "Loading…".
    skillsRead.mockRejectedValue(new Error('boom'))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read skill "my-skill".')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})
