// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import { PageTree } from '../references/PageTree'
import type { SpaceConfig, TreeNodeVM } from '../../../../shared/referenceSync'

const root: TreeNodeVM = {
  id: '100',
  title: 'Home',
  version: 1,
  lastModified: '2026-07-01T00:00:00.000Z',
  hasChildren: true,
  isNew: false,
  outdated: false
}
const kids: TreeNodeVM[] = [
  {
    id: '101',
    title: 'Routing',
    version: 3,
    lastModified: '2026-07-01T00:00:00.000Z',
    hasChildren: true,
    isNew: true,
    outdated: false
  },
  {
    id: '102',
    title: 'Old corner',
    version: 1,
    lastModified: '2024-01-01T00:00:00.000Z',
    hasChildren: false,
    isNew: false,
    outdated: true
  }
]
const space: SpaceConfig = {
  key: 'N',
  name: 'N',
  homepageId: '100',
  includeRoots: ['100'],
  excludedSubtrees: ['102'],
  routingRules: []
}

it('lazy-loads root children, renders badges, reflects tri-state', async () => {
  const load = vi.fn(async (id: string) => (id === '100' ? kids : []))
  const onToggle = vi.fn()
  render(<PageTree space={space} root={root} loadChildren={load} onToggle={onToggle} />)
  await waitFor(() => expect(load).toHaveBeenCalledWith('100'))
  expect(await screen.findByText('Routing')).toBeTruthy()
  expect(screen.getByText('NEW')).toBeTruthy()
  expect(screen.getByText('outdated?')).toBeTruthy()
  const rootBox = screen.getByRole('checkbox', { name: 'select · Home' }) as HTMLInputElement
  expect(rootBox.checked).toBe(true)
  const excluded = screen.getByRole('checkbox', { name: 'select · Old corner' }) as HTMLInputElement
  expect(excluded.checked).toBe(false)
})

it('toggling reports the node with nearest-first ancestors; collapsed nodes need no load', async () => {
  const load = vi.fn(async (id: string) => (id === '100' ? kids : []))
  const onToggle = vi.fn()
  render(<PageTree space={space} root={root} loadChildren={load} onToggle={onToggle} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'select · Routing' }))
  expect(onToggle).toHaveBeenCalledWith('101', ['100'])
  expect(load).toHaveBeenCalledTimes(1) // '101' children never loaded
})

it('a parent with an excluded loaded child shows indeterminate', async () => {
  const uncheckedRootSpace: SpaceConfig = { ...space, includeRoots: ['101'], excludedSubtrees: [] }
  const load = vi.fn(async (id: string) => (id === '100' ? kids : []))
  render(
    <PageTree
      space={uncheckedRootSpace}
      root={{ ...root }}
      loadChildren={load}
      onToggle={vi.fn()}
    />
  )
  await screen.findByText('Routing')
  const rootBox = screen.getByRole('checkbox', { name: 'select · Home' }) as HTMLInputElement
  expect(rootBox.checked).toBe(false)
  expect(rootBox.indeterminate).toBe(true)
})
