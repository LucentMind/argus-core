# Sample Text Viewer

The reference Argus `webPanel`: a domain-neutral text evidence viewer shipped
inside Core. It is the pattern pack vendors copy, and the end-to-end proof that
the panel host, `argus-panel://` protocol, per-panel CSP, and read-only
`window.argus` bridge carry no domain assumptions.

`ui/text-viewer/` is a self-contained bundle — plain `index.html` + `app.js` +
`app.css`, no framework and no build step, no inline script/style — so the
strict `script-src 'self'` / `style-src 'self'` panel CSP holds. It renders any
`text` evidence (raw logs and derived extracts) with line numbers, in-panel
find, and jump-to-focus, styling entirely via the `--argus-*` theme tokens the
panel preload injects.
