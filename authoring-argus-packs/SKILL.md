---
name: authoring-argus-packs
description: Use when creating, editing, or debugging an Argus pack — writing or changing an argus-pack.json manifest, or declaring a pack's persona, binaries/CLIs, evidence detectors, webPanel windows and their agent commands, skills, or references for Argus Core.
---

# Authoring Argus Packs

A **pack** extends Argus Core (a case-based agentic defect-analysis app) through a manifest plus
optional slot dirs — no forking, no recompiling Core. Core reads *all* domain behavior from packs.
Full guide: `docs/authoring-packs.md`. This skill is the quick contract.

## Anatomy

Directory named **exactly `<id>`** (dir name MUST equal manifest `id`):

```
my-pack/
  argus-pack.json    # manifest — the only required file
  persona.md         # optional persona fragment
  skills/  references/  ui/<panel>/   # optional dir slots
  bin/               # prebuilt binaries (published bundle only)
```

## Manifest slots (`argus-pack.json`)

All ids kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`). Unknown keys are ignored (passthrough).

```jsonc
{
  "id": "my-pack",            // MUST equal the directory name
  "displayName": "My Pack",
  "version": "1.0.0",
  "argusApi": "^1",           // semver RANGE that must include Core's API version (1). Use "^1".
  "persona": "persona.md",    // optional; concatenated into the agent system prompt
  "binaries": [ ... ],        // CLIs Core resolves + the agent runs via Bash (§below)
  "detectors": [ ... ],       // evidence typing + derived-text extraction
  "windows": [ ... ],         // webPanel debug UIs + agent-callable commands
  "referenceRouting": [ { "keywords": ["x"], "target": "x.md" } ]
}
```

| Slot | Purpose | Key fields |
|---|---|---|
| `persona` | Agent role + domain rules | path to a `.md` file |
| `binaries[]` | Executables → agent Bash + detector extract | `id`, `kind` (`exe`\|`pathDir`), `names[]`, `envVar?`, `settingsKey?`, `devPaths[]`, `versionArgs?`/`doctor?`, `platforms?` |
| `detectors[]` | Classify evidence to a `type` + extract text | `type`, `match[]`, `extract?`, `isText`, `analyzeSkill?` |
| `windows[]` | webPanel UI | `id`, `kind:"webPanel"`, `title`, `entry`, `handles[]`, `network[]`, `permissions[]`, `commands[]` |

### Binaries → the agent runs them as Bash commands

A declared binary `name` is auto-allowlisted **LOW risk** in the agent's `Bash` tool. Names **must
not** be `git`/`gh`/`rm`/`cd` (reserved). Tell the agent how to invoke them in `persona.md`. Resolve
order: user env `envVar` → `settings.tools[settingsKey]` → pack `bin/` → `devPaths` → PATH → `~/.local/bin`.

### Detectors → evidence typing + extraction

```jsonc
{ "type": "widget-trace", "isText": false, "analyzeSkill": "analyze-widget-trace",
  "match": [ { "nameEndsWith": [".wtr"], "magicHex": "57545231", "magicOffset": 0,
               "headRegex": { "source": "^WTR", "flags": "" },
               "json": { "anyKeys": ["widgets"], "arrayKeys": ["events"] } } ],
  "extract": { "bin": "my-tool", "args": ["decode", "{input}", "-o", "{output}"] } }
```

- `match[]` rules are **OR'd**; fields within one rule are **AND'd**. First matching detector (across
  packs, id-sorted) wins; duplicate `type` → first wins. `magicHex` is **contiguous even-length hex,
  no spaces** (`"57545231"` for "WTR1"), case-insensitive, checked at `magicOffset`.
- **Placeholders are `{input}` (source file) and `{output}` (derived `.txt` Core creates)** — NOT `{file}`.
- `extract.bin` references a `binaries[]` **id**. `isText:true` = index the raw file directly (no extract).
  A binary is only usable here if it's declared in `binaries[]` (which also exposes it to the agent's Bash).

### Windows (webPanel)

`entry` is a path **under `ui/`** (forward slashes, no `..`; one `ui/<panel>/` folder per window). If
`windows[]` is set, `ui/` must exist. Bundle is **self-contained under strict CSP**: no inline
`<script>`/`<style>`, no `eval`, no external JS/CSS/fonts. `network[]` is origin strings
(`"https://api.example.com"`) that only widen `img-src`/`connect-src` (not scripts). Reference real
`.js`/`.css` files with `'self'`.

`handles[]` = artifact `type`(s) this panel renders → adds an evidence **"Open in <panel>"** action.
When opened that way (or via `open_panel` with an evidence id), `getCaseContext()` returns
`focus: { evidenceId, line? }`; the panel then calls `readEvidence(focus.evidenceId, focus.line)` to
render it (no focus → offer `requestEvidence(query)` to pick one).

**Upstream `window.argus` verbs** (present only if in `permissions[]`): `getCaseContext()`,
`requestEvidence(query)`, `readEvidence(id,line?)` (reads, no prompt); `cite(relPath,line)` (composer
chip), `sendToAgent(text)` (stages composer text), `emitFinding({title,markdown})` (MEDIUM editable
HITL). Always case+session-bound.

**Downstream `commands[]`** → agent tools `mcp__<pack>__<window>_<cmd>`:

```jsonc
{ "id": "highlight", "risk": "low",
  "description": "Scroll the panel to a line and highlight it. Use when the user asks about a specific line.",
  "args": ["line"], "argDescriptions": { "line": "1-based line number" } }
```

- `description` (→ falls back to `title` → generic) is what the agent uses to decide **when/how to
  call the tool** — always write a real one; document each arg. `risk`: low=auto, medium/high=HITL.
- Panel handles them via `window.argus.onCommand((cmd,args)=>result)`. The agent opens a panel with
  the native `mcp__argus__open_panel` tool; a command to a closed panel returns a `panel-not-open` error.

## Loading & install

Dev: drop the pack in the repo `packs/` dir or set `ARGUS_PACKS_SRC`; restart to reload. Installed
packs live at `ARGUS_HOME/packs/<id>/`. Publish per-platform bundles with
`argus-pack build --pack <dir> --bin <dir> --platform <os-arch> --out <dir>` (in `tools/pack-tools`);
it stamps `platform`, writes `CHECKSUMS`, zips `<id>-<version>-<platform>.zip`. Install verifies
checksums + `platform` + `argusApi`, and **always requires an app relaunch**.

## Common mistakes

- Directory name ≠ manifest `id` → won't load.
- `windows[]` without `ui/`, or an `entry` not present under `ui/` → load error.
- Inline `<script>`/`<style>` or external JS/CSS in a panel → CSP-blocked.
- Binary named `git`/`gh`/`rm`/`cd` → rejected.
- Detector placeholders written as `{file}` (correct: `{input}`/`{output}`).
- `extract.bin` not matching a declared binary `id`.
- Vague/absent command `description` → agent can't tell when to call the tool.
- Treating `argusApi` as a version (it's a semver **range**; use `"^1"`).
- Expecting to install a manifest with no `platform` (build a per-platform bundle first).

## Minimal valid pack

```jsonc
// my-pack/argus-pack.json
{ "id": "my-pack", "displayName": "My Pack", "version": "0.1.0", "argusApi": "^1",
  "persona": "persona.md",
  "detectors": [ { "type": "widget-log", "isText": true, "match": [ { "nameEndsWith": [".wlog"] } ] } ] }
```

## Copy from the sample packs

- `packs/sample-text-viewer/` — smallest complete read-only webPanel.
- `packs/sample-bridge-playground/` — full bridge: all read+write verbs + `commands[]` + `onCommand`.

For the full contract (binary resolution order, skill/reference tiering, distribution internals, the
panel bridge protocol), read `docs/authoring-packs.md`.
