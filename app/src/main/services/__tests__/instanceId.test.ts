import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { readOrCreateInstanceId } from '../instanceId'

describe('readOrCreateInstanceId', () => {
  it('creates once, reuses, and heals a corrupt file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-iid-'))
    const a = readOrCreateInstanceId(home)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(readOrCreateInstanceId(home)).toBe(a)
    const file = path.join(home, 'config', 'instance-id.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ instanceId: a })
    fs.writeFileSync(file, '{not json')
    const b = readOrCreateInstanceId(home)
    expect(b).not.toBe(a)
    expect(readOrCreateInstanceId(home)).toBe(b)
  })
})
