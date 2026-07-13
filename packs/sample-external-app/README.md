# Sample External App

The reference Argus `externalApp` pack (Part 3c): a headless Node script that
speaks the stdio command protocol, proving out `kind: 'externalApp'` window
declarations end to end — manifest validation, process spawn, and the
`ping`/`echo` agent commands routed over stdin/stdout.

Core spawns `bin/app.mjs` using its bundled `runtime: 'node'` (Electron-as-node),
so the script needs no build step or separate Node install; it reads
newline-delimited JSON `{ requestId, cmd, args }` on stdin and writes matching
`{ requestId, ok, result }` replies on stdout, logging a line per command to
stderr for Core's per-process log file. The app is headless — it has no window
of its own; the presence chip and the `ping`/`echo` agent commands are its only
surface.
