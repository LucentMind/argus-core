import crypto from 'node:crypto'
import fs from 'node:fs'

const CHUNK_BYTES = 1024 * 1024

/**
 * Copy a file while hashing it in the same pass, awaiting per 1MB chunk.
 *
 * Replaces `fs.copyFileSync` + `sha256File`, which between them read the file
 * twice and blocked the main-process event loop for the whole duration — the
 * first half of the freeze this change exists to remove.
 */
export async function copyAndHash(
  srcPath: string,
  destPath: string
): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256')
  const src = await fs.promises.open(srcPath, 'r')
  try {
    const dest = await fs.promises.open(destPath, 'w')
    try {
      const buf = Buffer.alloc(CHUNK_BYTES)
      let size = 0
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, CHUNK_BYTES, size)
        if (bytesRead === 0) break
        const slice = buf.subarray(0, bytesRead)
        hash.update(slice)
        await dest.write(slice, 0, bytesRead, size)
        size += bytesRead
      }
      return { sha256: hash.digest('hex'), size }
    } finally {
      await dest.close()
    }
  } finally {
    await src.close()
  }
}
