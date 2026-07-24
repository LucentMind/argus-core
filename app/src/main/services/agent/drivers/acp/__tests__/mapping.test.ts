import { it, expect } from 'vitest'
import { synthesizeAcpPermission } from '../mapping'
import { ACP_TOOL_TAXONOMY } from '../taxonomy'
import { classifyToolCall } from '../../../risk'

it('maps ACP permission kinds to canonical tool + input', () => {
  expect(synthesizeAcpPermission('execute', { command: 'rm -rf /' }))
    .toEqual({ name: 'shell', input: { command: 'rm -rf /' } })
  expect(synthesizeAcpPermission('read', { path: '/a' }))
    .toEqual({ name: 'read', input: { file_path: '/a' } })
  expect(synthesizeAcpPermission('edit', { path: '/a' }))
    .toEqual({ name: 'write', input: { file_path: '/a' } })
})

it('unknown ACP kind fails closed at HIGH ask', () => {
  const { name, input } = synthesizeAcpPermission('mystery', {})
  const v = classifyToolCall(name, input, {
    caseDir: '/case', workspaceRoots: [], readonlyRoots: [], taxonomy: ACP_TOOL_TAXONOMY
  })
  expect(v.action).toBe('ask')
  expect(v.risk).toBe('HIGH')
})
