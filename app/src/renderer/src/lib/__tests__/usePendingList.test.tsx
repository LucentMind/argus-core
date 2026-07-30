// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { usePendingList } from '../usePendingList'

describe('usePendingList', () => {
  it('adds entries carrying the caller-supplied name', () => {
    const { result } = renderHook(() => usePendingList())
    act(() => {
      result.current.add('huge.binlog')
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].name).toBe('huge.binlog')
    expect(result.current.items[0].error).toBeUndefined()
  })

  it('gives every entry a distinct id, including within one batch', () => {
    const { result } = renderHook(() => usePendingList())
    act(() => {
      result.current.add('a.log')
      result.current.add('b.log')
    })
    const [a, b] = result.current.items
    expect(result.current.items).toHaveLength(2)
    expect(a.id).not.toBe(b.id)
  })

  it('resolve drops only the named ids', () => {
    const { result } = renderHook(() => usePendingList())
    let keep = ''
    act(() => {
      const drop = result.current.add('gone.log')
      keep = result.current.add('stays.log')
      result.current.resolve([drop])
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe(keep)
  })

  it('fail retains the entry and attaches the message', () => {
    const { result } = renderHook(() => usePendingList())
    act(() => {
      const id = result.current.add('locked.log')
      result.current.fail([id], 'EACCES: locked')
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].error).toBe('EACCES: locked')
  })

  it('dismiss removes one entry', () => {
    const { result } = renderHook(() => usePendingList())
    act(() => {
      const id = result.current.add('locked.log')
      result.current.fail([id], 'nope')
      result.current.dismiss(id)
    })
    expect(result.current.items).toHaveLength(0)
  })
})
