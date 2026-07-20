// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { attachFiles, screenshotName, MAX_ATTACHMENT_BYTES } from '../attachFiles'
import { composerAttachments } from '../composerAttachments'

const ingestContent = vi.fn()

function fileOf(name: string, type: string, size = 4): File {
  const f = new File([new Uint8Array(size)], name, { type })
  // jsdom's File does not implement arrayBuffer in all versions — pin it
  Object.defineProperty(f, 'arrayBuffer', {
    value: async () => new ArrayBuffer(size)
  })
  return f
}

beforeEach(() => {
  composerAttachments.clear('A-1', 1)
  ingestContent.mockReset()
  ingestContent.mockImplementation(async (_slug: string, fileName: string) => ({
    record: { relPath: `evidence/${fileName}` },
    deduped: false
  }))
  window.argus = { evidence: { ingestContent } } as never
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

describe('screenshotName', () => {
  it('builds a sortable timestamp name from the mime type', () => {
    const d = new Date(2026, 6, 20, 14, 30, 52)
    expect(screenshotName('image/png', d)).toBe('screenshot-2026-07-20-143052.png')
    expect(screenshotName('image/jpeg', d)).toBe('screenshot-2026-07-20-143052.jpg')
    expect(screenshotName('image/webp', d)).toBe('screenshot-2026-07-20-143052.webp')
  })

  it('falls back to .bin for an unrecognised mime type', () => {
    expect(screenshotName('application/x-weird', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'screenshot-2026-01-02-030405.bin'
    )
  })
})

describe('attachFiles', () => {
  it('ingests a named file and marks the attachment ready', async () => {
    await attachFiles('A-1', 1, [fileOf('log.txt', 'text/plain')])
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('ready')
    expect(a.relPath).toBe('evidence/log.txt')
    expect(ingestContent).toHaveBeenCalledWith('A-1', 'log.txt', expect.any(Uint8Array))
  })

  it('generates a timestamp name for a clipboard image with no filename', async () => {
    await attachFiles('A-1', 1, [fileOf('', 'image/png')])
    expect(ingestContent.mock.calls[0][1]).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/)
  })

  it('attaches a preview url for images only', async () => {
    await attachFiles('A-1', 1, [fileOf('a.png', 'image/png'), fileOf('b.txt', 'text/plain')])
    const [img, txt] = composerAttachments.get('A-1', 1)
    expect(img.previewUrl).toBe('blob:preview')
    expect(txt.previewUrl).toBeUndefined()
  })

  it('rejects a file over the size cap without calling ingest', async () => {
    const big = fileOf('huge.bin', 'application/octet-stream', 1)
    Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
    await attachFiles('A-1', 1, [big])
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('error')
    expect(a.error).toMatch(/25 MB/)
    expect(ingestContent).not.toHaveBeenCalled()
  })

  it('marks the attachment as error when ingest rejects, without throwing', async () => {
    ingestContent.mockRejectedValueOnce(new Error('disk full'))
    await expect(attachFiles('A-1', 1, [fileOf('a.png', 'image/png')])).resolves.toBeUndefined()
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('error')
    expect(a.error).toBe('disk full')
  })

  it('marks the attachment as error when ingest rejects with a non-Error value, without throwing', async () => {
    ingestContent.mockRejectedValueOnce(null)
    await expect(attachFiles('A-1', 1, [fileOf('a.png', 'image/png')])).resolves.toBeUndefined()
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('error')
    expect(a.error).toBeTypeOf('string')
    expect(a.error).not.toHaveLength(0)
  })

  it('produces a usable message when ingest rejects with a plain string', async () => {
    ingestContent.mockRejectedValueOnce('disk full')
    await attachFiles('A-1', 1, [fileOf('a.png', 'image/png')])
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('error')
    expect(a.error).toBe('disk full')
  })

  it('continues past a failure to ingest the remaining files', async () => {
    ingestContent.mockRejectedValueOnce(new Error('nope'))
    await attachFiles('A-1', 1, [fileOf('a.png', 'image/png'), fileOf('b.png', 'image/png')])
    const [a, b] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('error')
    expect(b.status).toBe('ready')
  })

  it('ingests sequentially, never concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    ingestContent.mockImplementation(async (_s: string, fileName: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return { record: { relPath: `evidence/${fileName}` }, deduped: false }
    })
    await attachFiles('A-1', 1, [
      fileOf('a.png', 'image/png'),
      fileOf('b.png', 'image/png'),
      fileOf('c.png', 'image/png')
    ])
    expect(maxInFlight).toBe(1)
  })

  it('uses the deduped record path without creating a second attachment', async () => {
    ingestContent.mockResolvedValueOnce({
      record: { relPath: 'evidence/original.png' },
      deduped: true
    })
    await attachFiles('A-1', 1, [fileOf('copy.png', 'image/png')])
    const list = composerAttachments.get('A-1', 1)
    expect(list).toHaveLength(1)
    expect(list[0].relPath).toBe('evidence/original.png')
    expect(list[0].name).toBe('original.png')
  })
})
