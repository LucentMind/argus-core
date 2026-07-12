import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { verifyBundleChecksums } from '../verify'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-verify-'))
})

/** Mirror the 2a packager's CHECKSUMS format over the current tree (sha256sum-style, LF, sorted). */
function writeValidChecksums(root: string): void {
  const rels: string[] = []
  const walk = (rel: string): void => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(childRel)
      else if (ent.isFile() && childRel !== 'CHECKSUMS') rels.push(childRel)
    }
  }
  walk('')
  rels.sort()
  const body = rels
    .map((rel) => {
      const hex = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, ...rel.split('/'))))
        .digest('hex')
      return `${hex}  ${rel}\n`
    })
    .join('')
  fs.writeFileSync(path.join(root, 'CHECKSUMS'), body)
}

function seedBundle(): void {
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), '{"id":"sample"}')
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'argus-demo'), 'binary-bytes')
  writeValidChecksums(dir)
}

describe('verifyBundleChecksums', () => {
  it('passes for an intact bundle', () => {
    seedBundle()
    expect(verifyBundleChecksums(dir)).toEqual({ ok: true, errors: [] })
  })

  it('fails when CHECKSUMS is missing', () => {
    fs.writeFileSync(path.join(dir, 'argus-pack.json'), '{}')
    const r = verifyBundleChecksums(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/CHECKSUMS/)
  })

  it('detects a tampered file (hash mismatch)', () => {
    seedBundle()
    fs.writeFileSync(path.join(dir, 'bin', 'argus-demo'), 'TAMPERED')
    const r = verifyBundleChecksums(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/bin\/argus-demo/)
  })

  it('detects a file present but not listed', () => {
    seedBundle()
    fs.writeFileSync(path.join(dir, 'sneaky.txt'), 'x')
    const r = verifyBundleChecksums(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/sneaky\.txt/)
  })

  it('detects a listed file that is missing', () => {
    seedBundle()
    fs.rmSync(path.join(dir, 'bin', 'argus-demo'))
    const r = verifyBundleChecksums(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/bin\/argus-demo/)
  })

  it('rejects unsafe-path and malformed-hex CHECKSUMS entries (zip-slip guard)', () => {
    fs.writeFileSync(path.join(dir, 'argus-pack.json'), '{"id":"sample"}')
    const validHex = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'argus-pack.json')))
      .digest('hex')
    const evilHex = 'a'.repeat(64)
    const body =
      `${validHex}  argus-pack.json\n` +
      `${evilHex}  ../evil.txt\n` +
      `${evilHex}  /etc/passwd\n` +
      `${'z'.repeat(64)}  bad-hex.txt\n`
    fs.writeFileSync(path.join(dir, 'CHECKSUMS'), body)
    const r = verifyBundleChecksums(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/malformed CHECKSUMS entry/)
    expect(r.errors.join()).toMatch(/\.\.\/evil\.txt/)
    expect(r.errors.join()).toMatch(/\/etc\/passwd/)
    expect(r.errors.join()).toMatch(/bad-hex\.txt/)
  })
})
