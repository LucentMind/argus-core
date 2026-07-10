import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecretStore, type SecretCrypto } from '../secrets'
import { secretsPath } from '../paths'

const fakeCrypto = (available = true): SecretCrypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => {
    const t = b.toString('utf8')
    if (!t.startsWith('enc:')) throw new Error('bad ciphertext')
    return t.slice(4)
  }
})

let tmp: string, argusHome: string, store: SecretStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-secrets-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  store?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('SecretStore', () => {
  it('set/has/resolve/delete round-trip; file holds only base64 ciphertext', () => {
    store = new SecretStore(argusHome, fakeCrypto())
    expect(store.has('t1')).toBe(false)
    store.set('t1', 'sesame')
    expect(store.has('t1')).toBe(true)
    expect(store.resolve('t1')).toBe('sesame')
    const raw = fs.readFileSync(secretsPath(argusHome), 'utf8')
    expect(raw).not.toContain('sesame')
    expect(JSON.parse(raw).t1).toBe(Buffer.from('enc:sesame', 'utf8').toString('base64'))
    store.delete('t1')
    expect(store.has('t1')).toBe(false)
    expect(JSON.parse(fs.readFileSync(secretsPath(argusHome), 'utf8'))).toEqual({})
  })

  it('persists across instances', () => {
    store = new SecretStore(argusHome, fakeCrypto())
    store.set('a', 'x')
    store.close()
    store = new SecretStore(argusHome, fakeCrypto())
    expect(store.has('a')).toBe(true)
    expect(store.resolve('a')).toBe('x')
  })

  it('resolve of a missing name → null; undecryptable ciphertext → null', () => {
    store = new SecretStore(argusHome, fakeCrypto())
    expect(store.resolve('nope')).toBeNull()
    fs.mkdirSync(path.dirname(secretsPath(argusHome)), { recursive: true })
    fs.writeFileSync(
      secretsPath(argusHome),
      JSON.stringify({ bad: Buffer.from('garbage').toString('base64') }),
      'utf8'
    )
    store.close()
    store = new SecretStore(argusHome, fakeCrypto())
    expect(store.has('bad')).toBe(true)
    expect(store.resolve('bad')).toBeNull()
  })

  it('encryption unavailable → set throws with a clear error; reads still work', () => {
    store = new SecretStore(argusHome, fakeCrypto(false))
    expect(store.available()).toBe(false)
    expect(() => store.set('t', 'v')).toThrow(/secret store unavailable/)
    expect(store.has('t')).toBe(false)
  })

  it('broken secrets.json → loadError + empty store; file untouched until a save', () => {
    fs.mkdirSync(path.dirname(secretsPath(argusHome)), { recursive: true })
    fs.writeFileSync(secretsPath(argusHome), '{broken', 'utf8')
    store = new SecretStore(argusHome, fakeCrypto())
    expect(store.loadError()).toBeTruthy()
    expect(store.has('anything')).toBe(false)
    expect(fs.readFileSync(secretsPath(argusHome), 'utf8')).toBe('{broken')
    store.set('t', 'v') // explicit save replaces the broken file
    expect(store.loadError()).toBeNull()
    expect(JSON.parse(fs.readFileSync(secretsPath(argusHome), 'utf8')).t).toBeTruthy()
  })
})
