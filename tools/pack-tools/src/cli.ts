import { parseArgs } from 'node:util'
import { build } from './build'

const USAGE = `argus-pack build --pack <dir> --bin <dir> --platform <os-arch> --out <dir>`

export async function run(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (sub !== 'build') {
    console.error(`unknown command '${sub ?? ''}'\nusage: ${USAGE}`)
    return 2
  }
  let values: Record<string, string | undefined>
  try {
    ;({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        pack: { type: 'string' },
        bin: { type: 'string' },
        platform: { type: 'string' },
        out: { type: 'string' }
      }
    }) as { values: Record<string, string | undefined> })
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: ${USAGE}`)
    return 2
  }

  const missing = ['pack', 'bin', 'platform', 'out'].filter((k) => !values[k])
  if (missing.length) {
    console.error(`missing required flag(s): ${missing.join(', ')}\nusage: ${USAGE}`)
    return 2
  }

  try {
    const res = await build({
      packDir: values.pack!,
      binDir: values.bin!,
      platform: values.platform!,
      outDir: values.out!
    })
    for (const w of res.warnings) console.warn(`warning: ${w}`)
    console.log(`built ${res.bundleName} (${res.files.length} files) → ${res.zipPath}`)
    return 0
  } catch (err) {
    console.error(`build failed: ${(err as Error).message}`)
    return 1
  }
}

// `bin` entrypoint: run when executed directly.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
