# Agent Loop Architecture

Caelush Phase 6 is fixed to exactly three rounds:

1. **6A Contracts & State**
2. **6B Context → LLM Resumable Decision Loop**
3. **6C Run Controller / Persistence / Events**

No additional Phase 6 rounds.

## Phase 6B execution boundary

Phase 6B is the first real `AgentLoop`, but it is intentionally a resumable decision loop rather than a local tool-execution loop. Every `run()` or `resumeWithToolResults()` invocation performs at most one provider turn and returns control to its caller at a stable boundary.

```text
Start / Resume input
  ↓ validate immutable Run + State pair
Step Gate (maxSteps only)
  ├── exhausted → MAX_STEPS_REACHED outcome
  ↓
ProjectInspector
  ↓
RelevantFilePlanner
  ↓
ContextBuilder
  ↓
LLMRequest composer
  ↓
one AgentLLMClient provider turn
  ↓
classifyAgentDecision
  ├── TOOL_CALLS_REQUESTED → external Tool boundary
  │                              ↓
  │                         RunController coordinates ToolBatch
  │                         through an injected coordinator
  │                              ↓
  │                         normalized complete result batch
  │                              ↓
  │                         resumeWithToolResults()
  │
  └── FINAL_CANDIDATE → VERIFYING boundary
                         ↓
                   Phase 6C / future Verification
```

The loop owns orchestration and immutable returned projections: updated `AgentState`, one `AgentStep`, a `ContextBuildReport` when context preparation started, an `AgentLoopOutcome` or sanitized failure, and messages that the caller may append to durable history. It does not own persistence, event publication, or a second copy of the Run state machine.

## Ports and dependency direction

`@caelush/core` depends on the public `@caelush/context` entry point, Protocol, and provider-independent LLM narrow subpaths (`/messages`, `/request`, `/turn`, `/errors`). Runtime implementations are injected through these ports:

| Port                                | Responsibility                                          | Explicitly not owned by Core                       |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `AgentProjectInspectorPort`         | Read project intelligence for the current workspace/cwd | Shell, credentials, tool execution                 |
| `AgentRelevantFilePlannerPort`      | Select task-relevant file context                       | Prompt rendering or model calls                    |
| `AgentContextBuilderPort`           | Assemble bounded provider-independent messages          | Provider SDK types or retries                      |
| `AgentLLMClient`                    | Perform one validated provider turn                     | Tool execution, loop retries, Gateway policy       |
| `AgentClock` / `AgentStepIdFactory` | Supply time and step identity                           | Global clocks or generated IDs inside pure helpers |

Core production code must not import the root `@caelush/llm` entry, AI SDK packages, filesystem/network APIs, concrete tools, ToolRegistry, ToolDispatcher, Storage, EventBus, Daemon, or host runtime types. The real integration test composes the existing local Context ports with `LLMGateway`, while the production loop remains unaware of the concrete provider.

## User Turn and Open User Turn

The ContextBuilder receives one of two explicit current-turn modes:

- `USER_TURN`: the current user goal is a new user message. Context order is `System → previous completed history → relevant-file synthetic user context → current user message`.
- `TOOL_CONTINUATION`: the current turn is the complete open conversation group from the original user message through the assistant tool request and the normalized tool results. Context order is `System → previous completed history → relevant-file synthetic user context → whole current turn`.

The continuation must contain no system message, exactly one structurally valid conversation group, and end with a tool message. The builder never duplicates the original goal, never treats an assistant/tool suffix as ordinary history, and reports current-turn message count and estimated tokens separately. In continuation mode current-user tokens are zero; the complete open turn is the mandatory current payload.

Relevant-file context is synthetic and belongs to the current model input, but it is never appended to durable conversation history. Only the current user message, the assistant response, normalized tool results, or the max-step boundary message are returned in `messagesToAppend`.

## Resume integrity and ordering

`resumeWithToolResults()` first validates and normalizes the external batch with the Phase 6A helper. The batch must contain exactly one result for every pending request, match both external call identity and tool name, and may contain an error result. Results can arrive in completion order, but the normalized batch is emitted and inserted into model history in assistant source order.

The loop also validates the assistant tail that introduced the pending request. It rejects missing or malformed assistant tool calls, mismatched ID/name/arguments, duplicate supplied result IDs, and histories that do not end at the expected open turn. Unknown schema-valid tool names are preserved for the later Tool System; Core does not consult a concrete tool registry.

Input Run, State, history, and tool definitions are caller-owned. The loop does not mutate them; every returned state, step, and append list is a new projection. A caller contract violation raises `AgentLoopInputError` or returns a sanitized failure before expensive ports are called, according to the boundary where it is detected.

## Step, state, usage, and append ledger

One settled provider turn equals one Agent Step attempt, including a provider failure or rejected model output after step creation. The step is created only after the gate and context/request preparation succeed. A preparation failure therefore creates no step and does not increment usage. A provider/model failure settles a failed step, increments `UsageState.steps`, preserves the Run as `RUNNING`, and returns a sanitized `AgentLoopFailureResult`.

`UsageState.steps` counts settled attempts. `UsageState.toolCalls` remains reserved for actual external Tool invocation accounting and is not incremented when the model merely requests a tool. Only known input/output token fields are accumulated; the loop does not invent totals, cached-token counts, or reasoning-token counts.

The append ledger is explicit:

| Boundary                          | `messagesToAppend`                               |
| --------------------------------- | ------------------------------------------------ |
| Successful start                  | current user message, assistant message          |
| Successful resume                 | normalized tool results, assistant message       |
| Provider/model failure after step | current prefix already accepted at that boundary |
| Invalid tool-result batch         | empty                                            |
| Max-step start                    | current user message                             |
| Max-step resume                   | normalized tool results                          |
| Synthetic relevant-file context   | never appended                                   |

Final text is a `FINAL_CANDIDATE`, not a completion claim. The successful final boundary moves state to `VERIFYING`; Phase 6B never enters `COMPLETED` and never executes Verification.

## Error and policy ownership

The loop has no retry, backoff, timeout policy, run-level cancellation, or tool execution. It owns only the structural `maxSteps` gate. Phase 10D adds an injected pre-Provider admission hook so the controller can reserve budget and clamp output before a Step is persisted; the loop still does not know SQLite, pricing, or a concrete budget manager. Provider and Context failures are mapped to fixed, sanitized public Agent errors; raw prompts, tool arguments, provider payloads, credentials, hidden reasoning, and secrets are excluded.

`AgentLLMClient.complete()` is called exactly once per loop invocation. The client may be an injected `LLMGateway`, but Core does not know its registry, provider adapter, SDK, call lifecycle, or stream implementation. This preserves the one-provider-turn contract and leaves repeated execution policy to the next layer.

## Phase 7 runtime integration

Phase 7 adds the durable runtime outside the loop. `RunController` receives an injected `ToolBatchCoordinator`, obtains the model catalog from that same Dispatcher-backed Registry, and drives one ordered Tool batch after an `AgentLoop` Tool-call boundary. The loop still returns after one provider turn and remains unaware of Dispatcher, ToolInvocation, ToolObservation, Storage, and EventBus. The controller converts only identity-checked, model-facing content into `LLMToolResultMessage[]`, persists the complete batch in the Continuation, and then invokes the loop's resume method for the next single provider turn.

Approval is a durable controller boundary, not a hidden loop state. A batch stops before its first approval-gated call's followers, records the waiting Invocation pointer, and returns `WAITING_APPROVAL`. Recovery uses the Dispatcher uncertainty barrier: a durable `RUNNING` Invocation produces a sanitized uncertainty result and all later calls become explicit skipped results without handler execution.

## Phase boundaries

## Phase 10A cancellation boundary

The `AgentLoop` accepts a host-only `AbortSignal` and returns a typed `CANCELLED` result when cancellation wins at preparation, lifecycle, provider, or result-classification safe points. It forwards the signal to the injected LLM client, never appends partial assistant output, and never maps cancellation to a model failure. A provider attempt that actually started settles its Step once; a provider that ignores abort has its late result discarded by the post-resolution signal check. Run-level intent persistence, scope ownership, resource cleanup, and terminal Run settlement remain responsibilities of `RunController` and the execution store. See [Run Cancellation](cancellation.md).

## Phase 10B timeout boundary

The loop continues to accept the host-only signal and returns a typed `CANCELLED` result when interruption wins. It does not inspect the deadline, create timers, or choose between `CANCELLED` and `TIMEOUT`. `RunController` compares the durable absolute deadline, supplies the abort cause to the execution scope, and performs cleanup plus terminal persistence. Therefore a late Provider result cannot turn an expired Run into a future Tool request or Verification continuation. See [Run Deadline and Timeout](timeout.md).

## Phase 10C provider retry boundary

The loop still performs exactly one Provider turn per invocation and owns no
sleep, timer, retry policy, or Tool execution. For a transient `LLMError`, it
returns a sanitized retry projection containing only the safe transient code,
retryability, and optional bounded Retry-After hint. The outer RunController
uses that projection to settle the failed Step and persist `WAITING_RETRY`.

Each wake invokes the loop again with a new Step and a new Gateway-owned
`LLMCallId`. A retry after an open Tool turn uses the original pending decision
and normalized results with `resumeWithToolResults()`; it does not invoke the
Tool coordinator. Partial Provider output and retry attempts are never added to
the durable Conversation. See [Provider Retry and Backoff](retry.md).

## Phase 10D budget boundary

The controller's admission hook estimates the complete provider request and
performs durable reservation before the Provider call. The loop receives a
clamped request only when admission succeeds; a blocked admission returns
without creating a durable Step. Usage settlement is conservative when the
Provider does not return safe usage, and budget finalization never turns a
final candidate directly into `COMPLETED`.

Phase 6A defines deterministic decisions, steps, tool-result normalization, state helpers, and the `maxSteps` gate. Phase 6B connects those contracts to Project Intelligence, Relevant File Planning, ContextBuilder, and one LLM turn, then stops at the external Tool or Verification boundary. Phase 6C adds the durable RunController boundary described in [Run Controller](run-controller.md); Phase 7C extends that controller with ordered Tool batches while the AgentLoop itself remains Tool-execution unaware. The controller still never verifies a candidate or claims `COMPLETED`.
