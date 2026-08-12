import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInstanceId } from '../instanceId'

let home: string
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('ensureInstanceId', () => {
  it('generates once and returns the same id forever after', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
    const first = ensureInstanceId(home)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(ensureInstanceId(home)).toBe(first)
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'config', 'instance-id.json'), 'utf8')
    ) as { id: string }
    expect(onDisk.id).toBe(first)
  })

  it('regenerates when the file is corrupt rather than crashing', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config', 'instance-id.json'), 'not json')
    expect(ensureInstanceId(home)).toMatch(/^[0-9a-f-]{36}$/)
  })
})
