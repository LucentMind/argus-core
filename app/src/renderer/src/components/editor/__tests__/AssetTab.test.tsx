// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AssetTab } from '../AssetTab'
import type {
  DraftAdoptRequest,
  DraftRecord,
  DraftRef,
  EditorOpenRequest
} from '../../../../../shared/editorIpc'

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

const draftChanged = vi.fn()
const readDraft = vi.fn<(ref: DraftRef) => Promise<DraftRecord | null>>()
const discardDraft = vi.fn<(ref: DraftRef) => Promise<void>>()
const adoptDraft = vi.fn<(req: DraftAdoptRequest) => Promise<boolean>>()
const skillsRead = vi.fn()
const listDrafts = vi.fn<() => Promise<DraftRecord[]>>()

beforeEach(() => {
  draftChanged.mockReset()
  readDraft.mockReset().mockResolvedValue(null)
  discardDraft.mockReset().mockResolvedValue(undefined)
  adoptDraft.mockReset().mockResolvedValue(true)
  listDrafts.mockReset().mockResolvedValue([])
  skillsRead.mockReset().mockResolvedValue({ content: SKILL_BODY, hash: 'h1' })
  window.argus = {
    editor: {
      draftChanged,
      readDraft,
      discardDraft,
      adoptDraft,
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

const aDraft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  kind: 'skill',
  name: 'my-skill',
  mode: 'edit',
  content: SKILL_BODY,
  baseHash: 'h1',
  updatedAt: '2026-07-30T15:42:00.000Z',
  ...over
})

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
    readDraft.mockResolvedValue(
      aDraft({ content: `${SKILL_BODY}drafted`, updatedAt: '2026-07-30T15:42:00.000Z' })
    )
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

// draft-id-rekey: create mode no longer keys drafts by kind+name (see keyOf in
// main/services/drafts.ts). AssetTab mints (or adopts) a stable draftId once per mount and reads
// the draft store by that id instead.
describe('AssetTab create-mode identity (draft-id-rekey)', () => {
  it('reads a resumed draft by the draftId carried on the open request', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: my-skill'))
    readDraft.mockImplementation(async (ref) =>
      'draftId' in ref && ref.draftId === 'resumed-id'
        ? aDraft({
            name: 'my-skill',
            mode: 'create',
            content: '# resumed draft content\n',
            baseHash: null,
            draftId: 'resumed-id'
          })
        : null
    )
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'my-skill', mode: 'create', draftId: 'resumed-id' }}
        onDirtyChange={vi.fn()}
      />
    )

    expect(await screen.findByLabelText('skill · my-skill')).toHaveValue(
      '# resumed draft content\n'
    )
    expect(readDraft).toHaveBeenCalledWith({ draftId: 'resumed-id' })
    // Resolved directly by id — the legacy kind+name fallback below must never fire when the id
    // lookup already found something.
    expect(readDraft).not.toHaveBeenCalledWith({ kind: 'skill', name: 'my-skill' })
  })

  it('mints a fresh non-empty draftId for a brand new create tab and reads by it', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: brand-new'))
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'brand-new', mode: 'create' }}
        onDirtyChange={vi.fn()}
      />
    )
    await screen.findByLabelText('skill · brand-new')
    await waitFor(() => expect(readDraft).toHaveBeenCalled())
    const [ref] = readDraft.mock.calls[0] as [DraftRef]
    expect('draftId' in ref && typeof ref.draftId === 'string' && ref.draftId.length > 0).toBe(true)
  })
})

// draft-id-rekey back-compat: a create-mode draft written before draftId existed has no
// `draftId` field and is still keyed by kind+name. It must remain resumable, and quietly move
// onto the new scheme the moment its tab is opened, rather than needing a migration pass.
describe('AssetTab legacy draft back-compat (draft-id-rekey)', () => {
  it('adopts a legacy create-mode draft through the single atomic adoptDraft call: content preserved', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: hij'))
    listDrafts.mockResolvedValue([])
    // Nothing is ever filed under a draftId here (a fresh tab has none yet to look up); the
    // legacy record sits at the old kind+name key instead.
    readDraft.mockImplementation(async (ref) =>
      'draftId' in ref
        ? null
        : ref.name === 'hij'
          ? aDraft({ name: 'hij', mode: 'create', content: '# hij\n', baseHash: null })
          : null
    )
    render(
      <AssetTab req={{ kind: 'skill', name: 'hij', mode: 'create' }} onDirtyChange={vi.fn()} />
    )

    // Content preserved: the legacy record's bytes open in the tab, not a fresh template.
    const ta = await screen.findByLabelText('skill · hij')
    expect(ta).toHaveValue('# hij\n')

    // Finding 1: adoption goes through the single atomic `adoptDraft` call — not a separate
    // `draftChanged` + `discardDraft` pair, whose ordering (debounced write, immediate delete)
    // was the data-loss bug. `adoptDraft` carries both the legacy ref to discard and the new
    // record to write, so main can order them correctly.
    await waitFor(() =>
      expect(adoptDraft).toHaveBeenCalledWith({
        legacy: { kind: 'skill', name: 'hij' },
        change: {
          kind: 'skill',
          name: 'hij',
          mode: 'create',
          content: '# hij\n',
          baseHash: null,
          draftId: expect.any(String)
        }
      })
    )
    // The old two-step renderer-driven sequence must be gone entirely.
    expect(draftChanged).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('does not adopt an edit-mode draft that happens to sit at the same kind+name key', async () => {
    // New skill always opens as `my-skill`, so a real asset named "my-skill" being edited
    // elsewhere can leave a draft at exactly the kind+name key a fresh create tab's legacy
    // fallback would look up. That draft belongs to a different tab entirely and must never be
    // discarded or re-filed by this one.
    skillsRead.mockRejectedValue(new Error('No such skill: my-skill'))
    listDrafts.mockResolvedValue([])
    readDraft.mockImplementation(async (ref) =>
      'draftId' in ref ? null : aDraft({ mode: 'edit', content: 'someone else is editing this' })
    )
    render(
      <AssetTab req={{ kind: 'skill', name: 'my-skill', mode: 'create' }} onDirtyChange={vi.fn()} />
    )

    // Falls through to the create template instead of adopting the edit-mode draft's content.
    const ta = await screen.findByLabelText('skill · my-skill')
    expect((ta as HTMLTextAreaElement).value).toContain('name: my-skill')
    expect(adoptDraft).not.toHaveBeenCalled()
  })

  // Finding 2: every other async step in the resolve effect checks `live` before acting; the
  // adoption used to mutate the draft store unconditionally. A torn-down effect (React
  // StrictMode's simulated remount in dev, or a fast second `openTab`) must not re-file content
  // under a `draftId` no live tab holds.
  it('does not adopt when the effect is torn down before the legacy lookup resolves', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: hij'))
    listDrafts.mockResolvedValue([])
    let resolveLegacy: (v: DraftRecord | null) => void = () => {}
    readDraft.mockImplementation(async (ref) => {
      if ('draftId' in ref) return null
      return new Promise<DraftRecord | null>((resolve) => {
        resolveLegacy = resolve
      })
    })
    const { unmount } = render(
      <AssetTab req={{ kind: 'skill', name: 'hij', mode: 'create' }} onDirtyChange={vi.fn()} />
    )
    // Tear the effect down (cleanup sets `live = false`) before the legacy lookup ever resolves.
    unmount()
    resolveLegacy(aDraft({ name: 'hij', mode: 'create', content: '# hij\n', baseHash: null }))
    // Let the resumed async work run to completion.
    await new Promise((r) => setTimeout(r, 20))

    expect(adoptDraft).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
    expect(draftChanged).not.toHaveBeenCalled()
  })
})
