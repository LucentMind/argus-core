# Copilot SDK Empirical Evidence (Task 7)

Captured against `@github/copilot-sdk@1.0.7` (bundles CLI `@github/copilot@1.0.71`,
protocol v3) on 2026-07-18, Windows 11, Node 22.20.0, account `JiaweiHan88`
(gh-cli auth, **Copilot Free** tier). Every claim cites a committed fixture in
this directory (`<scenario>.jsonl`) and/or a line in the SDK's bundled `.d.ts`
under `app/node_modules/@github/copilot-sdk/dist/`.

Harness: `app/scripts/spike-copilot/` (rerun with `node scripts/spike-copilot/run.mjs`).
Each fixture line is an envelope `{scenario, t, kind, data}` where `kind` ∈
`event | permission-request | permission-decision | tool-invocation | error | result | meta`.
`kind:"event"` records a raw `session.on(...)` payload verbatim.

**13/13 scenarios captured successfully. No quota/rate-limit blocking** — every
turn billed `cost: 0` (`01-chat.jsonl` `assistant.usage`).

---

## 1. Event-name map (SDK event → proposed `AgentEvent`)

The full generated union is `SessionEvent` (`generated/session-events.d.ts:8`);
`SessionEventType` discriminators number ~140. A plain streamed turn
(`01-chat.jsonl`) emits this ordered lifecycle:

| SDK event (`event.type`) | Key `event.data` fields (observed) | Proposed `AgentEvent` |
| --- | --- | --- |
| `session.start` | — | (session bootstrap, internal) |
| `session.model_change` | `newModel:"auto"` | ignore / debug |
| `session.auto_mode_resolved` | `chosenModel`, `candidateModels[]`, `categoryScores`, `confidence` | debug/telemetry (router decision) |
| `system.message` | system prompt applied | ignore |
| `session.skills_loaded`, `session.tools_updated` | `model` | capability/debug |
| `user.message` | echoed prompt | (already known locally) |
| `assistant.turn_start` | `turnId`, `model` (**resolved model**), `interactionId` | `turn.started` |
| `assistant.message_start` | — | (stream open) |
| `assistant.reasoning` / `assistant.reasoning_delta` | reasoning text/opaque | `reasoning.delta` (optional) |
| `assistant.streaming_delta` / `assistant.message_delta` | `deltaContent` (ephemeral) | `message.delta` |
| `assistant.message` | `content`, `messageId`, `toolRequests[]`, `model`, `turnId` | `message.final` |
| `assistant.usage` | tokens/cost/latency (see §5) | `usage` |
| `assistant.turn_end` | `turnId`, `model` | `turn.completed` (fires before `session.idle`) |
| `assistant.idle` / `session.idle` | — | `turn.idle` (turn boundary; `sendAndWait` resolves here) |
| `session.usage_info` | context-window accounting (§5) | `context.usage` |
| `session.title_changed` | auto-generated summary | metadata |

Tool turns additionally emit (`03/04/05/12`):
`tool.user_requested` → `tool.execution_start` (`toolCallId`, `toolName`,
`arguments`) → `permission.requested` (see §2) → `tool.execution_progress` →
`tool.execution_complete` (`toolCallId`, `toolName`, `success`, `result`, `error`).
Map start→`tool.started`, complete→`tool.completed`. Docs confirm these field
names (`docs/examples.md` "Top 10 Most Useful Event Types").

Interrupt path (`11-interrupt.jsonl`): `abort` (`data.reason:"user_initiated"`)
→ `session.info` (`infoType:"cancellation"`) → `assistant.idle` → `session.idle`.
Map `abort` → `turn.aborted`.

Errors surface as `session.error` events (`errorType`, `message`, `stack`) — see §7.

> **`assistant.message` carries the resolved model, not `"auto"`.** In every tool
> scenario the `assistant.turn_start.model` and `assistant.usage.model` are the
> real underlying model (`claude-haiku-4.5` / `gpt-5-mini`), even though the
> session was created with `model` unset / `"auto"`. The normalizer should read
> the model from `turn_start`/`usage`, not from session config.

---

## 2. Permission request/response shapes

Handler: `SessionConfig.onPermissionRequest?: PermissionHandler`
(`types.d.ts:1745`, `types.d.ts:856`). The handler receives the
`PermissionRequest` **directly** (discriminated on `.kind`), plus
`{sessionId}`. The event-stream form nests it under
`data.permissionRequest` with a `requestId` (`session-events.d.ts:5570`).

Request union `PermissionRequest` = 10 variants (`session-events.d.ts:332`):

| `kind` | Distinguishing fields (from `.d.ts` + captured) | Fixture |
| --- | --- | --- |
| `write` | `fileName`, `diff` (git unified), `newFileContents?`, `intention`, `canOfferSessionApproval`, `toolCallId`, `requestSandboxBypass?` (`:5660`) | `02-write-permission.jsonl` |
| `shell` | `fullCommandText`, `commands[]{identifier,readOnly}`, `possiblePaths[]`, `possibleUrls[]`, `hasWriteFileRedirection`, `canOfferSessionApproval`, `warning?`, `requestSandboxBypass?` (`:5585`) | `03-shell-permission.jsonl` |
| `read` | `path`, `intention` (`:5701`) — **read is NOT auto-approved; it prompts** | `04-read-fetch.jsonl` |
| `url` | `url`, `intention`, `requestSandboxBypass?` (`:5765`) | `04-read-fetch.jsonl` |
| `mcp` | `serverName`, `toolName`, `toolTitle`, `readOnly`, `args` (`:5730`) | (type only; see §6) |
| `custom-tool` | `toolName`, `toolDescription`, `args` (`:5825`) | `05-custom-tool.jsonl` |
| `memory` | `fact`, `subject`, `action`, `direction` (`:5794`) | type only |
| `hook` | `toolName`, `toolArgs`, `hookMessage?` (`:5852`) | type only |
| `extension-management` | `operation`, `extensionName?` (`:5879`) | type only |
| `extension-permission-access` | `capabilities[]`, `extensionName` (`:5900`) | type only |

Response is `PermissionRequestResult` = `PermissionDecisionRequest["result"] | {kind:"no-result"}`
(`types.d.ts:853`), where `PermissionDecision` (`rpc.d.ts:1152`) is a `kind`-tagged union.
Decisions Argus will use:

- `{kind:"approve-once"}` (`rpc.d.ts:7801`) — captured approving write/shell/read/custom-tool.
- `{kind:"approve-for-session", approval?, domain?}` (`:7814`) — session-scoped, optional command-identifier / URL-domain scoping.
- `{kind:"approve-for-location", ...}`, `{kind:"approve-permanently", domain}` (`:8140`, URL only).
- `{kind:"reject", feedback?}` (`rpc.d.ts:8157`) — captured denying `url` in `04-read-fetch.jsonl` (`permission-decision` line); the model gracefully reported egress unavailable.
- Terminal/host-generated variants (`denied-by-rules`, `denied-interactively-by-user`, `cancelled`, `user-not-available`, …) round out the union.

### THE modified-input answer: **NO.**

`approve-once` cannot carry edited tool input. Two independent proofs:

1. **Type**: no approve variant in `PermissionDecision` (`rpc.d.ts:1152`) has any
   field for replacement input — approvals carry only scoping metadata
   (`domain`, `commandIdentifiers`, `approval.kind`); `reject` carries only
   `feedback`.
2. **Empirical** (`02-write-permission.jsonl`, `runB-modified-input`): the handler
   returned `{kind:"approve-once", newFileContents:"MODIFIED_BY_HOST",
   updatedInput:{...}, modifiedArgs:{...}}`. The written file `hello2.txt` still
   contained **`hi`**, not `MODIFIED_BY_HOST` (`result` line: `"fileContents":"hi"`).
   Extra fields are silently ignored.

**Design implication:** to alter what a tool does, Argus must use the **hooks**
channel, not the permission channel. `onPreToolUse` returns `modifiedArgs` /
`permissionDecision` (`docs/examples.md` "Modifying tool arguments before
execution"; `PreToolUseHookOutput` `types.d.ts:968`). Permission = approve/deny/scope only.

---

## 3. Tool-name inventory (→ `COPILOT_TOOL_TAXONOMY`)

Built-in tools the runtime advertised to the model (`06-mcp.jsonl` `result` — the
model enumerated its own toolset) and permission-kind observations:

| Built-in tool | Permission `kind` it raises | Risk class |
| --- | --- | --- |
| `create`, `edit` (apply_patch / str_replace_editor) | `write` | mutating-fs |
| `view` / read, `glob`, `grep` | `read` | read-fs (still prompts) |
| `powershell` (Windows) / `bash` (shell) | `shell` (`readOnly` per parsed command; `hasWriteFileRedirection`) | exec |
| `web_fetch` | `url` | network-egress |
| `git` (via shell), `sql`, `task` (sub-agents), `skill`, `read_agent`, `list_agents` | shell/custom | mixed |
| memory ops | `memory` | persistence |
| MCP tools | `mcp` (`readOnly` flag on request) | external |
| SDK-registered custom tools | `custom-tool` | host-controlled |

Taxonomy key fields per kind are enumerated in §2. Note `shell` requests already
pre-parse `commands[].readOnly` and surface `possibleUrls`/`possiblePaths`/
`hasWriteFileRedirection` — Argus can key its risk score off these directly
rather than re-parsing command text.

---

## 4. Custom (native) tools

Register via `SessionConfig.tools: Tool<any>[]` (`types.d.ts:1556`; `Tool`
`:452`, `defineTool` `:487`). A tool = `{name, description, parameters (JSON
Schema or Zod), handler}`. Captured (`05-custom-tool.jsonl`):

- Registered `argus_echo`; the model called it and the SDK invoked the handler
  in-process. `tool-invocation` line shows the handler received
  `args={text:"hello-argus"}` and `ToolInvocation` (`types.d.ts:415`)
  `{sessionId, toolCallId, toolName}`.
- The call first raised a `permission.requested` with `kind:"custom-tool"`
  (`toolName:"argus_echo"`, `toolDescription`, `args`) — custom tools are
  permission-gated unless `skipPermission:true` (`Tool.skipPermission`
  `types.d.ts:466`).
- Handler return string became the tool result; model echoed `echo:hello-argus`.

This is the binding Argus will use to expose native tools (Jira, etc.) to Copilot.

---

## 5. Usage / cost fields

`assistant.usage` → `AssistantUsageData` (`session-events.d.ts:3672`). Captured
(`01-chat.jsonl`):
`{model, inputTokens:9482, outputTokens:100, cacheReadTokens:1792,
cacheWriteTokens:0, reasoningTokens:64, cost:0, duration:2049,
timeToFirstTokenMs, interTokenLatencyMs, initiator:"user", apiCallId,
serviceRequestId, providerCallId, finishReason, reasoningEffort}`.
Premium-request cost is `cost` (multiplier, `:3696`) and
`copilotUsage.totalNanoAiu` (`:3754`); both `0`/absent on this free tier.

`session.usage_info` → context-window accounting (`01-chat.jsonl`):
`{tokenLimit:128000, currentTokens, systemTokens, conversationTokens,
toolDefinitionsTokens, messagesLength, isInitial}`. Useful for a live
context-budget indicator.

Session shutdown carries aggregate `totalPremiumRequests` + `codeChanges`
(`docs/examples.md`; `session.shutdown`).

---

## 6. External MCP servers

Config: `SessionConfig.mcpServers?: Record<string, MCPServerConfig>`
(`types.d.ts:1840`). Stdio variant `MCPStdioServerConfig`
(`type:"stdio"|"local", command, args?, env?, workingDirectory?`,
`types.d.ts:1224`); HTTP/SSE variant `type:"http"|"sse", url, headers?` (`:1240`).

Captured (`06-mcp.jsonl`): the exact config sent is in the `meta.configSent`
line. The runtime emitted `session.mcp_servers_loaded` with
`servers:[{name:"argusEcho", status:"not_configured", transport:"stdio"}]`.

> **Finding / OPEN QUESTION:** despite a valid stdio config, the server loaded
> with `status:"not_configured"` and its `mcp_echo` tool was **never exposed** to
> the model (the model reported it had no such tool). In the default
> `mode:"copilot-cli"`, SDK-supplied `mcpServers` may require additional opt-in
> (`enableConfigDiscovery`, a trust/allow step, or `mode:"empty"` with explicit
> `availableTools`) to actually connect. **This must be resolved before Argus
> relies on MCP tool injection through Copilot.** The config-shape capture (the
> Task-7 goal) succeeded; the connection semantics did not, and are the top open
> item for the driver.

---

## 7. Auth shapes (happy + failure)

`client.getAuthStatus()` → `GetAuthStatusResponse` (`types.d.ts:2434`).

- **Happy** (`99-bonus.jsonl`, `09-models.jsonl`):
  `{isAuthenticated:true, authType:"gh-cli", host:"https://github.com",
  login:"JiaweiHan88", statusMessage:"JiaweiHan88 (via gh)"}`.
  `authType` enum: `"user"|"env"|"gh-cli"|"hmac"|"api-key"|"token"` (`:2438`).
- **Failure** (`10-auth-failure.jsonl`, second isolated client:
  `useLoggedInUser:false` + fresh empty `baseDirectory` + all GitHub token env
  vars stripped): `getAuthStatus()` → `{isAuthenticated:false,
  statusMessage:"Not authenticated"}` (no `authType`/`login`).
  `createSession` **still succeeded** while unauthenticated; the failure only
  surfaced on the first turn, via **three channels simultaneously**:
  1. a `session.error` event `{errorType:"authentication", message:"Execution
     failed: Error: Session was not created with authentication info or custom
     provider"}`,
  2. an **unhandled promise rejection** (crashes the process if untrapped),
  3. the awaited `sendAndWait(...)` rejection with the same message.

> **Design implications for Phase 3:**
> (a) The driver's `isAuthErrorMessage` predicate (Task 9 prereq #1) should match
> `errorType:"authentication"` on `session.error` and/or the substring
> `"Session was not created with authentication info"` — **prefer the typed
> `errorType`** over regex.
> (b) The driver MUST attach a `session.error` listener AND guard against
> unhandled rejections, because the auth error can escape the awaited call.
> (c) Probe auth cheaply up-front with `getAuthStatus()` before creating a
> session — it is reliable and turn-free.

---

## 8. Model slugs + the `auto`-only question

`client.listModels()` → `ModelInfo[]` (`types.d.ts:2490`). Captured
(`09-models.jsonl`) returned **exactly one** entry across all three probes
(cold, cached, and post-session):
`[{id:"auto", name:"Auto", capabilities:{supports:{}, limits:{max_context_window_tokens:0}}}]`.

**Answer: `auto`-only is the account tier (Copilot Free) + a server-side router —
NOT a timing/config/auth-path artifact.** Proof from `01-chat.jsonl`
`session.auto_mode_resolved`:
```
{chosenModel:"gpt-5-mini",
 candidateModels:["gpt-5-mini","claude-haiku-4.5"],
 categoryScores:{code_gen,debugging,tool_use,reasoning},
 predictedLabel:"no_reasoning", confidence:0.98, reasoningBucket:"low"}
```
`auto` is a per-turn classifier that routes between the account's real candidate
pool — **`gpt-5-mini` and `claude-haiku-4.5`** — based on task category. Across
fixtures the resolved `assistant.usage.model` was `claude-haiku-4.5` for
tool/agentic turns (104×) and `gpt-5-mini` for plain chat (10×); every tool call
id was Anthropic-format `toolu_bdrk_*`.

> **`COPILOT_MODELS` (Task 8/9):** for this tier the *selectable* catalog is
> `["auto"]`. The *effective* models are `gpt-5-mini` and `claude-haiku-4.5`,
> discoverable only at runtime from `turn_start`/`usage`/`auto_mode_resolved`, not
> from `listModels()`. A paid/Business tier is expected to widen `listModels()`
> and allow `SessionConfig.model` / `session.setModel()` (`session.d.ts:274`) to
> pin a specific slug — **verify on a paid account before shipping a model picker.**
> Session-scoped `session.rpc.models.list({})` returned `undefined` here
> (`09-models.jsonl`, `session.rpc.models.list` phase) — no extra models exposed.

---

## 9. Plan-mode verdict: **SUPPORTED (real, first-class).**

Not merely an analogue — the runtime models three agent modes:
`SessionMode = "interactive" | "plan" | "autopilot"` (`session-events.d.ts:70`).

- Set at runtime: `session.rpc.mode.set({mode})` (`rpc.d.ts:16061`,
  `ModeSetRequest` `:7624`); read: `session.rpc.mode.get()` (`:16055`).
- Exit handshake: `SessionConfig.onExitPlanModeRequest` (`types.d.ts:1794`),
  `ExitPlanModeRequest{summary, planContent?, actions[], recommendedAction}`
  (`:901`), `ExitPlanModeResult{approved, selectedAction?, feedback?}` (`:914`);
  events `exit_plan_mode.requested` / `exit_plan_mode.completed`.

Captured (`12-plan-mode.jsonl`): initial mode `"interactive"`; after
`mode.set({mode:"plan"})` a `session.mode_changed`
`{previousMode:"interactive", newMode:"plan"}` fired and `mode.get()` returned
`"plan"` (`planModeAccepted:true`). In plan mode the agent issued `read`
permission requests and attempted to write its plan to
`session-state/<id>/plan.md` (the infinite-session plan artifact), gated by the
`write` permission. The `exit_plan_mode.requested` callback did not fire in the
short capped turn (the model was mid-planning when the turn ended) — the
mechanism is proven; the full exit handshake is documented from types and is the
one plan-mode item still to observe end-to-end.

> **`capabilities` boolean:** `planMode: true`.

---

## 10. CLI discovery / bundling facts

- The SDK **bundles** the CLI runtime — no global `@github/copilot` install
  needed. `getStatus()` (`99-bonus.jsonl`) → `{version:"1.0.71",
  protocolVersion:3}`. `client.ping()` → `{message:"pong: ...", timestamp,
  protocolVersion:3}`.
- Default transport is **stdio**, spawning the bundled runtime
  (`CopilotClient` constructor default, `client.d.ts:66`). Overridable via
  `COPILOT_RUNTIME_TRANSPORT` env (`inprocess`/`stdio`, `client.d.ts:54`) or a
  `connection` option (TCP / external URI / custom binary path).
- Custom binary path via `COPILOT_CLI_PATH` env (`client.d.ts:449`); otherwise
  the bundled platform package (`prebuilds/<node-platform>-<arch>/runtime.node`,
  `client.d.ts:456`).
- `baseDirectory` sets `COPILOT_HOME` on the spawned runtime (`types.d.ts:220`);
  the spike pins it to `scripts/spike-copilot/.copilot-home` — **never** touching
  `~/.copilot`. Auth is resolved from gh-cli / stored OAuth when
  `useLoggedInUser` (default true, `types.d.ts:246`); explicit `gitHubToken`
  (`:239`) takes precedence.
- Boot time ~1–2s to first `getAuthStatus()`.

### Session persistence / resume format (§7-scenario 7)

- `session.sessionId` is a UUID v4; **stable across `resumeSession`**
  (`07-resume.jsonl`, `sameId:true`).
- State persists under `COPILOT_HOME/session-state/<sessionId>/` with
  `checkpoints/` (incl. `index.md`), `plan.md`, `files/` (`07-resume.jsonl`
  `sessionStateDir`; `docs/examples.md`). This directory **is** the "cursor" —
  there is no opaque cursor token; resume is by `sessionId` string.
- `resumeSession(id, config)` (`client.d.ts:226`) requires the id;
  `getLastSessionId()` (`:288`) returns the most recent, `getSessionMetadata(id)`
  (`:339`) → `SessionMetadata{sessionId, startTime, modifiedTime, summary,
  isRemote, context{workingDirectory, git}}` (`types.d.ts:2413`).
  `session.getEvents()` replayed 10 events including `session.shutdown` +
  `session.resume`; history continuity proven (model recalled "banana",
  `continuityProven:true`).

> **`onCursor` mapping (Task 8/9):** persist `sessionId` (string) as the Argus
> cursor; there is no separate cursor blob. `driver_kind` should be stamped at
> `createSession` time.

---

## 11. System-message / persona injection

`SessionConfig.systemMessage: SystemMessageConfig` (`types.d.ts:1615`), three
modes: `append` (default, keeps SDK guardrails, `types.d.ts:794`), `customize`
(section-level overrides, `:817`), `replace` (drops ALL guardrails incl. safety,
`:805`). Sections enum at `types.d.ts:753`.

Captured (`08-system-message.jsonl`): `{mode:"append", content:"...end every
reply with ZZQ-9137..."}`. Output was `"Hello! \n\nZZQ-9137"`
(`personaApplied:true`). **Append is the safe channel for Argus persona/skill
text** — it reaches the model without removing guardrails.

Skills: `SessionConfig.skillDirectories?: string[]` (`types.d.ts:1861`) load
skills from directories; `disabledSkills`, `instructionDirectories`,
`pluginDirectories` also available. `session.skills_loaded` event confirms
loading. Custom instruction files (`AGENTS.md`, `.github/copilot-instructions.md`,
`CLAUDE.md`) auto-load from `workingDirectory`; `skipCustomInstructions:true`
(`:1715`) opts out.

---

## Open questions (capture could not answer)

1. **MCP tools never connected** (`status:"not_configured"`, §6). What opt-in
   makes an SDK-declared stdio MCP server actually expose its tools in
   `mode:"copilot-cli"`? (Try `enableConfigDiscovery:true`, `mode:"empty"` +
   explicit `availableTools`, or a `.mcp.json` in the working dir.) **Top driver
   blocker.**
2. **Paid-tier model catalog.** Does `listModels()` widen beyond `auto`, and does
   `SessionConfig.model` / `session.setModel()` pin a specific slug, on a Pro/
   Business account? (Free tier is `auto`-only + router.)
3. **`exit_plan_mode.requested` end-to-end.** Need a longer plan-mode turn where
   the model completes a plan and requests exit, to capture the live
   `ExitPlanModeRequest` payload and the `actions[]`/`recommendedAction` values.
4. **`tool.execution_complete` full `result`/`error` shape** for a failing tool
   (only success paths captured here).
5. **Sub-agent (`task`) event stream** (`subagent.*`, `includeSubAgentStreaming
   Events`) — not exercised; relevant if Argus uses Copilot sub-agents.
6. **Premium-request accounting** on a tier where `cost`/`totalNanoAiu` are
   non-zero — confirm the field that Argus should meter.
