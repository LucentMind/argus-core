# Argus

Argus is a **local-first, human-in-the-loop desktop workbench for defect analysis**. It pairs an
Electron app with an embedded [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) session,
a local evidence store with full-text search, and a risk-gated tool-approval model, organized into
per-case workspaces where evidence, findings, chat sessions, and reports live together.

Domain capability is delivered through **installable packs**: Core itself is domain-free — it knows
nothing about any specific file format, tool, or workflow. A pack declares its own binaries,
detectors, skills, and reference docs, and Core discovers them at startup.

## What it does

| Pillar | Description |
|---|---|
| **Case-centric UI** | A case is the top-level object; evidence, findings, chat, and the report live under it. |
| **Embedded agent** | A headless Claude Agent SDK session runs inside the app — the user chats, the agent runs skills and tools, output streams into the UI. |
| **Evidence library** | Local artifacts organized per case, auto-typed by pack detectors, indexed (SQLite FTS5), searchable and filterable. |
| **HITL risk gating** | Every tool call is classified LOW/MEDIUM/HIGH; write-backs and destructive ops require explicit in-UI approval with a preview. |
| **Code workspaces** | A case can link checked-out repositories; the agent gets sandboxed `git`/`gh` access with worktree isolation. |
| **Compounding knowledge** | Topic-indexed agent memory, versioned skills, and optional shared-repo distribution. |
| **Observability** | Local SQLite-backed metrics (cost, tokens, latency, approvals); optional self-hosted exporter, off by default. |

## Repository layout

| Path | What it is |
|---|---|
| `app/` | Electron app (electron-vite, React 19, TypeScript, Tailwind 4, `node:sqlite`) |

## Running

```bash
cd app
npm install
npm run dev
```

Requires Node.js 22+ and the Claude Code CLI installed and logged in.

## License

See [LICENSE](LICENSE).
