// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetTab } from '../AssetTab'
import type { DraftRecord, DraftSaved, EditorOpenRequest } from '../../../../../shared/editorIpc'

vi.mock('../../library/assistProvider', () => ({
  useAssistProvider: vi.fn(() => ({ ok: true, text: 'via claude' }))
}))

const SKILL_BODY = '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# hi\n'
const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }

const draftChanged = vi.fn()
const readDraft = vi.fn<() => Promise<DraftRecord | null>>()
const discardDraft = vi.fn().mockResolvedValue(undefined)
const skillsRead = vi.fn()
const skillsWrite = vi.fn()
let draftSaved: ((s: DraftSaved) => void) | null = null

beforeEach(() => {
  draftChanged.mockClear()
  discardDraft.mockClear()
  readDraft.mockReset().mockResolvedValue(null)
  skillsRead.mockReset().mockResolvedValue({ content: SKILL_BODY, hash: 'h1' })
  skillsWrite.mockReset().mockResolvedValue({ skills: [], hash: 'h2' })
  draftSaved = null
  window.argus = {
    editor: {
      draftChanged,
      readDraft,
      discardDraft,
      onDraftSaved: (cb: (s: DraftSaved) => void) => {
        draftSaved = cb
        return () => {}
      }
    },
    skills: { read: skillsRead, write: skillsWrite },
    refsync: { readRef: vi.fn(), writeRef: vi.fn() },
    authoring: { draft: vi.fn(), improve: vi.fn() }
  } as never
})

const mount = (req: EditorOpenRequest = SKILL): { onDirtyChange: ReturnType<typeof vi.fn> } => {
  const onDirtyChange = vi.fn()
  render(<AssetTab req={req} onDirtyChange={onDirtyChange} onClose={vi.fn()} />)
  return { onDirtyChange }
}

const editor = (): Promise<HTMLElement> =>
  screen.findByRole('textbox', { name: /skill · my-skill/i })

/** Banners are queried by text, never by role: AssetEditor gives its own validation warnings
 *  role="status", so a role query would be ambiguous the moment a fixture warns. */
const BANNERS = {
  restored: /Restored unsaved draft from/,
  stale: /This file changed on disk since your draft\./,
  conflict: /The saved version is newer than what you started from\./
}
const noBanner = (): void => {
  for (const re of Object.values(BANNERS)) expect(screen.queryByText(re)).not.toBeInTheDocument()
}

const aDraft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  kind: 'skill',
  name: 'my-skill',
  mode: 'edit',
  content: `${SKILL_BODY}drafted`,
  baseHash: 'h1',
  updatedAt: '2026-07-30T15:42:00.000Z',
  ...over
})

describe('AssetTab when an existing asset cannot be read', () => {
  it('reports the failure instead of hanging on Loading forever', async () => {
    // mode: 'edit', no draft, and disk read fails (readAsset swallows the rejection to
    // null) — the same shape a transient IPC failure produces for a real, existing asset.
    // This must not be mistaken for create mode: the user should be told, not left on a
    // permanent, silent "Loading…".
    skillsRead.mockRejectedValue(new Error('boom'))
    mount()
    expect(await screen.findByText('File could not be read.')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})

describe('AssetTab without a draft', () => {
  it('opens the file from disk', async () => {
    mount()
    expect(await editor()).toHaveValue(SKILL_BODY)
  })

  it('shows no banner', async () => {
    mount()
    await editor()
    noBanner()
  })

  it('reports a change to main once the buffer is touched', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith({
        kind: 'skill',
        name: 'my-skill',
        mode: 'edit',
        content: `${SKILL_BODY}X`,
        baseHash: 'h1'
      })
    )
  })

  it('claims nothing until main says the draft is on disk', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    // Persist-before-adopt: the send happened, but nothing has landed yet.
    expect(screen.queryByText(/^Draft ·/)).not.toBeInTheDocument()

    draftSaved!({ kind: 'skill', name: 'my-skill', updatedAt: '2026-07-30T15:42:00.000Z' })
    expect(await screen.findByText(/^Draft ·/)).toBeInTheDocument()
  })

  it('ignores a draft-saved for a different asset', async () => {
    mount()
    await editor()
    draftSaved!({ kind: 'reference', name: 'notes.md', updatedAt: '2026-07-30T15:42:00.000Z' })
    expect(screen.queryByText(/^Draft ·/)).not.toBeInTheDocument()
  })
})

describe('AssetTab restoring a draft', () => {
  it('opens the draft text, not the disk text', async () => {
    readDraft.mockResolvedValue(aDraft())
    mount()
    expect(await editor()).toHaveValue(`${SKILL_BODY}drafted`)
  })

  it('shows the restore banner with the draft time', async () => {
    readDraft.mockResolvedValue(aDraft())
    mount()
    expect(await screen.findByText(BANNERS.restored)).toBeInTheDocument()
  })

  it('opens dirty, so the window will guard its close', async () => {
    readDraft.mockResolvedValue(aDraft())
    const { onDirtyChange } = mount()
    await editor()
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })

  it('Discard draft deletes it and falls back to the disk text', async () => {
    readDraft.mockResolvedValue(aDraft())
    mount()
    await screen.findByText(BANNERS.restored)
    readDraft.mockResolvedValue(null)
    await userEvent.click(screen.getByRole('button', { name: /discard draft/i }))

    await waitFor(() =>
      expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 'my-skill' })
    )
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(SKILL_BODY))
    noBanner()
  })
})

describe('AssetTab after a save', () => {
  it('discards the draft when the buffer matches what was written', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 'my-skill' })
    )
    expect(screen.queryByText(/^Draft ·/)).not.toBeInTheDocument()
  })

  it('writes through skills.write with (name, content, loadedHash) in that order', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(skillsWrite).toHaveBeenCalledWith('my-skill', `${SKILL_BODY}X`, 'h1')
    )
  })
})

describe('AssetTab in create mode', () => {
  it('seeds the template when there is no draft', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: brand-new'))
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'brand-new', mode: 'create' }}
        onDirtyChange={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const ta = await screen.findByRole('textbox', { name: /skill · brand-new/i })
    expect((ta as HTMLTextAreaElement).value).toContain('name: brand-new')
  })

  it('re-keys the draft when the name field moves (spec §4.5)', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: brand-new'))
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'brand-new', mode: 'create' }}
        onDirtyChange={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await userEvent.type(await screen.findByLabelText('skill name'), '2')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: 'brand-new2',
          replaces: { kind: 'skill', name: 'brand-new' }
        })
      )
    )
  })
})

describe('AssetTab staleness at open', () => {
  it('offers the three verbs when the file moved under the draft', async () => {
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    expect(await screen.findByText(BANNERS.stale)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /keep mine/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /use disk/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /compare/i })).toBeInTheDocument()
  })

  it('Use disk replaces the buffer and drops the draft', async () => {
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    await screen.findByText(BANNERS.stale)
    await userEvent.click(screen.getByRole('button', { name: /use disk/i }))

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(SKILL_BODY))
    expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 'my-skill' })
    noBanner()
  })

  it('Keep mine keeps the buffer and saves against the disk hash', async () => {
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    await screen.findByText(BANNERS.stale)
    await userEvent.click(screen.getByRole('button', { name: /keep mine/i }))

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(`${SKILL_BODY}drafted`))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    // 'h1', the hash now on disk — not 'older', which the draft was taken from.
    await waitFor(() =>
      expect(skillsWrite).toHaveBeenCalledWith('my-skill', `${SKILL_BODY}drafted`, 'h1')
    )
  })

  it('Compare shows the disk text against the buffer', async () => {
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    await screen.findByText(BANNERS.stale)
    await userEvent.click(screen.getByRole('button', { name: /compare/i }))
    expect(
      await screen.findByRole('group', { name: /on disk compared with yours/i })
    ).toBeInTheDocument()
  })
})

describe('AssetTab conflict on save', () => {
  it('raises the conflict banner when the write is rejected and disk has moved', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('"my-skill" changed on disk since you opened it.'))
    skillsRead.mockResolvedValue({ content: 'someone else\n', hash: 'h9' })

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(BANNERS.conflict)).toBeInTheDocument()
  })

  it('leaves a validation rejection as a plain error, with no banner', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('description is required'))
    // Disk has not moved, so this cannot be a conflict.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('description is required')
    noBanner()
  })

  it('Keep mine after a conflict re-saves successfully against the newer hash', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('"my-skill" changed on disk since you opened it.'))
    skillsRead.mockResolvedValue({ content: 'someone else\n', hash: 'h9' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(BANNERS.conflict)

    skillsWrite.mockResolvedValue({ skills: [], hash: 'h10' })
    await userEvent.click(screen.getByRole('button', { name: /keep mine/i }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(`${SKILL_BODY}X`))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(skillsWrite).toHaveBeenLastCalledWith('my-skill', `${SKILL_BODY}X`, 'h9')
    )
  })
})

describe('AssetTab external change on focus', () => {
  it('silently reloads a clean buffer', async () => {
    mount()
    await editor()
    skillsRead.mockResolvedValue({ content: 'changed elsewhere\n', hash: 'h9' })

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('changed elsewhere\n'))
    noBanner()
  })

  it('raises the staleness banner over a dirty buffer instead', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    skillsRead.mockResolvedValue({ content: 'changed elsewhere\n', hash: 'h9' })

    window.dispatchEvent(new Event('focus'))
    expect(await screen.findByText(BANNERS.stale)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue(`${SKILL_BODY}X`)
  })

  it('does nothing when the file has not moved', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(skillsRead).toHaveBeenCalledTimes(2))
    noBanner()
  })
})
