import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * vitest globalSetup for the suites under tools/: one temp folder per run.
 *
 * The tests mkdtemp under os.tmpdir() and most never clean up, which left hundreds
 * of packtools-* and distill-eval-* folders in %TEMP%. os.tmpdir() reads these
 * variables on every call and workers inherit them, so everything lands here and
 * goes away together once the workers have exited and released their handles.
 */
export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tools-test-'))
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = root
  return () => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (err) {
      // A leftover folder is not worth failing a green run over.
      console.warn(`could not remove ${root}: ${String(err)}`)
    }
  }
}
