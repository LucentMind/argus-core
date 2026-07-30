// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
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

/** DiffView cell text for one `data-kind`, within a given root — same query DiffView.test.tsx
 *  uses. `del` cells come from `before`, `add` cells from `after`, so this is how a Compare
 *  test proves which side (disk vs buffer) actually landed in which DiffView column. */
const kindsIn = (root: HTMLElement, kind: 'same' | 'add' | 'del'): string[] =>
  Array.from(root.querySelectorAll(`[data-kind="${kind}"]`)).map((el) => el.textContent ?? '')

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

  // Finding 3 (MINOR): AssetEditor's load effect sets `bufferPristine` false for a restored
  // draft (`pristine: false`), which flips `draftable` true and fires `draft.onChange` once on
  // mount with content identical to what was just read. That used to re-persist the draft on
  // every reopen — same content, but a bumped `updatedAt` — turning "Restored unsaved draft
  // from …" into "when you last opened this" instead of "when you last typed".
  it('does not re-persist a restored draft merely by opening it', async () => {
    readDraft.mockResolvedValue(aDraft())
    mount()
    await screen.findByText(BANNERS.restored)
    expect(await editor()).toHaveValue(`${SKILL_BODY}drafted`)
    expect(draftChanged).not.toHaveBeenCalled()
  })
})

// final-review-fixes-2, Regression 1 (IMPORTANT): Finding 3's mount-echo skip used to compare
// every `draft.onChange` call against `seeded.current`, not just the first one. A later call
// that happened to land back on the exact seed bytes — a deliberate revert, or a rename undone —
// was swallowed too, either stranding stale content on disk or dropping the `replaces` routing a
// rename-back needs to follow the name.
describe('AssetTab reverting back to the seed', () => {
  it('re-files the draft when typed text is deleted back to the original content', async () => {
    mount()
    const ta = await editor()
    await userEvent.type(ta, 'X')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith({
        kind: 'skill',
        name: 'my-skill',
        mode: 'edit',
        content: `${SKILL_BODY}X`,
        baseHash: 'h1'
      })
    )

    // Delete the 'X': the buffer is now byte-identical to what `init.load` seeded, exactly the
    // shape Finding 3's skip was written to swallow — but this call is not the mount echo, and
    // must still persist. Left skipped, the draft on disk would keep holding `SKILL_BODY + 'X'`
    // — the text the user just deliberately deleted — ready to hand right back on the next
    // "Restored unsaved draft" reopen.
    draftChanged.mockClear()
    await userEvent.type(ta, '{backspace}')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith({
        kind: 'skill',
        name: 'my-skill',
        mode: 'edit',
        content: SKILL_BODY,
        baseHash: 'h1'
      })
    )
  })

  it('follows a rename undone back to the seeded name, carrying the replaces routing (spec §4.5)', async () => {
    // Create mode with a restored draft: `seeded = { content: 'seed content', name: 'a' }` and
    // `bufferPristine` is false, the same setup Regression 1's rename-away-and-back scenario
    // needs.
    skillsRead.mockRejectedValue(new Error('No such skill: a'))
    readDraft.mockResolvedValue(
      aDraft({ name: 'a', mode: 'create', content: 'seed content', baseHash: null })
    )
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'a', mode: 'create' }}
        onDirtyChange={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const nameField = await screen.findByLabelText('skill name')
    expect(nameField).toHaveValue('a')

    // Rename a -> ab: files under the new name with `replaces: a`.
    await userEvent.type(nameField, 'b')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'ab', replaces: { kind: 'skill', name: 'a' } })
      )
    )

    // Rename ab -> a: content and name both land back on the seed. Before the fix this matched
    // Finding 3's skip and dropped the `replaces: ab` routing it had just computed, while
    // `filedAs` still advanced to 'a' — stranding the draft under `key('ab')` forever, since
    // reopening 'a' would find nothing there.
    draftChanged.mockClear()
    await userEvent.type(nameField, '{backspace}')
    await waitFor(() =>
      expect(draftChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'a', replaces: { kind: 'skill', name: 'ab' } })
      )
    )
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

  // Finding 2 (IMPORTANT): the mirror is seeded `buffer.current = ''` while AssetEditor holds
  // the template, and `draft.onChange` is gated on `draftable` (stays false until something is
  // typed) — so the mirror never catches up. Saving the untouched template used to make
  // `handleSaved` see `buffer.current ('') !== savedContent (the template)` and take the "user
  // kept typing during the write" branch, filing an empty draft against the hash just written.
  it('does not file an empty draft when the untouched template is saved as-is', async () => {
    skillsRead.mockRejectedValue(new Error('No such skill: brand-new'))
    skillsWrite.mockResolvedValue({ skills: [], hash: 'h2' })
    render(
      <AssetTab
        req={{ kind: 'skill', name: 'brand-new', mode: 'create' }}
        onDirtyChange={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await screen.findByRole('textbox', { name: /skill · brand-new/i })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(discardDraft).toHaveBeenCalledWith({ kind: 'skill', name: 'brand-new' })
    )
    expect(draftChanged).not.toHaveBeenCalled()
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

  // final-review-fixes-2, Regression 2 (IMPORTANT): `resolveConflict('keep-mine', …)` returns
  // `discardDraft: false` — the draft file survives Keep mine — but resolves `baseHash` to the
  // *new* disk hash. Before Regression 1's fix, the remount's mount echo happened to re-file the
  // draft under that new hash anyway (its content matched the seed, but `everMirrored` was still
  // false so nothing skipped it). Now that echo is correctly recognized as "nothing new" and
  // skipped, so the draft is left holding the *old* `baseHash` unless `apply()` files it itself.
  // Left stale, the next reopen's `bannerOnOpen` compares that old hash against current disk and
  // raises the staleness banner again — re-asking a question the user already answered.
  it('re-files the draft against the new disk hash when Keep mine resolves a staleness banner', async () => {
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    await screen.findByText(BANNERS.stale)
    draftChanged.mockClear()
    await userEvent.click(screen.getByRole('button', { name: /keep mine/i }))

    // 'h1' is the hash `skillsRead`'s default mock reports for disk right now — not 'older',
    // which the draft was taken from and which resolving the banner has just superseded.
    await waitFor(() =>
      expect(draftChanged).toHaveBeenCalledWith({
        kind: 'skill',
        name: 'my-skill',
        mode: 'edit',
        content: `${SKILL_BODY}drafted`,
        baseHash: 'h1'
      })
    )
  })

  it('Compare shows the disk text against the buffer', async () => {
    // Deliberately disjoint fixtures: the default SKILL_BODY-plus-suffix pairing shares almost
    // every line, so a `before`/`after` swap (or a compareSnapshot that captured the wrong
    // value) would still leave most rows looking identical. Content with nothing in common
    // forces every line to show up as a one-sided del or add, so the assertions below can pin
    // down which side each version actually landed on.
    skillsRead.mockResolvedValue({ content: 'only on disk\n', hash: 'h1' })
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older', content: 'only in the draft\n' }))
    mount()
    await screen.findByText(BANNERS.stale)
    await userEvent.click(screen.getByRole('button', { name: /compare/i }))
    const group = await screen.findByRole('group', { name: /on disk compared with yours/i })

    // `before` is the disk snapshot: its text shows up as a del (left column).
    expect(kindsIn(group, 'del').join('\n')).toContain('only on disk')
    expect(kindsIn(group, 'del').join('\n')).not.toContain('only in the draft')
    // `after` is the compareSnapshot taken from the buffer: its text shows up as an add (right
    // column).
    expect(kindsIn(group, 'add').join('\n')).toContain('only in the draft')
    expect(kindsIn(group, 'add').join('\n')).not.toContain('only on disk')

    // The wrapper hiding AssetEditor while Compare is up carries `aria-hidden` (jsdom implements
    // no `inert` behaviour, so that half of the hardening is untestable here — see the comment
    // on the wrapper in AssetTab.tsx). The banner underneath and DiffView both render a "Keep
    // mine" button; without `aria-hidden` this role query would match both.
    expect(screen.getAllByRole('button', { name: /keep mine/i })).toHaveLength(1)
  })

  it('moves focus to the compare view instead of dropping it to <body>', async () => {
    // The Compare button lives inside `bannerNode`, which renders inside the wrapper that
    // `inert` gets applied to the moment Compare opens. Clicking it makes the focused element
    // (Compare itself) inert in the same commit, so the browser blurs it — without an explicit
    // claim, focus lands on <body> and a keyboard user has to tab from the top of the document
    // to reach the diff they just opened.
    readDraft.mockResolvedValue(aDraft({ baseHash: 'older' }))
    mount()
    await screen.findByText(BANNERS.stale)
    await userEvent.click(screen.getByRole('button', { name: /compare/i }))
    await screen.findByRole('group', { name: /on disk compared with yours/i })

    expect(screen.getByRole('button', { name: /back/i })).toHaveFocus()
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

  // final-review-fixes-2 (found via gate step 5, dev-only): dev-mode React.StrictMode
  // double-invokes the mount effect (setup, simulated cleanup, setup again) on the SAME ref —
  // the simulated cleanup used to leave `liveRef.current` stuck at `false` for the component's
  // whole real lifetime, because the setup function never re-armed it. With that stuck, this
  // exact scenario (identical to the test above) falls through `save()`'s `if (!liveRef.current)
  // throw e` guard and rethrows the raw, unclassified IPC error instead of ever calling
  // `isConflict`/`setBanner` — the conflict banner never appears. jsdom's default `render` never
  // exercises this: it only surfaces under `<StrictMode>`, and the real bug this test guards was
  // only ever caught by driving a real Save conflict through a real `electron-vite dev` boot.
  it('still raises the conflict banner under StrictMode double-invoked mount effects', async () => {
    const onDirtyChange = vi.fn()
    render(
      <StrictMode>
        <AssetTab req={SKILL} onDirtyChange={onDirtyChange} onClose={vi.fn()} />
      </StrictMode>
    )
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('"my-skill" changed on disk since you opened it.'))
    skillsRead.mockResolvedValue({ content: 'someone else\n', hash: 'h9' })

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(BANNERS.conflict)).toBeInTheDocument()
  })

  it('Compare from the conflict banner shows the disk text against the buffer', async () => {
    mount()
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('"my-skill" changed on disk since you opened it.'))
    skillsRead.mockResolvedValue({ content: 'someone else\n', hash: 'h9' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(BANNERS.conflict)

    await userEvent.click(screen.getByRole('button', { name: /compare/i }))
    const group = await screen.findByRole('group', { name: /on disk compared with yours/i })

    // `before` is the disk snapshot re-read after the rejected write.
    expect(kindsIn(group, 'del').join('\n')).toContain('someone else')
    expect(kindsIn(group, 'del').join('\n')).not.toContain('my-skill')
    // `after` is the compareSnapshot taken from the still-dirty buffer (SKILL_BODY + 'X').
    expect(kindsIn(group, 'add').join('\n')).toContain('my-skill')
    expect(kindsIn(group, 'add').join('\n')).not.toContain('someone else')
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

  // Finding 1 (CRITICAL, data loss): Compare's `return <DiffView/>` used to unmount AssetEditor.
  // AssetEditor's load effect has an empty dependency array and runs exactly once per mount, so
  // remounting it on the way back to Back re-ran that effect against the *original* `init.load`
  // closure and silently reverted every keystroke typed since the tab opened — with no banner,
  // no error, and a dirty report that had gone back to false.
  it('Back from Compare does not revert the buffer or clear the dirty report', async () => {
    const { onDirtyChange } = mount()
    await userEvent.type(await editor(), 'X')
    skillsWrite.mockRejectedValue(new Error('"my-skill" changed on disk since you opened it.'))
    skillsRead.mockResolvedValue({ content: 'someone else\n', hash: 'h9' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(BANNERS.conflict)

    await userEvent.click(screen.getByRole('button', { name: /compare/i }))
    await screen.findByRole('group', { name: /on disk compared with yours/i })
    await userEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(await editor()).toHaveValue(`${SKILL_BODY}X`)
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
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
