# Caelush Tool System

Phase 8C adds `exec_command` and `write_stdin`; Phase 8D adds read-only `git_status` and `git_diff`. All built-ins resolve the same injected `RuntimeResolver` and delegate to `RuntimeWorkspaceScope`; Git handlers do not use the shell execution service. `ToolDispatcher` continues to own the durable ToolInvocation/Observation lifecycle and maps `ToolExecutionUncertainError` to the existing uncertain-side-effect barrier. The final catalog is created by `createDefaultBuiltinToolRegistrations(resolver)` in one immutable order. See [Shell and Process Runtime](process-runtime.md), [Git Runtime](git-runtime.md), and [Tool Effects](tool-effects.md).

Caelush Phase 7 is fixed to exactly three rounds:

- Phase 7A — Tool Contracts, Registry & Schema Runtime
- Phase 7B — Tool Dispatcher & Durable Invocation Lifecycle
- Phase 7C — Tool Batch Coordination & Agent Runtime Integration

There are no additional Phase 7 rounds.

## Architecture

```text
                 ToolDispatcher
                      │
                      ▼
                 ToolRegistry
                      │
                      ▼
                Input Validator
                      │
                      ▼
               ToolInvocation
                      │
              Durable REQUESTED
                      │
                      ▼
               Execution Gate
                      │
                      ▼
                Durable RUNNING
                      │
                      ▼
                 ToolHandler
                      │
                      ▼
              ToolExecutionResult
                      │
                      ▼
               Output Validation
                      │
                      ▼
                ToolObservation
                      │
                      ▼
             Durable Settlement
```

`@caelush/protocol` owns the JSON-safe `ToolDefinition`, `ToolName`, `ToolInvocation`, `RiskLevel`, and `Capability` contracts. `@caelush/tools` owns the registration, schema runtime, output policy, and immutable registry. A `ToolRegistration` binds one definition to one handler; the handler has no independent tool name. The registry is the single source of truth for both model-visible definitions and future runtime resolution.

## Three Separate Layers

Prompt Guidance, Tool Definition, and Tool Runtime are related but different:

1. Prompt Guidance explains when to use tools, how tools should be selected, cross-tool preferences, and security behavior. It belongs to the Agent/System prompt layer, not the registry.
2. Tool Definition describes the model-facing name, concise purpose/boundary description, and input JSON Schema. Argument-specific guidance belongs in schema property descriptions.
3. Tool Runtime owns the handler and execution result. Phase 7B's Dispatcher owns the durable single-call lifecycle but still receives the handler, gate, clock, IDs, persistence, and event notification through injected ports.

This separation follows the design observed in the open-source Codex tool system. Codex keeps global tool instructions, model tool specifications, and executable tool runtimes distinct. Caelush adopts the boundary without copying Codex's host-specific tool list or execution machinery.

## Registry Invariant

Anything advertised to the model must resolve in the same `ToolRegistry` snapshot. `ToolRegistryBuilder` validates and copies registrations, compiles input and output schemas once, checks count and byte budgets, and creates an immutable ordered registry. `modelDefinitions()` and `resolve()` therefore cannot drift into separate model/runtime maps. Duplicate names are configuration errors and never shadow an existing registration.

The registry does not compose system prompts, developer prompts, AGENTS instructions, or cross-tool routing policy. This prevents a prompt from advertising a tool that is absent from the active catalog, the lesson highlighted by Codex issue #30648.

## Schema Runtime Policy

The schema runtime uses Ajv `8.20.0` with `allErrors: true`, `strict: true`, `coerceTypes: false`, `useDefaults: false`, and `removeAdditional: false`. Schemas compile at registry build time, not per invocation. Validation returns Caelush-owned issues containing only `instancePath`, `keyword`, and `message`, capped at 16 issues; raw schema and input data never enter the result.

Phase 7A tool schemas must have object roots and `additionalProperties: false` at the top level. Local references such as `#/$defs/value` are supported when Ajv can compile them deterministically. External references, async schemas, custom keywords, and external schema loading are rejected. Schema objects are canonicalized only for deterministic UTF-8 byte accounting: object keys are sorted, while array order and schema semantics are preserved. There is no lossy schema compaction; over-budget schemas fail closed.

## Model and Runtime Data

The model-facing projection contains only:

- `name`
- `description`
- `inputSchema`

`riskLevel`, `requiredCapabilities`, `runtimeRequirements`, and `outputSchema` are runtime metadata. They are not provider tool fields. `outputSchema` validates `ToolExecutionResult.details`, not `ToolExecutionResult.content`.

`ToolExecutionResult.content` is model-facing text. `details` is structured runtime/UI data, and `isError` is the shared error state. `ToolOutputPolicy` provides a common UTF-8-safe model content bound with an explicit `[output truncated]` marker; details have an independent byte budget and are rejected rather than lossy-truncated.

## Phase 7B Durable Lifecycle

`ToolDispatchRequest` is a JSON-safe boundary containing `sessionId`, `runId`, `stepId`, `externalCallId`, `toolName`, and `args`. The call identity is `(runId, stepId, externalCallId)`, and the storage layer also protects it with a revision CAS and a unique database constraint. Unknown tools return a model-recoverable unavailable result without fabricating an invocation or risk metadata.

For a known and valid tool, the Dispatcher persists `REQUESTED` before evaluating the injected `ToolExecutionGate`. `DENY` atomically settles a `FAILED` invocation with `PERMISSION_DENIED`; Phase 9B extends `REQUIRE_APPROVAL` to atomically persist `WAITING_APPROVAL`, one PENDING ApprovalRequest and `approval.requested`, then returns without invoking a handler. The historical Phase 7B boundary had no approval entity; the current durable workflow is documented in [Durable Approval Workflow](approval-workflow.md).

An `ALLOW` decision must first atomically commit `RUNNING` and the durable `tool.started` event. Only after that commit succeeds may the handler begin. This is the durable-before-side-effect boundary. The handler receives frozen invocation args. Its result is runtime-validated, passed through the injected Security sanitizer, revalidated, cloned, and bounded before a single atomic settlement writes the terminal invocation, one sanitized ToolObservation, and `tool.completed` or sanitized `tool.failed`. Sanitizer failure leaves the invocation at `RUNNING` for uncertain recovery.

`isError: true` is an expected, model-recoverable Tool failure and returns `RESULT`; it is not an infrastructure fatal error. An unexpected handler throw or output-contract violation is sanitized, durably represented as a generic failure when possible, and surfaced as `ToolDispatcherInfrastructureError`. The original exception is retained only as an internal cause.

`REQUESTED` is a safe recovery point: recovery may re-enter the gate and continue. `WAITING_APPROVAL` remains paused. A durable `RUNNING` invocation after restart is an uncertain side-effect boundary and fails closed with an uncertainty Observation; recovery never reruns that handler. Terminal invocations return their durable Observation without executing again. Registry drift during recovery is a fatal invariant, not an unknown-tool model result.

Every storage commit persists lifecycle data and durable events in one transaction. The Dispatcher notifies the EventBus only after the transaction commits, using the EventBus's existing `notifyCommitted` bridge. Missed notifications remain recoverable through durable replay. The Dispatcher does not mutate Run, AgentState, AgentStep, Conversation, or Continuation; batch orchestration and `LLMToolResultMessage[]` conversion belong to the controller-side Phase 7C integration.

## Phase 7C batch boundary

`ToolBatchCoordinator` is the only batch-level execution port. It depends on the public Dispatcher contract and keeps batch orchestration out of AgentLoop, Storage, LLM providers, and the concrete Runtime. The coordinator performs a complete preflight before the first dispatch: the batch is non-empty, IDs and Tool Names are schema-valid, external call IDs are unique and within the UTF-8 byte bound, arguments are JSON objects, and each item has exactly the allowed fields.

```text
LLM tool-call message
        │ source order
        ▼
RunController
        │ injected ToolBatchCoordinator
        ▼
ToolBatchCoordinator ── sequential ──► ToolDispatcher
        │                                  │
        │                                  ├─ ToolRegistry catalog + resolution
        │                                  └─ durable Invocation / Observation
        ▼
ordered ToolBatchItemResult[]
        │ identity-checked conversion
        ▼
LLMToolResultMessage[] → durable Continuation.receivedResults
        │
        ▼
one AgentLoop provider turn
```

Items are dispatched strictly in assistant source order; the coordinator never uses `Promise.all`, worker pools, or implicit parallelism. A normal `isError: true` Tool result is included and execution continues. An unavailable Tool is represented as a model-facing error without creating an Invocation. A `WAITING_APPROVAL` outcome stops the batch immediately, leaves trailing items untouched, and moves the Run to an explicit `WAITING_APPROVAL` continuation boundary. Phase 9B resolution resumes that same boundary through RunController and Coordinator recovery.

Recovery uses `ToolDispatcher.recoverOrDispatch()` for every item. A durable terminal Invocation is reused, a safe `REQUESTED` Invocation may continue, and a durable `RUNNING` Invocation is converted into an uncertainty result carrying the fixed `UNCERTAIN_SIDE_EFFECT` disposition. The coordinator then inserts generic `SKIPPED_AFTER_UNCERTAIN_EXECUTION` results for every trailing item without dispatching them. This is a fail-closed side-effect barrier: Phase 7 never guesses whether the interrupted handler completed.

The controller validates result count and `(externalCallId, toolName)` identity before converting results to provider-neutral `LLMToolResultMessage[]`; structured Tool details and internal Invocation/Observation IDs never enter that message. The complete ordered result batch is persisted in the Continuation before the next provider turn. If the process restarts after that acceptance but before the provider call, recovery resumes directly with the accepted batch and does not redispatch Tools.

The model catalog is read from the same immutable registry behind the Dispatcher. There is no second `RunExecutionConfig.tools` catalog and no ToolBatch database table: Run/State/Step, Conversation, Continuation, ToolInvocation, ToolObservation, and durable events remain the existing sources of truth.

## Phase 9B Durable Approval Boundary

The Phase 9A Gate remains storage-free. The Phase 9B/9C Dispatcher computes an exact host-internal approval key and checks only same-Run, exact-key RUN grants after the current monotonic Gate returns `REQUIRE_APPROVAL`; DENY always wins. Storage persists approvals and resolution events, while RunController owns locked resolution and continuation recovery. Approval actions are fact-driven safe previews and never contain raw arguments. A pending approval can pause one batch item, and a resolved approval resumes that item before any trailing calls. See [Durable Approval Workflow](approval-workflow.md) for transaction, TTL, scope, idempotency, and crash-recovery rules.

## Phase 8A built-in Runtime boundary

Phase 8A adds a one-way execution dependency:

```text
ToolHandler
    │
    ▼
Runtime
    │
    ▼
LocalRuntime
    ├── RuntimeFileSystem → Node filesystem
    ├── RuntimeFileDiscovery → fast-glob
    └── RuntimeTextSearch → fixed rg adapter
```

`ToolRegistry`, `ToolDispatcher`, and `ToolBatchCoordinator` remain generic. They do not know `LocalRuntime` or any filesystem semantics. Only the four built-in handlers in `packages/tools/src/builtins/` resolve the data-only `ToolExecutionEnvironment` through an injected `RuntimeResolver`, open the `AgentRun.workspace`, and call the narrow Runtime capabilities. `@caelush/runtime` has no dependency on Tools, Core, Storage, Events, LLM, Context, Security, or Verification.

All Phase 8A file paths are workspace-relative. A `WorkspacePathResolver` first applies lexical containment beneath the normalized workspace root and then realpath containment beneath the resolved workspace root. Existing symlink targets must remain inside the workspace; recursive discovery and search do not follow symlink directories. Model-facing paths use `/` separators and never expose host absolute paths.

The four registrations are ordered `read_file`, `list_directory`, `find_files`, and `search_text`. The final default catalog appends `apply_patch`, `exec_command`, `write_stdin`, `git_status`, and `git_diff` in that order. `riskLevel`, `requiredCapabilities`, and `runtimeRequirements` remain metadata in Phase 8; permission and approval decisions belong to Phase 9.

## Phase 8B verified mutation boundary

`createFileMutationToolRegistrations(resolver)` exposes only `apply_patch`; it is intentionally separate from category factories but is included by the final default catalog. Its metadata is `HIGH` risk with `FS_WRITE` and `FS_DELETE`, but those fields are not an authorization decision before Phase 9.

The handler accepts exactly `{ patch: string }`, resolves the existing data-only `ToolExecutionEnvironment` through `RuntimeResolver`, and delegates to `RuntimeWorkspaceScope.patch`. It does not parse model paths, import Node filesystem APIs, calculate hashes, write files, query Storage, or implement rollback. Runtime owns the `PatchParser → PatchPlanner → PreparedPatch → PatchCommitter` pipeline and returns only bounded per-file summaries.

Patch mutation rejects symlink paths and existing symlink ancestors, requires regular UTF-8 text sources, refuses existing Add/Move destinations, preserves BOM/newline/final-newline semantics, checks all source hashes and sizes before the first write, and rolls back a committed prefix when an in-process commit fails. A rollback that cannot be verified is a Tool-owned `UNCERTAIN_SIDE_EFFECT`; Batch then skips trailing calls. No automatic replay is implied by the hash guard.

## Security and Phase Boundaries

`riskLevel`, `requiredCapabilities`, and `runtimeRequirements` are metadata, not authorization. Permission, capability and risk evaluation, and approval enforcement belong to Phase 9. Phase 8A remains strictly read-only; Phase 8B adds verified text patch mutation; Phase 8C adds shell/process; Phase 8D adds read-only Git, effects, and final catalog integration. The patch engine is best-effort and not OS-level atomic, crash-atomic, exactly-once, sandboxed, or a production permission evaluator.

Phase 7 does not implement a concrete permission evaluator, Approval manager or resolution endpoint, Runtime, filesystem/shell/process/git Tool, retry, timeout, cancellation, parallelism, or Verification execution. The user-visible durable `tool.requested` event contract contains only `invocationId`, `toolName`, optional `externalCallId`, and `riskLevel`; it never contains raw arguments. `ToolObservation` retains the bounded model-facing content and validated details privately. The RunController integration owns only the batch/runtime boundary; AgentLoop remains unaware of Dispatcher, Invocation, Observation, Storage, and EventBus.
