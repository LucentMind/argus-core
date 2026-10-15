import { describe, it, expect } from 'vitest'
import { MAX_CUSTOM_MODEL_LENGTH, parseModelCommand, resolveModelCommand } from '../modelCommand'
import type { CatalogModel } from '../drivers'

// The picker rows a Claude session can see once a runtime catalog has loaded: alias-keyed rows
// carrying their wire slug as `resolvedModel`, built-ins keyed by the wire slug itself.
const ROWS: CatalogModel[] = [
  { slug: 'opus', name: 'Claude Opus 5.5', resolvedModel: 'claude-opus-5-5' },
  { slug: 'sonnet', name: 'Claude Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { slug: 'my-finetune', name: 'my-finetune', isCustom: true }
]

describe('parseModelCommand', () => {
  it('recognises /model with and without an argument', () => {
    expect(parseModelCommand('/model')).toEqual({ arg: '' })
    expect(parseModelCommand('/model   ')).toEqual({ arg: '' })
    expect(parseModelCommand('/model claude-opus-4-8')).toEqual({ arg: 'claude-opus-4-8' })
    expect(parseModelCommand('  /model   Claude Opus 4.8  ')).toEqual({ arg: 'Claude Opus 4.8' })
  })

  it('leaves everything else alone', () => {
    expect(parseModelCommand('/models')).toBeNull()
    expect(parseModelCommand('/modelx foo')).toBeNull()
    expect(parseModelCommand('please /model foo')).toBeNull()
    expect(parseModelCommand('model foo')).toBeNull()
    expect(parseModelCommand('/compact')).toBeNull()
  })

  it('does not treat a multi-line message as the command', () => {
    expect(parseModelCommand('/model opus\nand then fix the bug')).toBeNull()
  })
})

describe('resolveModelCommand', () => {
  it('matches a CLI alias, a wire slug, and a dated or 1M form of one', () => {
    expect(resolveModelCommand('opus', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'opus' }
    })
    expect(resolveModelCommand('claude-sonnet-5-5', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'sonnet' }
    })
    expect(resolveModelCommand('claude-sonnet-5-5[1m]', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'sonnet' }
    })
    expect(resolveModelCommand('claude-haiku-4-5-20251001', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'claude-haiku-4-5' }
    })
  })

  it('matches the display name, ignoring case', () => {
    expect(resolveModelCommand('Claude Opus 4.8', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'claude-opus-4-8' }
    })
    expect(resolveModelCommand('claude opus 5.5', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'opus' }
    })
    expect(resolveModelCommand('OPUS', ROWS)).toMatchObject({ kind: 'match' })
  })

  it('matches a row that Settings has hidden or the picker has pruned — the caller passes every row', () => {
    expect(resolveModelCommand('claude-opus-4-8', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'claude-opus-4-8' }
    })
  })

  it('matches an existing custom model rather than offering to add it again', () => {
    expect(resolveModelCommand('my-finetune', ROWS)).toMatchObject({
      kind: 'match',
      row: { slug: 'my-finetune' }
    })
  })

  it('treats an unknown, well-formed id as a custom model, keeping what was typed', () => {
    expect(resolveModelCommand('claude-sonnet-4-5', ROWS)).toEqual({
      kind: 'custom',
      slug: 'claude-sonnet-4-5'
    })
    // an explicit [1m] is a deliberate choice for a custom id (see `customModelRows`)
    expect(resolveModelCommand('claude-sonnet-4-5[1m]', ROWS)).toEqual({
      kind: 'custom',
      slug: 'claude-sonnet-4-5[1m]'
    })
    expect(resolveModelCommand('us.anthropic.claude-sonnet-4-5-v1:0', ROWS)).toMatchObject({
      kind: 'custom'
    })
  })

  it('rejects an empty argument, whitespace inside an unknown id, and an over-long id', () => {
    expect(resolveModelCommand('', ROWS)).toMatchObject({ kind: 'invalid' })
    expect(resolveModelCommand('claude sonnet 9', ROWS)).toMatchObject({ kind: 'invalid' })
    expect(resolveModelCommand('x'.repeat(MAX_CUSTOM_MODEL_LENGTH + 1), ROWS)).toMatchObject({
      kind: 'invalid'
    })
    expect(resolveModelCommand('x'.repeat(MAX_CUSTOM_MODEL_LENGTH), ROWS)).toMatchObject({
      kind: 'custom'
    })
  })

  it('prefers an exact slug over a name that happens to equal another slug', () => {
    const rows: CatalogModel[] = [
      { slug: 'a', name: 'b' },
      { slug: 'b', name: 'c' }
    ]
    expect(resolveModelCommand('b', rows)).toMatchObject({ kind: 'match', row: { slug: 'b' } })
  })
})
