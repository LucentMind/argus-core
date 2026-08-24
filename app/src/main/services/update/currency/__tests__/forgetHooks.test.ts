import { describe, it, expect, vi } from 'vitest'
import { createForgetHooks } from '../forgetHooks'

function build(): {
  hooks: ReturnType<typeof createForgetHooks>
  forget: ReturnType<typeof vi.fn>
} {
  const forget = vi.fn()
  return { hooks: createForgetHooks({ forget }), forget }
}

describe('createForgetHooks', () => {
  it('forgets a pack by its bare id — the key packsAdapter emits', () => {
    const { hooks, forget } = build()
    hooks.packInstalled('code-graph')
    expect(forget).toHaveBeenCalledWith('code-graph')
  })

  it('uses the same bare-id key for an uninstall and an update', () => {
    const { hooks, forget } = build()
    hooks.packUninstalled('code-graph')
    hooks.packUpdated('code-graph')
    expect(forget).toHaveBeenNthCalledWith(1, 'code-graph')
    expect(forget).toHaveBeenNthCalledWith(2, 'code-graph')
  })

  it('forgets a hive skill by kind/name — the key hiveAdapter emits', () => {
    const { hooks, forget } = build()
    hooks.hiveInstalled('skill', 'triage')
    expect(forget).toHaveBeenCalledWith('skill/triage')
  })

  it('forgets a hive reference by kind/name, including a nested one', () => {
    const { hooks, forget } = build()
    hooks.hiveUninstalled('reference', 'confluence/foo.md')
    expect(forget).toHaveBeenCalledWith('reference/confluence/foo.md')
  })
})
