// Headless sample external app (Argus Part 3c). Reads newline-delimited JSON
// commands { requestId, cmd, args } on stdin, writes { requestId, ok, result }
// replies on stdout, and logs each command to stderr (Core tees stderr to a
// per-process log file). Exits cleanly when stdin closes.
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split(/\r?\n/)
  buf = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    process.stderr.write(`[sample-external-app] cmd=${msg.cmd} args=${JSON.stringify(msg.args)}\n`)
    let result
    if (msg.cmd === 'ping') result = { pong: true }
    else if (msg.cmd === 'echo') result = { echoed: (msg.args && msg.args[0]) ?? null }
    else {
      process.stdout.write(JSON.stringify({ requestId: msg.requestId, ok: false, error: `unknown cmd: ${msg.cmd}` }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({ requestId: msg.requestId, ok: true, result }) + '\n')
  }
})
process.stdin.on('end', () => process.exit(0))
