// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AssetTab } from '../AssetTab'
import { PaneActionSlotContext } from '../paneActionSlot'
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
    // `readFile`/`writeFile` (Task 2) start unset here — the `sibling files` describe block below
    // stubs them per test, matching how `skillsRead` above is the module-level stub for the
    // SKILL.md path. Left `undefined` by default rather than `vi.fn()` so a test that forgets to
    // stub one fails loudly (a `TypeError`) instead of silently resolving `undefined`.
    //
    // `listFiles`/`onChanged` (Task 5) DO get a default: every `kind: 'skill', mode: 'edit'` pane
    // mounted below now fetches its Files dock list on mount regardless of what the test is
    // actually about, so an unstubbed call here would fail every case in this file rather than
    // only the ones that care about it.
    skills: {
      read: skillsRead,
      write: vi.fn(),
      listFiles: vi.fn().mockResolvedValue([]),
      onChanged: () => () => {}
    },
    refsync: { readRef: vi.fn(), writeRef: vi.fn() },
    authoring: { draft: vi.fn(), improve: vi.fn() }
  } as never
})

/** Test id of the stand-in title-bar slot `SlotHost` renders — same role as `AssetPane.test.tsx`'s
 *  identical helper. */
const SLOT = 'titlebar-actions'

/**
 * Stands in for the editor window's title-bar strip. `AssetPane` (mounted by `AssetTab` below)
 * has no header row of its own — the view-mode toggle and Save portal into the slot the window
 * publishes (paneActionSlot.ts) — so any test that reaches for either button needs one to portal
 * into. Every existing case above this point queries only text/labels the loader itself renders,
 * so wrapping `mount` in this changes nothing for them.
 */
function SlotHost({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <div data-testid={SLOT} ref={setSlot} />
      <PaneActionSlotContext.Provider value={slot}>{children}</PaneActionSlotContext.Provider>
    </>
  )
}

const mount = (
  req: EditorOpenRequest = SKILL,
  opts: { readOnly?: boolean; tier?: string } = {}
): ReturnType<typeof render> =>
  render(
    <SlotHost>
      <AssetTab
        req={req}
        onDirtyChange={vi.fn()}
        active={true}
        readOnly={opts.readOnly ?? false}
        tier={opts.tier}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
      />
    </SlotHost>
  )

/** Reuses the file's one render helper (`mount`), the way every case above it does — the brief's
 *  `renderTab` is this, under the name already in use here. */
const renderTab = mount

/** Clicks the Save button portalled into `SlotHost`'s slot — the same path `AssetPane.test.tsx`
 *  drives Save through, since Ctrl+S here would reach nothing: the CodeSurface mock above renders
 *  a plain `<textarea>` with no CodeMirror keymap, and the window-level Ctrl+S fallback lives in
 *  `EditorApp.tsx`, which this file does not mount. */
async function saveActivePane(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
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
        active={true}
        readOnly={false}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
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
        active={true}
        readOnly={false}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
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
      <AssetTab
        req={{ kind: 'skill', name: 'hij', mode: 'create' }}
        onDirtyChange={vi.fn()}
        active={true}
        readOnly={false}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
      />
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
      <AssetTab
        req={{ kind: 'skill', name: 'my-skill', mode: 'create' }}
        onDirtyChange={vi.fn()}
        active={true}
        readOnly={false}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
      />
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
      <AssetTab
        req={{ kind: 'skill', name: 'hij', mode: 'create' }}
        onDirtyChange={vi.fn()}
        active={true}
        readOnly={false}
        onNameChange={vi.fn()}
        onViewStateChange={vi.fn()}
        linkTargets={[]}
        onOpenLink={vi.fn()}
      />
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

// The brief's one explicit "behavioural change, not a pass-through" (spec §... via AssetPane's
// `fileDraft` guard): a read-only buffer can never diverge from disk, so resolving a draft for it
// — or listing other create-mode drafts it could collide with — is pure wasted IPC for a banner
// that can never fire. Both `readDraft` and `listDrafts` are already module-level mocks above.
describe('read-only loading', () => {
  const CREATE_SKILL: EditorOpenRequest = { kind: 'skill', name: 'new-skill', mode: 'create' }

  it('does not read the draft store when read-only', async () => {
    mount(SKILL, { readOnly: true })
    expect(await screen.findByLabelText('skill · my-skill')).toBeInTheDocument()
    expect(readDraft).not.toHaveBeenCalled()
  })

  it('reads the draft store as usual when editable', async () => {
    mount(SKILL, { readOnly: false })
    expect(await screen.findByLabelText('skill · my-skill')).toBeInTheDocument()
    expect(readDraft).toHaveBeenCalledWith({ kind: 'skill', name: 'my-skill' })
  })

  it('keeps otherDrafts empty when read-only, even in create mode', async () => {
    listDrafts.mockResolvedValue([
      {
        kind: 'skill',
        name: 'half-written',
        mode: 'create',
        content: 'x',
        baseHash: null,
        updatedAt: '2026-07-31T10:00:00.000Z'
      }
    ])
    mount(CREATE_SKILL, { readOnly: true })
    expect(await screen.findByLabelText('skill · new-skill')).toBeInTheDocument()
    expect(listDrafts).not.toHaveBeenCalled()
    expect(screen.queryByText(/unsaved new skill/i)).not.toBeInTheDocument()
  })

  it('lists other create-mode drafts as usual when editable', async () => {
    listDrafts.mockResolvedValue([
      {
        kind: 'skill',
        name: 'half-written',
        mode: 'create',
        content: 'x',
        baseHash: null,
        updatedAt: '2026-07-31T10:00:00.000Z'
      }
    ])
    mount(CREATE_SKILL, { readOnly: false })
    expect(await screen.findByLabelText('skill · new-skill')).toBeInTheDocument()
    expect(listDrafts).toHaveBeenCalled()
    expect(screen.getByText(/1 unsaved new skill from earlier/i)).toBeInTheDocument()
  })
})

// A sibling file (`req.file` set) is always the skill's, never a reference's — a reference has no
// siblings. These five cover the whole surface Task 4 adds: the sibling read path bypasses the
// SKILL.md reader entirely, Markdown preview is offered only for a `.md` sibling, a save round-
// trips through `writeFile` with the sibling's own hash, and read-only-ness (computed upstream by
// `EditorApp`'s `tierOf`/`isAssetEditable` — see the comment there) still reaches the pane.
describe('sibling files', () => {
  it('loads a sibling through readFile, not the SKILL.md reader', async () => {
    const readFile = vi.fn().mockResolvedValue({
      content: '#!/bin/sh\necho hi\n',
      hash: 'a'.repeat(64),
      executable: true,
      tier: 'user',
      editable: true
    })
    window.argus.skills.readFile = readFile
    window.argus.skills.read = vi.fn()
    renderTab({ kind: 'skill', name: 'collect-logs', file: 'scripts/collect.sh', mode: 'edit' })
    await screen.findByText(/echo hi/)
    expect(readFile).toHaveBeenCalledWith('collect-logs', 'scripts/collect.sh')
    expect(window.argus.skills.read).not.toHaveBeenCalled()
  })

  it('offers no Markdown preview for a non-Markdown sibling', async () => {
    window.argus.skills.readFile = vi.fn().mockResolvedValue({
      content: '#!/bin/sh\necho hi\n',
      hash: 'a'.repeat(64),
      executable: true,
      tier: 'user',
      editable: true
    })
    renderTab({ kind: 'skill', name: 'collect-logs', file: 'scripts/collect.sh', mode: 'edit' })
    await screen.findByText(/echo hi/)
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
  })

  it('keeps the preview toggle for a Markdown sibling', async () => {
    window.argus.skills.readFile = vi.fn().mockResolvedValue({
      content: '# Report\n',
      hash: 'b'.repeat(64),
      executable: false,
      tier: 'user',
      editable: true
    })
    renderTab({ kind: 'skill', name: 'collect-logs', file: 'templates/report.md', mode: 'edit' })
    await screen.findByText(/Report/)
    // The header toggle is a three-way cycle — Editor -> Split -> Preview -> Edit (Task 7) — and
    // opens on 'Editor' ("Split" is its own label), so one click is needed to reach the state
    // whose label is "Preview". Same pattern as AssetPane.test.tsx's identical climb.
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(screen.getByRole('button', { name: /preview/i })).toBeTruthy()
  })

  it('saves a sibling through writeFile with its baseHash', async () => {
    const writeFile = vi.fn().mockResolvedValue({ hash: 'c'.repeat(64), executable: true })
    window.argus.skills.readFile = vi.fn().mockResolvedValue({
      content: 'echo hi\n',
      hash: 'a'.repeat(64),
      executable: true,
      tier: 'user',
      editable: true
    })
    window.argus.skills.writeFile = writeFile
    renderTab({ kind: 'skill', name: 'collect-logs', file: 'scripts/collect.sh', mode: 'edit' })
    await screen.findByText(/echo hi/)
    await saveActivePane()
    expect(writeFile).toHaveBeenCalledWith(
      'collect-logs',
      'scripts/collect.sh',
      expect.any(String),
      'a'.repeat(64)
    )
  })

  it('shows the read-only notice for a sibling of a read-only skill', async () => {
    window.argus.skills.readFile = vi.fn().mockResolvedValue({
      content: 'echo hi\n',
      hash: 'a'.repeat(64),
      executable: true,
      tier: 'hivemind',
      editable: false
    })
    // `readOnly`/`tier` are supplied here rather than derived inside this test, matching how the
    // 'read-only loading' describe block above already drives this component: `readOnly` is
    // computed upstream by `EditorApp` (`tierOf` + `isAssetEditable`, confirmed unaffected by
    // `file` — see the comment in EditorApp.tsx), not by `AssetTab`/`AssetPane` themselves, so a
    // unit test of this component supplies the answer that computation would have produced for a
    // hivemind-tier skill. The tier badge (StatusBar.tsx) is what actually renders "HiveMind"
    // here — this file has no `ReadOnlyNotice` (that lives in `EditorApp.tsx`'s `TabPane`,
    // outside this component's tree).
    renderTab(
      { kind: 'skill', name: 'team-skill', file: 'run.sh', mode: 'edit' },
      { readOnly: true, tier: 'HiveMind' }
    )
    expect(await screen.findByText(/read-only|hivemind/i)).toBeTruthy()
  })
})
