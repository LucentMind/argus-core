# ACP Library Empirical Evidence (Task 1)

Captured against `@zed-industries/agent-client-protocol@0.4.5` (single pinned
version; `npm ls @zed-industries/agent-client-protocol` → exactly one line)
on 2026-07-24, Windows 11, Node 22.20.0. **Scope note:** per owner decision,
this task did NOT spawn real `cursor-agent`/`grok` binaries — neither binary
nor an API key is available in this environment. Steps 3-4 of the task brief
(live JSONL capture) are **DEFERRED**. Everything below the CONFIRMED section
comes from reading the installed package's actual source/`.d.ts`, not from
running it against a live agent.

All citations are `app/node_modules/@zed-industries/agent-client-protocol/<file>:<line>`.
The package ships full TypeScript source under `typescript/` in addition to
the compiled `dist/*.d.ts`; the two were diffed for the symbols below and are
identical (compiled output, not hand-written declarations), so citations use
the more readable `typescript/*.ts` paths.

Package shape: `package.json` has no `exports` map — just `"main":
"dist/acp.js"`, `"types": "dist/acp.d.ts"`, `"type": "module"`
(package.json:24-26). A single `import ... from
'@zed-industries/agent-client-protocol'` resolves everything (schema types,
`ClientSideConnection`, `AgentSideConnection`, `ndJsonStream`, `RequestError`,
`AGENT_METHODS`/`CLIENT_METHODS`/`PROTOCOL_VERSION`) — `acp.ts` re-exports
`schema.ts` and `stream.ts` in full (`typescript/acp.ts:1-4`).

npm also emits a deprecation warning on install: *"This package has been
renamed to `@agentclientprotocol/sdk`. Please migrate to continue receiving
updates."* We installed the exact name the brief specified (do not
substitute); flagged as a CONCERN below for whoever eventually re-pins this
dependency.

---

## CONFIRMED (from the real library types — authoritative for Tasks 2-9)

### 1. Entry point: `ClientSideConnection` class — there is NO fluent `client()` API

The plan's spec/risk section says the lib "recently moved from
`ClientSideConnection`/`AgentSideConnection` classes to a fluent `client()`
API." **That is not true of the pinned `0.4.5`.** Grepping the compiled
`dist/acp.d.ts` for `client(` / `export function client` / `export const
client` returns **zero matches**. The only exported connection constructors
are the two classes:

```ts
// typescript/acp.ts:378-393
export class ClientSideConnection implements Agent {
  constructor(toClient: (agent: Agent) => Client, stream: Stream)
  // ^ toClient factory receives the Agent-role proxy (for calling initialize/
  //   newSession/prompt/cancel back into the spawned process) and must return
  //   an object implementing `Client`.
  ...
}
```

Argus (playing the ACP **Client**) must construct a `ClientSideConnection`,
passing a factory that builds the `Client` implementation, plus a `Stream`
built from the spawned child process's stdio via `ndJsonStream` (below).
`AgentSideConnection` (typescript/acp.ts:27) is the mirror-image class for
implementing the *Agent* side and is irrelevant to Argus.

`Stream` (typescript/stream.ts:11-14) is a Web Streams pair:
`{ writable: WritableStream<AnyMessage>; readable: ReadableStream<AnyMessage> }`.
`ndJsonStream(output: WritableStream<Uint8Array>, input:
ReadableStream<Uint8Array>): Stream` (typescript/stream.ts:26) turns a
newline-delimited-JSON byte stream into that pair. To drive it from a Node
`child_process`, convert with `Writable.toWeb(child.stdin)` /
`Readable.toWeb(child.stdout)` (Node's `node:stream` web interop) — the lib
itself does not do this conversion.

**ADJUST Task 5:** the step-3 instruction to "construct the lib's Client
connection ... (exact entry point per Task 1: prefer the fluent `client()`
API)" cannot be followed — there is no such API in `0.4.5`. Use
`new ClientSideConnection(toClient, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))`
instead. The "isolate all lib usage behind one seam" goal is unaffected —
`client.ts` still isolates this class-based construction the same way it
would have isolated a fluent one.

### 2. The `Client` interface Argus must implement

`typescript/acp.ts:1001-1146`:

```ts
export interface Client {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  createTerminal?(...): Promise<CreateTerminalResponse>;      // optional, terminal capability
  terminalOutput?(...): Promise<TerminalOutputResponse>;      // optional
  releaseTerminal?(...): Promise<ReleaseTerminalResponse|void>;// optional
  waitForTerminalExit?(...): Promise<WaitForTerminalExitResponse>; // optional
  killTerminal?(...): Promise<KillTerminalResponse|void>;     // optional
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;
}
```

`requestPermission` and `sessionUpdate` are the only **required** members;
`readTextFile`/`writeTextFile` and all terminal methods are optional (`?`) —
the library dispatches with `client.writeTextFile?.(...)` /
`client.readTextFile?.(...)` (typescript/acp.ts:401-410), so an agent that
calls `fs/read_text_file` against a client that omitted `readTextFile` gets
`undefined` back rather than a protocol error; Argus should implement both
since it advertises `fs` capabilities at `initialize`.

Real request/response shapes (`typescript/schema.ts`):
- `ReadTextFileRequest` (readTextFileRequestSchema, :1724-1731): `{ path, sessionId, line?, limit? }` → `ReadTextFileResponse`: `{ content: string }` (:780-788).
- `WriteTextFileRequest` (writeTextFileRequestSchema, :1717-1722): `{ path, content, sessionId }` → `WriteTextFileResponse`: `{}` (empty extension-point object).

### 3. Handshake / session / prompt method names (all match the plan's assumptions)

`AGENT_METHODS` / `CLIENT_METHODS` maps (schema.ts:1-22) and `PROTOCOL_VERSION = 1` (schema.ts:24):

| Constant | JSON-RPC method string |
| --- | --- |
| `AGENT_METHODS.initialize` | `initialize` |
| `AGENT_METHODS.session_new` | `session/new` |
| `AGENT_METHODS.session_load` | `session/load` |
| `AGENT_METHODS.session_set_mode` | `session/set_mode` |
| `AGENT_METHODS.session_set_model` | `session/set_model` |
| `AGENT_METHODS.authenticate` | `authenticate` |
| `AGENT_METHODS.session_prompt` | `session/prompt` |
| `AGENT_METHODS.session_cancel` | `session/cancel` (notification) |
| `CLIENT_METHODS.session_update` | `session/update` (notification) |
| `CLIENT_METHODS.session_request_permission` | `session/request_permission` |
| `CLIENT_METHODS.fs_read_text_file` / `fs_write_text_file` | `fs/read_text_file` / `fs/write_text_file` |
| `CLIENT_METHODS.terminal_*` | `terminal/create`\|`output`\|`release`\|`wait_for_exit`\|`kill` |

`InitializeRequest` (:942-954): `{ protocolVersion: number, clientCapabilities?: ClientCapabilities }`.
`ClientCapabilities` (:958-970): `{ fs?: { readTextFile?: boolean; writeTextFile?: boolean }, terminal?: boolean }`.
`InitializeResponse` (:1186-1205): `{ protocolVersion: number, agentCapabilities?: AgentCapabilities, authMethods?: AuthMethod[] }`.
`NewSessionRequest` (:1014-1029): `{ cwd: string, mcpServers: McpServer[] }` → `NewSessionResponse` (:1307-1334): `{ sessionId: string, models?: SessionModelState|null, modes?: SessionModeState|null }`.
`PromptRequest` (:1125-1152): `{ sessionId: string, prompt: ContentBlock[] }` → `PromptResponse` (:1456-1472): `{ stopReason: 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled' }`.
`ContentBlock` text variant (:311-322): `{ type: 'text', text: string, annotations?: ... }` — matches the plan's assumed shape exactly.

**Cursor model-selection quirk, confirmed shape:** `SessionModelState` (:1342-1357)
is `{ availableModels: ModelInfo[], currentModelId: string }`, and
`SetSessionModelRequest`/method `session/set_model` (:1160-1175) is
`{ sessionId, modelId }`. All three are marked **UNSTABLE** ("not part of the
spec yet, may be removed or changed at any point") in the doc comments.

**CONCERN / real library bug found in `0.4.5`:** `ClientSideConnection.setSessionModel()`
(typescript/acp.ts:592-601) sends its request using
`schema.AGENT_METHODS.session_set_mode` (the **mode**, not **model**,
method string) — a copy-paste bug, since the sibling `AgentSideConnection`
dispatcher correctly matches on `AGENT_METHODS.session_set_model`
(typescript/acp.ts:84-91). **ADJUST Task 7 (Cursor profile) / Task 5
(client wrapper):** do not call the convenience `connection.setSessionModel()`
method for the Cursor model-selection quirk — it will silently invoke the
agent's `session/set_mode` handler instead of `session/set_model`. Send a raw
request instead, e.g. `connection.sendRequest('session/set_model', { sessionId, modelId })`
(the lib does not expose `sendRequest` publicly on `ClientSideConnection`, so
`client.ts` may need its own raw-JSON-RPC escape hatch, or wait for an
upstream fix and re-verify against whatever version is pinned when Task 7
actually runs live).

### 4. `session/update` discriminator and all real variant names

`SessionNotification` (:1498-1651): `{ sessionId: string, update: <discriminated union> }`.
The discriminator field is **`sessionUpdate`** (matches the plan). The full,
real set of variants (schema.ts:1512-1650) — **8 variants**, not 5:

| `sessionUpdate` value | Key fields |
| --- | --- |
| `user_message_chunk` | `content: ContentBlock` |
| `agent_message_chunk` | `content: ContentBlock` |
| `agent_thought_chunk` | `content: ContentBlock` |
| `tool_call` | `toolCallId, title, kind?: ToolKind, status?: ToolCallStatus, content?, locations?, rawInput?, rawOutput?` |
| `tool_call_update` | `toolCallId, title?, kind?: ToolKind\|null, status?: ToolCallStatus\|null, content?, locations?, rawInput?, rawOutput?` |
| `plan` | `entries: PlanEntry[]` (`{content, priority: high\|medium\|low, status: pending\|in_progress\|completed}`) |
| `available_commands_update` | `availableCommands: AvailableCommand[]` |
| `current_mode_update` | `currentModeId: SessionModeId` |

**ADJUST Task 4 (normalizer):** the plan's normalizer switch only handles
`agent_message_chunk`/`agent_thought_chunk`/`tool_call`/`tool_call_update`/`plan`
and falls through to `[]` for anything else (which is safe — the `default:
return []` already covers `user_message_chunk`, `available_commands_update`,
`current_mode_update` harmlessly) — no code change strictly required, but
worth an explicit comment in `normalize.ts` acknowledging these 3 extra
variants exist and are intentionally no-ops for now, so a future reader
doesn't mistake the omission for an oversight.

`ToolKind` (schema.ts:189-199) — **10 values**, not the 5-6 the design doc's
taxonomy section enumerates:
`"read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"`.
**ADJUST Task 3 (taxonomy.ts):** the fail-closed switch must have explicit
cases for `search`, `think`, and `switch_mode` too (not just fall through to
the `other`/unknown-kind HIGH-risk branch — `switch_mode` and `think` are
legitimate, low-risk ACP kinds, not "unknown"). Only a value truly absent
from this list should hit the fail-closed unknown branch.

`ToolCallStatus` (schema.ts:207): `"pending" | "in_progress" | "completed" | "failed"` — matches the plan exactly.

### 5. `session/request_permission` shape — and an important field-name correction

`RequestPermissionRequest` (:473-489): `{ sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }`.
`ToolCallUpdate.kind?: ToolKind | null` (:530) — i.e. the tool-kind
classification the design doc's §3 wants to switch on (`execute`→exec,
`read`→file-read, etc.) lives at **`params.toolCall.kind`**, not at the top
level of the permission request.

`PermissionOption` (:493-512): `{ optionId: string, name: string, kind:
"allow_once" | "allow_always" | "reject_once" | "reject_always" }`.

**ADJUST Task 6 / plan §3, terminology correction:** the plan's phrase
"permission `kind` values (`execute`/`read`/`edit`/`delete`/`move`/`fetch`)"
conflates two different `kind` fields that share a name but not a domain:
- `PermissionOption.kind` (the thing you pick from) is one of
  `allow_once|allow_always|reject_once|reject_always` — **4 values, never**
  `execute`/`read`/etc.
- `ToolCallUpdate.kind` (nested under `toolCall`) is the 10-value `ToolKind`
  enum above, and is what `execute`/`read`/`edit`/`delete`/`move`/`fetch`
  actually describes.

`RequestPermissionResponse` (:792-813) — outcome is a discriminated union,
not a bare `optionId`:
```ts
outcome: { outcome: "cancelled" } | { outcome: "selected", optionId: string }
```
**ADJUST Task 6:** "maps the returned `ToolDecision` to an ACP permission
optionId ... and resolves the ACP request" must wrap the chosen `optionId` in
`{ outcome: 'selected', optionId }`, and the `session/cancel` interrupt path
must resolve any in-flight `requestPermission` promise with
`{ outcome: 'cancelled' }` (no `optionId` field at all in that branch), per
the doc comment on `requestPermission` (typescript/acp.ts:163-165): "If the
client cancels the prompt turn via `session/cancel`, it MUST respond to this
request with `RequestPermissionOutcome::Cancelled`."

---

## ASSUMED (pending live capture — UNVERIFIED, not confirmed by any real run)

Nothing below this line was exercised against a live agent process. These
are the plan's pre-existing assumptions, restated here so Task 1's later
readers know exactly what still needs reconciling once binaries/keys are
available (rerun `scripts/acp-spike.mjs`, see the per-agent `README.md`):

- **Cursor launch argv**: `cursor-agent … acp` (t3code-observed, per the
  plan; harness defaults to `cursor-agent acp`, adjust once confirmed).
- **Grok launch argv**: `grok agent stdio`.
- **Auth env vars**: `CURSOR_API_KEY` (Cursor), `XAI_API_KEY` (Grok) — vs. a
  `cursor-agent login` / xAI-key-file alternative flow.
- **Model lists**: Cursor's `auto`, `composer-2`, `composer-1.5`, plus
  mirrored Claude slugs; Grok's default `grok-build` plus custom models. The
  `SessionModelState`/`ModelInfo` *shape* is confirmed (§3 above); the actual
  populated `availableModels[]` content per agent is not.
- **Cursor base-id model resolver**: whether Cursor rejects some requested
  `modelId` values on `session/new`/`session/set_model` and needs a
  resolver table mapping user-facing slugs to accepted base IDs — the need
  for this is asserted by the plan/t3code precedent, not observed here.
- **xAI/Grok extension methods**: any `_`-prefixed extension request/notification
  Grok sends beyond standard ACP (the library's `extMethod`/`extNotification`
  hooks, typescript/acp.ts:1132-1145, are the confirmed mechanism for
  receiving them — the actual method names/payloads are unknown).
- **Whether `agentCapabilities`/`authMethods` are populated identically** by
  Cursor vs. Grok, and whether either uses `authenticate` at all versus
  failing session creation outright when the env var is unset.
- **Exact stderr/exit-code shape of an auth-failure run** for each agent
  (used by `authErrorResult()` in the Task 4 normalizer).

---

## ADJUST NOTES (summary — see full explanations inline above)

- **Task 5**: no fluent `client()` API exists in `0.4.5` — use
  `new ClientSideConnection(toClient, ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout)))`.
- **Task 3**: `ToolKind` has 10 values (`search`, `think`, `switch_mode` are
  real, not "unknown") — the fail-closed switch needs explicit branches for
  all 10, only a truly unrecognized string should hit the HIGH-risk default.
- **Task 4**: `session/update` has 8 real variants, not 5 — the extra 3
  (`user_message_chunk`, `available_commands_update`, `current_mode_update`)
  safely no-op through the existing `default: return []`, but should be
  commented as intentional.
- **Task 6**: permission `kind` is two different fields — `PermissionOption.kind`
  (`allow_once|allow_always|reject_once|reject_always`, what you return) vs.
  `ToolCallUpdate.kind` nested at `params.toolCall.kind` (the 10-value
  `ToolKind`, what you classify). Response `outcome` is `{outcome:'selected',
  optionId}` or `{outcome:'cancelled'}`, not a bare optionId string.
- **Task 5/7**: `ClientSideConnection.setSessionModel()` has a real bug in
  `0.4.5` — it calls the `session/set_mode` method string instead of
  `session/set_model`. Cursor's model-selection quirk must be driven by a
  raw JSON-RPC request, not this convenience method.
- Everything else the plan assumed about method names
  (`initialize`/`session/new`/`session/prompt`/`session/update`/
  `session/request_permission`), the `sessionUpdate` discriminator field
  name, and the `ContentBlock` text shape **matches the real library
  exactly** — no adjustment needed there.
