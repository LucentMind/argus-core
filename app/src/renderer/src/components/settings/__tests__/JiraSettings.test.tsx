// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JiraSettings } from '../JiraSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'
import type { JiraLinkType } from '../../../../../shared/jira'

/**
 * The clone-link-type editor, moved off ConnectorsSettings when it became chips plus a picker
 * (user-directed, 2026-08-21). The three cases that came with it are the reset idiom, the
 * append, and the remove; the rest are new and cover the picker itself.
 */
function payload(types?: string[]): SettingsPayload {
  const s = defaultSettings()
  return {
    settings: { ...s, jira: { ...s.jira, ...(types ? { cloneLinkTypes: types } : {}) } },
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

const CATALOG: JiraLinkType[] = [
  { id: '10000', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
  { id: '10001', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  { id: '10002', name: 'Kopiert' }
]

let linkTypes: ReturnType<typeof vi.fn>

beforeEach(() => {
  settingsStore.reset()
  linkTypes = vi.fn().mockResolvedValue({ ok: true, value: CATALOG })
  window.argus = {
    settings: { patch: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    jira: { linkTypes }
  } as never
})

describe('JiraSettings clone link types', () => {
  it('lists the configured types as chips, not as a column of inputs', async () => {
    render(<JiraSettings payload={payload(['Cloners', 'Kopiert'])} />)
    await waitFor(() => expect(linkTypes).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Remove Cloners' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Kopiert' })).toBeInTheDocument()
    // No editable field per entry any more — the name has to match Jira exactly, so it is
    // picked, not typed.
    expect(screen.queryByLabelText('Clone link type Cloners')).toBeNull()
    expect(screen.getByText(/go back to Jira's default \("Cloners"\)/)).toBeInTheDocument()
  })

  it("offers the site's own link types, minus the ones already chosen", async () => {
    render(<JiraSettings payload={payload(['Cloners'])} />)
    await waitFor(() => expect(linkTypes).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: 'Add clone link type' }))
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Kopiert' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Cloners' })).toBeNull()
  })

  it('picking one appends it to the list', async () => {
    render(<JiraSettings payload={payload(['Cloners'])} />)
    await waitFor(() => expect(linkTypes).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: 'Add clone link type' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      jira: { cloneLinkTypes: ['Cloners', 'Duplicate'] }
    })
  })

  it('still lets a name be typed, for a site whose catalogue cannot be read', async () => {
    linkTypes.mockResolvedValue({ ok: false, code: 'auth', message: 'not authorized' })
    render(<JiraSettings payload={payload(['Cloners'])} />)
    expect(await screen.findByText(/could not be listed/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add clone link type' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Type a name…' }))
    await userEvent.type(await screen.findByLabelText('New clone link type'), 'Klont')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      jira: { cloneLinkTypes: ['Cloners', 'Klont'] }
    })
  })

  it('refuses a duplicate that differs only in case — cloneLinksOf compares that way too', async () => {
    render(<JiraSettings payload={payload(['Cloners'])} />)
    await waitFor(() => expect(linkTypes).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: 'Add clone link type' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Type a name…' }))
    await userEvent.type(await screen.findByLabelText('New clone link type'), 'cloners')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  // NOT `[]`: an empty array does not equal the non-empty default, so stripDefaults would keep
  // it on disk and discovery would silently match nothing. `null` deletes the key and the next
  // parse re-seeds ["Cloners"].
  it('patches null rather than an empty list when the last entry is removed', async () => {
    render(<JiraSettings payload={payload(['Cloners'])} />)
    await waitFor(() => expect(linkTypes).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: 'Remove Cloners' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ jira: { cloneLinkTypes: null } })
  })
})
