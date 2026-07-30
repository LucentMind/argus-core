// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetEditor } from '../AssetEditor'

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
  const save = vi.fn().mockResolvedValue(undefined)
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
  vi.stubGlobal('argus', undefined)
  window.argus = {
    authoring: {
      draft: vi.fn().mockResolvedValue({ content: valid }),
      improve: vi.fn().mockResolvedValue({ content: `${valid}\nimproved` })
    }
  } as never
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
})
