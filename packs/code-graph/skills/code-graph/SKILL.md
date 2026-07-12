---
name: code-graph
description: Use when the user asks a blast-radius, impact, "what calls X", "what breaks if", or dependency-chain question about a linked repo. Queries the pre-built graphify code graph instead of multi-hop grep exploration. NOT for general "explain this code" questions — plain file reading wins there.
---

# Code Graph Queries

Pre-built code graphs (when the user has built one) live under
`<ARGUS_HOME>/graphs/<repoId>/<scopeKey>/graphify-out/graph.json`, with
build info in the sibling `meta.json`. List `<ARGUS_HOME>/graphs/` to
find them; match the repo by the `repoId` folder name (derived from the
repo's remote, e.g. `acme-widget-lib`).

## Before querying

1. Read `meta.json`. If `status` is not `ok`, say so and stop.
2. Compare `meta.json.commit` with the repo's HEAD (`git rev-parse HEAD`).
   If they differ, still answer, but flag in your findings that the graph
   is N commits behind (`git rev-list --count <meta.commit>..HEAD`).
3. If no graph exists for the repo, say so and suggest the user build one
   from the repo chip in the case header. Do NOT run `graphify extract`
   yourself — builds take minutes and are user-triggered.

## Query flow (always by node ID, never bare labels)

The `graphify` CLI is on PATH. Bare names are ambiguous — resolve first:

1. `graphify explain "SymbolName" --graph "<graph.json>"` — returns the
   node's full ID (e.g. `c_users_..._src_ui_map_map`), source file:line,
   and its connections.
2. Blast radius / who-is-affected:
   `graphify affected "<node-id>" --graph "<graph.json>" --depth 2`
3. Dependency chain between two symbols:
   `graphify path "<node-id-A>" "<node-id-B>" --graph "<graph.json>"`

## Output discipline (mandatory)

- `affected` on a high-degree node can emit hundreds of lines. Redirect
  to a file in the case directory and read selectively, or use
  `graphify query "<question>" --graph <path> --budget 2000` for capped
  traversals. Never ingest an unpaged dump into context.
- Graph edges are syntactic (tree-sitter): dynamic dispatch, dependency
  injection, and virtual calls can be missing or noisy. VERIFY every
  edge you cite in findings by reading the source location the graph
  gives you. The graph tells you where to look; the code is the truth.
