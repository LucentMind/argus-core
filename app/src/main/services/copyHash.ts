import crypto from 'node:crypto'
import fs from 'node:fs'

const CHUNK_BYTES = 1024 * 1024

/**
 * Copy a file while hashing it in the same pass, awaiting per 1MB chunk.
 *
 * Replaces `fs.copyFileSync` + `sha256File`, which between them read the file
 * twice and blocked the main-process event loop for the whole duration — the
 * first half of the freeze this change exists to remove.
 *
 * Matches `copyFileSync`'s observable contract on the two points that are easy to
 * lose when hand-rolling the loop: the destination inherits the source's mode
 * rather than the process default, and a failure part-way through leaves no file
 * behind. Without the second guarantee a mid-copy error would strand a truncated
 * destination that has no evidence row and nothing to clean it up — and a later
 * ingest of the same name would then collision-rename around the corpse.
 */
export async function copyAndHash(
  srcPath: string,
  destPath: string
): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256')
  const src = await fs.promises.open(srcPath, 'r')
  try {
    const mode = (await src.stat()).mode
    const dest = await fs.promises.open(destPath, 'w', mode)
    let ok = false
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
      // An existing destination opened with 'w' keeps its old mode, and umask can
      // clear bits off the mode passed to open(); chmod after the fact is what
      // actually makes the copy match the source, as copyFileSync does.
      await dest.chmod(mode)
      ok = true
      return { sha256: hash.digest('hex'), size }
    } finally {
      await dest.close()
      // Close first: on Windows an open handle makes the unlink fail.
      if (!ok) await fs.promises.rm(destPath, { force: true })
    }
  } finally {
    await src.close()
  }
}
