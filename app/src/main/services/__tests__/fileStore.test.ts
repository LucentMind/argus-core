import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonFileStore } from '../fileStore'

let tmp: string, file: string, store: JsonFileStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fstore-'))
  file = path.join(tmp, 'config', 'settings.json')
  store = new JsonFileStore(file)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('JsonFileStore', () => {
  it('load: missing file → empty object, no error', () => {
    expect(store.load()).toEqual({ data: {}, error: null })
  })

  it('load: strips a UTF-8 BOM before parsing', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '﻿{"a":1}', 'utf8')
    expect(store.load()).toEqual({ data: { a: 1 }, error: null })
  })

  it('load: invalid JSON → empty object + error message', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{oops', 'utf8')
    const r = store.load()
    expect(r.data).toEqual({})
    expect(r.error).toBeTruthy()
  })

  it('write: creates dirs, writes BOM-free, atomic (no .tmp left), round-trips', () => {
    store.write({ agent: { maxSessions: 5 } })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    expect(fs.existsSync(file + '.tmp')).toBe(false)
    expect(store.load().data).toEqual({ agent: { maxSessions: 5 } })
  })

  it('watch: fires on external change, suppresses own writes', async () => {
    store.write({ a: 1 })
    let fired = 0
    store.watch(() => fired++)
    // self-write: same content path — must not fire
    store.write({ a: 2 })
    await new Promise((r) => setTimeout(r, 500))
    expect(fired).toBe(0)
    // external change
    fs.writeFileSync(file, '{"a":3}', 'utf8')
    await vi.waitFor(() => expect(fired).toBeGreaterThan(0), { timeout: 3000 })
  })
})
