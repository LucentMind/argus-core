// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetEditor } from '../AssetEditor'
import { confirm } from '../../../lib/confirmStore'
import { useAssistProvider } from '../assistProvider'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn()
}))

vi.mock('../assistProvider', () => ({
  useAssistProvider: vi.fn()
}))

const valid = [
  '---',
  'name: rca',
  'description: Use when a finding needs a root cause.',
  '---',
  '',
  '# rca',
  'Body.'
].join('\n')

function setup(over: Partial<Parameters<typeof AssetEditor>[0]> = {}): {
  save: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const save = vi.fn().mockResolvedValue('h2')
  const onClose = vi.fn()
  render(
    <AssetEditor
      kind="skill"
      name="rca"
      mode="edit"
      load={async () => ({ content: valid, hash: 'h1' })}
      save={save}
      onClose={onClose}
      {...over}
    />
  )
  return { save, onClose }
}

beforeEach(() => {
  window.argus = {
    authoring: {
      draft: vi.fn().mockResolvedValue({ content: valid }),
      improve: vi.fn().mockResolvedValue({ content: `${valid}\nimproved` })
    }
  } as never
  // The mock is module-level, so its call history outlives each test — without this,
  // "closes with no confirm" would see an earlier test's call.
  vi.mocked(confirm).mockClear()
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(useAssistProvider).mockReturnValue({
    ok: true,
    text: 'via claude-agent-sdk · claude-sonnet-4-5'
  })
})

describe('AssetEditor', () => {
  it('loads the file into an editable textarea', async () => {
    setup()
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    expect((ta as HTMLTextAreaElement).value).toBe(valid)
  })

  it('renders markdown in preview mode and no textarea', async () => {
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Body.')).toBeInTheDocument()
  })

  it('saves the buffer with the hash it loaded', async () => {
    const { save } = setup()
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmore')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ name: 'rca', content: `${valid}\nmore`, baseHash: 'h1' })
    )
  })

  it('blocks save and shows the error when the description is empty', async () => {
    const { save } = setup({
      load: async () => ({ content: valid.replace(/description: .*/, 'description:'), hash: 'h1' })
    })
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(save).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/description must not be empty/i)
  })

  it('shows a warning for an unknown role but still saves', async () => {
    const { save } = setup({
      load: async () => ({
        content: valid.replace('---\n\n# rca', 'roles: [nonsense]\n---\n\n# rca'),
        hash: 'h1'
      })
    })
    await screen.findByRole('textbox', { name: /skill · rca/i })
    expect(await screen.findByText(/is not a role I know/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(save).toHaveBeenCalled())
  })

  it('surfaces a save conflict without losing the buffer', async () => {
    const save = vi.fn().mockRejectedValue(new Error('"rca" changed on disk since you opened it.'))
    render(
      <AssetEditor
        kind="skill"
        name="rca"
        mode="edit"
        load={async () => ({ content: valid, hash: 'h1' })}
        save={save}
        onClose={vi.fn()}
      />
    )
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmine')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on disk/i)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('mine')
  })

  it('create mode prefills a template containing the typed name', async () => {
    setup({ mode: 'create', name: 'new-skill', load: undefined })
    const ta = await screen.findByRole('textbox', { name: /skill · new-skill/i })
    expect((ta as HTMLTextAreaElement).value).toContain('name: new-skill')
  })

  it('Draft replaces an untouched template outright', async () => {
    setup({ mode: 'create', name: 'rca', load: undefined })
    await userEvent.type(screen.getByRole('textbox', { name: /describe/i }), 'root cause work')
    await userEvent.click(screen.getByRole('button', { name: /^draft/i }))
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
      ).toBe(valid)
    )
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull()
  })

  it('Improve shows a diff that Accept applies and Discard does not', async () => {
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await screen.findByRole('button', { name: /^discard$/i })
    await userEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(
      (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
    ).toBe(valid)

    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^accept$/i }))
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
      ).toBe(`${valid}\nimproved`)
    )
  })

  it('shows a banner when assist fails and leaves the buffer alone', async () => {
    window.argus.authoring.improve = vi.fn().mockRejectedValue(new Error('No provider configured.'))
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no provider configured/i)
    expect(
      (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
    ).toBe(valid)
  })

  it('with a diff open, Draft is unavailable and Save is disabled', async () => {
    setup({ mode: 'create', name: 'rca', load: undefined })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await screen.findByRole('button', { name: /^discard$/i })

    expect(screen.queryByRole('button', { name: /^draft/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeDisabled()
  })

  it('gates edit mode on load: no false missing-frontmatter error, and no textbox exists before the load resolves', async () => {
    let resolveLoad!: (v: { content: string; hash: string }) => void
    const deferred = new Promise<{ content: string; hash: string }>((res) => {
      resolveLoad = res
    })
    setup({ load: () => deferred })

    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(/missing frontmatter/i)).toBeNull()

    resolveLoad({ content: valid, hash: 'h1' })

    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    expect((ta as HTMLTextAreaElement).value).toBe(valid)
  })

  it('renaming in create mode keeps the frontmatter name in sync and does not block Save', async () => {
    const { save } = setup({ mode: 'create', name: 'my-skill', load: undefined })
    const nameInput = screen.getByRole('textbox', { name: /^skill name$/i })
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'foo')

    const ta = screen.getByRole('textbox', { name: /skill · foo/i }) as HTMLTextAreaElement
    expect(ta.value).toContain('name: foo')

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        name: 'foo',
        content: expect.stringContaining('name: foo'),
        baseHash: null
      })
    )
  })

  it('renaming after the buffer has been edited does not rewrite it', async () => {
    setup({ mode: 'create', name: 'my-skill', load: undefined })
    const ta = screen.getByRole('textbox', { name: /skill · my-skill/i })
    await userEvent.type(ta, '\nhand-written body')

    const nameInput = screen.getByRole('textbox', { name: /^skill name$/i })
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'foo')

    const taAfter = screen.getByRole('textbox', { name: /skill · foo/i }) as HTMLTextAreaElement
    expect(taAfter.value).toContain('hand-written body')
    expect(taAfter.value).toContain('name: my-skill')
    expect(taAfter.value).not.toContain('name: foo')
  })

  it('routes an unsaved close through confirm(); confirming closes it', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const { onClose } = setup()
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmore')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('declining the confirm keeps the editor open with the typed changes intact', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { onClose } = setup()
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmore')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(await screen.findByRole('textbox', { name: /skill · rca/i })).toHaveValue(
      `${valid}\nmore`
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Draft against an edited buffer opens the diff instead of replacing the buffer', async () => {
    setup({ mode: 'create', name: 'rca', load: undefined })
    const ta = screen.getByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nhand-written')
    await userEvent.type(screen.getByRole('textbox', { name: /describe/i }), 'more detail')
    await userEvent.click(screen.getByRole('button', { name: /^draft/i }))

    await screen.findByRole('button', { name: /^accept$/i })
    await userEvent.click(screen.getByRole('button', { name: /^discard$/i }))

    expect(
      (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
    ).toContain('hand-written')
  })

  it('typing during an in-flight Draft is not lost: resolution routes to a diff, not a replace', async () => {
    let resolveDraft!: (v: { content: string }) => void
    const deferred = new Promise<{ content: string }>((res) => {
      resolveDraft = res
    })
    window.argus.authoring.draft = vi.fn().mockReturnValue(deferred)
    setup({ mode: 'create', name: 'rca', load: undefined })

    await userEvent.type(screen.getByRole('textbox', { name: /describe/i }), 'root cause work')
    await userEvent.click(screen.getByRole('button', { name: /^draft/i }))

    const ta = screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement
    await userEvent.type(ta, 'typed while pending')

    resolveDraft({ content: valid })

    // Arrives as a diff (Accept/Discard), not a silent replace of the buffer.
    await screen.findByRole('button', { name: /^discard$/i })
    await userEvent.click(screen.getByRole('button', { name: /^discard$/i }))

    // Discard just clears the proposal; the buffer itself was never touched by the
    // late resolution, so the typed text is still there.
    expect(
      (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
    ).toContain('typed while pending')
  })

  it('renaming in create mode clears a previously shown error banner', async () => {
    setup({ mode: 'create', name: 'my-skill', load: undefined })
    const ta = screen.getByRole('textbox', { name: /skill · my-skill/i })
    await userEvent.type(ta, '\nhand-written body')

    const nameInput = screen.getByRole('textbox', { name: /^skill name$/i })
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'foo')

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/must match the skill folder/i)

    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'my-skill')

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closing with a pending diff routes through confirm(); declining keeps the diff open', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { onClose } = setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await screen.findByRole('button', { name: /^discard$/i })

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(await screen.findByRole('button', { name: /^discard$/i })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a rejected load shows a terminal error state instead of a permanent Loading', async () => {
    setup({ load: () => Promise.reject(new Error('boom')) })

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/^loading/i)).toBeNull()
  })

  it('does not close after a successful save if the buffer changed while saving, and adopts the new hash so the next save succeeds', async () => {
    let resolveSave!: (hash: string) => void
    const deferred = new Promise<string>((res) => {
      resolveSave = res
    })
    const save = vi.fn().mockReturnValueOnce(deferred).mockResolvedValue('h3')
    const onClose = vi.fn()
    render(
      <AssetEditor
        kind="skill"
        name="rca"
        mode="edit"
        load={async () => ({ content: valid, hash: 'h1' })}
        save={save}
        onClose={onClose}
      />
    )
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmore')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // Typed while the save round trip was still in flight — the textarea stays editable
    // during busy on purpose, so this must not be silently lost.
    await userEvent.type(ta, ' extra')

    resolveSave('h2')

    expect(await screen.findByRole('alert')).toHaveTextContent(/kept typing/i)
    expect(
      (screen.getByRole('textbox', { name: /skill · rca/i }) as HTMLTextAreaElement).value
    ).toBe(`${valid}\nmore extra`)
    expect(onClose).not.toHaveBeenCalled()

    // The regression: baseHash must have been adopted from the first save's result ('h2'),
    // not left at the original load hash ('h1') — otherwise this second save is guaranteed
    // to throw a spurious "changed on disk" conflict caused by the app's own first save.
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        name: 'rca',
        content: `${valid}\nmore extra`,
        baseHash: 'h2'
      })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('closes normally after a successful save when the buffer did not change while saving', async () => {
    const { save, onClose } = setup()
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, '\nmore')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('turning Preview on in create mode hides Draft; turning it off restores it', async () => {
    setup({ mode: 'create', name: 'rca', load: undefined })
    expect(screen.getByRole('button', { name: /^draft/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }))
    expect(screen.queryByRole('button', { name: /^draft/i })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    expect(screen.getByRole('button', { name: /^draft/i })).toBeInTheDocument()
  })

  it('the create-mode name input is disabled while a diff is pending', async () => {
    setup({ mode: 'create', name: 'rca', load: undefined })
    expect(screen.getByRole('textbox', { name: /^skill name$/i })).not.toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await screen.findByRole('button', { name: /^discard$/i })

    expect(screen.getByRole('textbox', { name: /^skill name$/i })).toBeDisabled()
  })

  it('create mode: typing only the name still confirms before closing', async () => {
    const { onClose } = setup({ mode: 'create', name: 'new-skill', load: undefined })
    await userEvent.clear(screen.getByRole('textbox', { name: /skill name/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /skill name/i }), 'renamed')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalled()
  })

  it('create mode: typing only the describe box still confirms before closing', async () => {
    const { onClose } = setup({ mode: 'create', name: 'new-skill', load: undefined })
    await userEvent.type(screen.getByRole('textbox', { name: /describe it/i }), 'root cause work')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalled()
  })

  it('create mode: declining the confirm keeps the editor open with the text intact', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { onClose } = setup({ mode: 'create', name: 'new-skill', load: undefined })
    await userEvent.type(screen.getByRole('textbox', { name: /describe it/i }), 'keep me')
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: /describe it/i })).toHaveValue('keep me')
  })

  it('create mode: an untouched editor closes with no confirm', async () => {
    const { onClose } = setup({ mode: 'create', name: 'new-skill', load: undefined })
    await screen.findByRole('textbox', { name: /skill · new-skill/i })
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(confirm).not.toHaveBeenCalled()
  })

  it('an in-flight assist confirms before closing, and Cancel is reachable during it', async () => {
    let resolveImprove: (v: { content: string }) => void = () => {}
    window.argus.authoring.improve = vi.fn(
      () => new Promise<{ content: string }>((r) => (resolveImprove = r))
    )
    const { onClose } = setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))

    const cancel = screen.getByRole('button', { name: /^cancel$/i })
    expect(cancel).toBeEnabled()
    await userEvent.click(cancel)
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    resolveImprove({ content: 'late' })
  })

  it('labels the assist controls with the resolved provider and model', async () => {
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    expect(screen.getByText('via claude-agent-sdk · claude-sonnet-4-5')).toBeInTheDocument()
  })

  it('shows the resolver reason and disables the assist when no provider resolves', async () => {
    vi.mocked(useAssistProvider).mockReturnValue({
      ok: false,
      reason: 'no provider configured for distillation'
    })
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    expect(screen.getByText('no provider configured for distillation')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^improve/i })).toBeDisabled()
  })

  it('leaves the assist enabled while settings have not loaded', async () => {
    vi.mocked(useAssistProvider).mockReturnValue(null)
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    expect(screen.getByRole('button', { name: /^improve/i })).toBeEnabled()
  })

  it('shows the elapsed row while an assist is in flight and hides it after', async () => {
    let resolveImprove: (v: { content: string }) => void = () => {}
    window.argus.authoring.improve = vi.fn(
      () => new Promise<{ content: string }>((r) => (resolveImprove = r))
    )
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    // Query by text, not by role="status": the validation-warning spans in this component
    // also carry role="status", so getByRole would be ambiguous the moment a fixture has a
    // warning. AssistProgress's own test asserts the role, where it is isolated.
    expect(await screen.findByText(/Improving…/)).toBeInTheDocument()

    resolveImprove({ content: `${valid}\nimproved` })
    await screen.findByRole('button', { name: /^accept$/i })
    expect(screen.queryByText(/Improving…/)).toBeNull()
  })

  it('Stop waiting abandons the result: no diff opens and the buffer is untouched', async () => {
    let resolveImprove: (v: { content: string }) => void = () => {}
    window.argus.authoring.improve = vi.fn(
      () => new Promise<{ content: string }>((r) => (resolveImprove = r))
    )
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^stop waiting$/i }))

    resolveImprove({ content: 'THIS MUST NOT APPEAR' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: /skill · rca/i })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull()
    expect(screen.getByRole('textbox', { name: /skill · rca/i })).toHaveValue(valid)
    expect(screen.queryByText('THIS MUST NOT APPEAR')).toBeNull()
  })

  it('Stop waiting re-enables Improve so a second run is possible', async () => {
    let resolveImprove: (v: { content: string }) => void = () => {}
    window.argus.authoring.improve = vi.fn(
      () => new Promise<{ content: string }>((r) => (resolveImprove = r))
    )
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /^improve/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^stop waiting$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^improve/i })).toBeEnabled())
    resolveImprove({ content: 'ignored' })
  })

  it('renders a host-supplied banner', async () => {
    // Queried by text, not by role: AssetEditor already gives its own validation *warnings*
    // role="status", so a role query here would be ambiguous the moment a fixture warns.
    setup({ banner: <div role="status">Restored unsaved draft from 3:42pm.</div> })
    expect(await screen.findByText(/Restored unsaved draft/)).toBeInTheDocument()
  })

  it('renders a host-supplied status in the window header', async () => {
    setup({ chrome: 'window', status: <span>Draft · 3:42 PM</span> })
    expect(await screen.findByText('Draft · 3:42 PM')).toBeInTheDocument()
  })

  it('opens a restored draft already dirty', async () => {
    const onDirtyChange = vi.fn()
    setup({
      onDirtyChange,
      load: async () => ({ content: valid, hash: 'h1', pristine: false })
    })
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
  })

  it('does not report a draft change for a file that was only opened', async () => {
    const onChange = vi.fn()
    setup({ draft: { onChange } })
    await screen.findByRole('textbox', { name: /skill · rca/i })
    // A draft written on load would mean every file you merely LOOK at gets one.
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(valid))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports every buffer change to the draft host', async () => {
    const onChange = vi.fn()
    setup({ draft: { onChange } })
    const ta = await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.type(ta, 'X')
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(`${valid}X`, 'rca'))
  })

  it('reports a create-mode rename to the draft host even before the body is touched', async () => {
    const onChange = vi.fn()
    render(
      <AssetEditor
        kind="skill"
        name="new-skill"
        mode="create"
        draft={{ onChange }}
        save={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await userEvent.type(screen.getByLabelText('skill name'), '2')
    // A typed name is real work (see hasUnsavedWork), and §4.5's re-key needs to see it.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.any(String), 'new-skill2'))
  })

  it('hands the saved content and the new hash to onSaved', async () => {
    const onSaved = vi.fn()
    setup({ onSaved, save: vi.fn().mockResolvedValue('h2') })
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('rca', valid, 'h2'))
  })

  it('shows an accepted assist as a two-column diff', async () => {
    setup()
    await screen.findByRole('textbox', { name: /skill · rca/i })
    await userEvent.click(screen.getByRole('button', { name: /improve/i }))
    expect(
      await screen.findByRole('group', { name: /current compared with proposed/i })
    ).toBeInTheDocument()
  })
})
