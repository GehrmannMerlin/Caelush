# Project

Caelush 是一个 TypeScript/Node.js 通用 Agent Kernel 项目。CLI、Web 和本地服务未来共享同一个 Core；它们不是各自拥有一套 Agent 实现的独立产品。

## Architecture Rules

- CLI/Web 不拥有独立 AgentLoop；所有 Agent 执行由共享 Kernel 负责。
- 依赖方向为 `apps → packages`；任何 package 都不允许依赖 app。
- `@caelush/protocol` 是稳定、底层的 Contract Package，不依赖其他 Caelush feature package，也不依赖 app。
- AgentLoop 未来不得硬编码具体 Tool，也不得硬编码具体 Provider。
- Tool 必须经过 Dispatcher；Permission 与 Runtime/Sandbox 是不同边界。
- Runtime 必须可替换，不能把本地执行细节写死在 Core。
- 用户可见的执行过程来自 AgentEvent/Event Stream，而不是 UI 自己猜测 Core 状态。
- 任务完成必须经过 Verification，不能只根据 LLM 的自然语言结束判断完成。
- Protocol Schema 是跨 package Contract 的 source of truth；Protocol 值必须保持 JSON-safe，不能泄漏 Provider SDK、数据库、Runtime 或 UI 类型。
- ToolDefinition 只能是数据描述；可执行函数、Dispatcher、Permission 和 Runtime 实现必须留在后续对应 package。
- Run status 迁移必须经过 Core 的 canonical Run State Machine；不能在调用方复制一套转移规则。
- Durable Event 的 sequence 是恢复和消费的权威顺序，不能用 timestamp 代替；Step 与 PlanItem 也必须保持不同职责。
- Durable Event 必须先持久化、再发布；EventBus 的 replay 使用排他游标并与 live watch 无缝衔接，不能重复或丢失事件。
- Storage 必须通过显式 SQLite 路径与 committed migration 初始化；public API 不能泄漏 `DatabaseSync`、Drizzle client 或数据库 row 类型。
- Repository 负责 Protocol entity 的 CRUD 与 JSON codec；数据库列只做查询索引，不能演变成第二套状态模型或 Event Sourcing projection。
- 公共 API 只能从每个 package 的 `src/index.ts` 进入；禁止 `@caelush/*/src/...` 和深层相对路径跨 package import。
- Daemon 是唯一的本地 Service Composition Root；CLI/Web 不得创建自己的 Agent runtime。
- Production daemon 默认只能绑定 loopback；不得启用 permissive CORS。
- HTTP routes 必须保持薄；Application Service 不得依赖 Fastify；API DTO 属于 Protocol 且必须保持 transport/runtime free。
- Run creation 不代表 run execution；PENDING Run 不得发布 `run.started`。
- Durable SSE event 使用 Durable sequence 作为 SSE id；Ephemeral SSE event 永远不得携带 SSE id。
- SSE route 必须消费 `EventBus.watch()`，不得重新实现 replay；graceful shutdown 必须先关闭 streaming consumers，再关闭 Storage。
- Cancellation endpoint 必须等到真实 abort semantics 存在后实现；Approval resolution endpoint 必须等到 ApprovalManager 存在后实现。
- Caelush owns the AgentLoop.
- An LLM provider performs exactly one provider turn.
- LLM providers never execute local tools.
- AI SDK types must not leak outside provider adapter implementations.
- Provider credentials are runtime-only.
- Raw model chain-of-thought must not enter public Caelush contracts.
- Tool definitions passed to LLMs remain data-only.
- LLM retry policy is not owned by provider adapters.
- Do not create global provider registries.
- LLMGateway owns LLMCallId lifecycle.
- Providers must receive the gateway-owned call id via runtime call context.
- Providers must not generate their own Caelush LLM call ids.
- Every provider stream event must pass runtime schema validation.
- Provider stream.start identity must match the selected call/provider/model.
- Gateway performs cross-field request semantic validation.
- Gateway must never silently repair malformed provider stream events.
- External abort, timeout, and consumer cancellation are distinct internal causes.
- Gateway does not retry.
- Gateway does not execute tools.
- One gateway invocation equals one provider turn.
- AI SDK runtime imports are allowed only inside provider adapter implementations under `packages/llm/src/providers/`.
- OpenAI-compatible adapters must implement the existing `LLMProvider` contract and must not weaken the Gateway to accept provider-specific stream formats.
- Adapters must never generate Caelush `LLMCallId` values; they must forward the Gateway-owned `AbortSignal` unchanged.
- Adapters must not own timeout or retry policy; AI SDK automatic retry must be disabled with `maxRetries: 0`.
- AI SDK tools must not contain `execute` callbacks or local tool execution hooks.
- Provider raw reasoning content must be dropped, and provider SDK types must never leak through `@caelush/llm` public contracts.
- OpenAI-compatible streaming quirks must be characterized through the real AI SDK path before adding adapter behavior; do not infer compatibility from mocked `streamText` calls.
- The Gateway must remain provider-independent; never weaken its schemas or lifecycle rules for one provider's malformed stream.
- Adapters must not synthesize tool-call identity, silently merge duplicate IDs, or use a `latestToolCall` heuristic for an ambiguous delta.
- Ambiguous tool identity must fail closed as a sanitized `LLMInvalidResponseError`; raw SSE, credentials, prompts, and tool arguments must not enter public error messages.
- A compatibility workaround must be adapter-private, deterministic, narrowly tested, and documented with its removal condition; prefer an upstream fix when a pinned regression is fixed.
- Do not patch `node_modules`, use `pnpm patch`, or upgrade pinned AI SDK dependencies unless a failing pinned regression and verified stable exact-version fix justify it.
- OpenAI-compatible compatibility tests must exercise real OpenAI-shaped SSE through `LLMGateway → OpenAICompatibleLLMProvider → streamText → @ai-sdk/openai-compatible → fetch`.

Phase 6 rules:

- Phase 6 contains exactly 6A, 6B, and 6C; do not add additional Phase 6 rounds.
- One settled LLM provider turn is one Agent Step attempt.
- Agent decisions are limited to `TOOL_CALLS_REQUESTED` or `FINAL_CANDIDATE`; structural max-step exhaustion is an `AgentLoopOutcome` rather than an LLM decision.
- Tool execution is outside the Phase 6 Agent Kernel. Phase 6 must never execute a Tool directly.
- Tool calls with a `LENGTH` finish reason must never be executed because their arguments may be truncated even if the partial JSON parses.
- A final model response is only a `FINAL_CANDIDATE` and must move the Run toward `VERIFYING`, never directly to `COMPLETED`.
- Agent Kernel code must not know concrete tools such as `read_file`, `shell`, or `apply_patch`.
- Tool result batches must contain exactly one matching result for every requested tool call before the next provider turn.
- Parallel tool results may arrive in completion order but must be normalized to assistant source order before entering model history.
- Public reasoning summaries must never expose raw hidden reasoning, model answer text, tool arguments, or secrets.
- `UsageState.steps` counts settled Agent Step attempts, including failed attempts.
- `UsageState.toolCalls` is reserved for actual Tool invocation accounting and is not incremented merely because the model requested tools.
- Phase 6A owns only `maxSteps` as a structural loop guard; retry, timeout, token/cost budgets and tool-call budgets remain Phase 10 responsibilities.
- Phase 6A Kernel helpers must be deterministic and must not own wall-clock time or ID generation.
- Phase 6B `AgentLoop.run()` and `resumeWithToolResults()` each perform at most one `AgentLLMClient.complete()` call and return at an external Tool or Verification boundary.
- Phase 6B is a resumable decision loop, not a Tool execution loop; Core must never invoke a concrete Tool, ToolRegistry, ToolDispatcher, Runtime, Storage, EventBus, RunController, or Verification executor.
- `AgentLoop` must receive ProjectInspector, RelevantFilePlanner, ContextBuilder, LLM client, clock, and Step ID factory through injected ports; Core production code may use only public Context and narrow provider-independent LLM contract subpaths.
- A Tool continuation must preserve the complete open user turn, including the original user message, assistant tool-call message, and normalized tool results; it must not duplicate the original goal or treat the open turn as ordinary completed history.
- Tool results must be normalized in assistant source order before entering model history. Invalid batches and invalid caller history are rejected without provider calls; unknown schema-valid tool names remain outside Core's concern.
- Relevant-file context is synthetic model input and must never be returned as a durable-history append. The append ledger contains only caller-visible user, assistant, normalized tool-result, and max-step boundary messages.
- Context preparation failures create no AgentStep and do not increment usage. Provider/model failures after step creation settle a failed step, increment `UsageState.steps`, preserve `RUNNING`, and return a sanitized failure.
- Input Run, State, history, and Tool definitions are caller-owned and must not be mutated. `maxSteps` is the only Phase 6B loop gate; retry, timeout, cancellation, token/cost budgets, doom-loop detection, and tool-call budgets remain later responsibilities.

Phase 7 rules:

- Phase 7 contains exactly 7A, 7B, and 7C; do not add additional Phase 7 rounds.
- `ToolRegistry` is the single source of truth for active tools. The model-visible `ToolDefinition` catalog must be derived from the same registry that resolves executable handlers.
- Never maintain separate model-tool and runtime-tool maps that can drift. A `ToolRegistration` binds one `ToolDefinition` to one `ToolHandler`; duplicate `ToolName` registration is a configuration error and must never silently overwrite another tool.
- `ToolRegistry` is immutable after build. Tool definitions and nested JSON schemas must be copied and deeply frozen at registration boundaries so caller mutation cannot alter the active catalog.
- Tool input and output schemas compile once at registry build time, not once per invocation. Validation must not coerce values, insert defaults, remove properties, or mutate arguments.
- Phase 7A function-tool input and output schemas must be object-root schemas with top-level `additionalProperties: false`. External refs, async schemas, custom keywords, and external schema loading are rejected.
- Phase 7A does not perform lossy model-facing schema compaction. Oversized schemas and catalogs fail registration/build.
- Tool descriptions are model-facing prompt surface and must be concise. Argument-specific instructions belong in schema descriptions rather than duplicated global prompt text.
- `riskLevel`, `requiredCapabilities`, `runtimeRequirements`, and `outputSchema` are runtime metadata and must not leak into provider-specific model tool definitions unless a future contract explicitly requires them.
- `ToolExecutionResult.content` is model-facing text. `ToolExecutionResult.details` is structured runtime/UI data, and `ToolDefinition.outputSchema` validates `details`, not `content`.
- Phase 7A defines Tool contracts and registry only. It does not execute tools, persist invocations/output, publish tool events, evaluate permissions, or request approvals. Real Tool execution begins only in Phase 7B.
- Phase 7B owns the injected single-Tool Dispatcher and durable invocation lifecycle. Every valid execution must persist `REQUESTED`, pass the injected Gate, persist `RUNNING` and `tool.started` before the handler begins, then validate and atomically settle the Observation with the terminal lifecycle event.
- Tool execution must not begin before the durable `RUNNING` checkpoint. A stale `RUNNING` invocation after restart is an uncertain side-effect boundary and must fail closed without rerunning the handler; `REQUESTED` is the safe recovery point.
- `ToolExecutionResult.isError` is a model-recoverable Tool failure, not an infrastructure fatal error. Unexpected handler throws and output-contract failures are sanitized infrastructure failures after a best-effort durable failure settlement.
- ToolInvocation args and ToolObservation details are cloned/frozen at boundaries. Raw args, invalid output, credentials, and handler exception text must not enter public lifecycle events or sanitized error messages.
- ToolDispatcher uses only the immutable ToolRegistry, injected Gate, execution Store, clock, ID factories, and committed-event notifier. It does not implement Security, Approval resolution, Runtime, retry, timeout, cancellation, parallelism, AgentLoop, RunController, Tool batches, or LLM tool-result conversion.
- Phase 7B does not mutate Run, AgentState, AgentStep, Conversation, or Continuation. Phase 7C owns the later Tool batch and Agent runtime integration boundary.
- Filesystem, Shell, Process, and Git handlers belong to Phase 8. Permission, risk evaluation, capability evaluation, and approval enforcement belong to Phase 9.

Phase 5A context rules:

- `@caelush/context` owns workspace/project discovery but does not assemble LLM prompts.
- Workspace root, project root, and cwd are distinct concepts.
- Project discovery must never walk above the Workspace boundary.
- Context filesystem access is read-only and must remain behind `ContextFileSystem`.
- Project root detection is evidence-driven and must not rely on shell commands.
- Project detection must not recursively scan the repository during Phase 5A.
- Project instructions are discovered from project root to cwd; within one directory `AGENTS.override.md` takes precedence over `AGENTS.md`, which takes precedence over configured fallback files.
- Project instruction reads must stay inside the real Workspace boundary.
- Project manifest parse failures produce diagnostics; unreadable project instructions fail closed.
- Context discovery must not expose `process.env`, credentials, or provider configuration.
- `ProjectIntelligenceSnapshot` is runtime project knowledge, not a persisted Storage snapshot and not an LLM prompt.
- Context must not depend on `@caelush/llm` during Phase 5A.

## Development Rules

- 优先最小改动，保护已有用户文件和已有架构决策。
- 不要提前实现未来 Phase；YAGNI，只有当前代码确实需要时才添加依赖。
- 修改行为必须先写测试并观察测试失败，再写最小实现；纯配置文件可不制造形式测试。
- 保持小文件、单一职责、严格 TypeScript、ESM、无循环依赖。
- 新增内部依赖时使用 `@caelush/*` 包名和 `workspace:*` 协议。
- 结束前运行 `pnpm check`，并检查 `git status --short` 与 `git diff`。

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check
```

## Phase 6C Durable Runtime Rules

- Phase 6C is the final Phase 6 round; do not introduce Phase 6D.
- `RunController` owns Run lifecycle orchestration but never executes Tools or Verification and never transitions a final candidate directly to `COMPLETED`.
- Run, State, Step, real conversation messages, continuation checkpoints, and durable lifecycle events settle through one atomic execution commit.
- Durable event sequence is the canonical chronology; timestamps are metadata only. Persist durable events before notifying live subscribers.
- Durable conversation contains only user, assistant, and external tool-result messages; system prompts, project instructions, relevant-file context, and other synthetic context never enter the ledger.
- `WAITING_TOOL_RESULTS` and `AWAITING_VERIFICATION` are durable recovery boundaries. Tool Results are normalized and durably accepted before resuming the next provider turn.
- A stale `RUNNING` Step after restart fails closed and is never automatically resent to the provider. Recovery is local-host durable recovery, not distributed exactly-once execution.
- Phase 6C adds no retry, Tool execution, Verification execution, run-level cancellation, or `COMPLETED` transition.

## V1 Phase Boundary

## Phase 8A Local Runtime and Filesystem Rules

- Phase 8 contains exactly 8A, 8B, 8C, and 8D; never add another Phase 8 round.
- Phase 8A is strictly read-only. File mutation, patching, shell execution, managed processes, and Git tools are forbidden in 8A.
- Runtime is an execution substrate and must never depend on Tool System, Core, Storage, Events, LLM, Context, Security, or Verification.
- Built-in Tool handlers may depend on Runtime. The dependency direction is tools → runtime, never runtime → tools.
- `AgentRun.workspace` is the source of truth for the Runtime workspace, and `AgentRun.runtime` is the source of truth for Runtime selection.
- Phase 8 built-in file paths are workspace-relative and are never resolved from `process.cwd()`.
- Tool execution may carry only a data-only `ToolExecutionEnvironment` containing `WorkspaceRef` and `RuntimeRef`. It must never carry a Runtime object, Storage service, EventBus, permission manager, or other mutable service object.
- Workspace paths require both lexical containment and realpath containment. Symlinks that resolve outside the workspace must fail closed.
- Recursive file discovery must not follow symbolic links. Model-facing paths must always be workspace-relative and use forward slashes.
- Runtime workspace containment is a correctness boundary, not Phase 9 authorization. Direct `read_file` must not implement secret-file permission policy.
- `read_file` returns bounded valid UTF-8 text. Binary or invalid UTF-8 inputs are model-recoverable Tool errors, and large reads must be paginated and byte-bounded.
- `find_files` has deterministic bounded results. `search_text` uses a fixed ripgrep backend with `shell=false`; models must never control the executable or arbitrary CLI arguments.
- Ripgrep unavailability is a model-recoverable Tool error; malformed runtime output is an infrastructure error.
- Phase 8A must not introduce non-atomic `file.read` event side channels. The Phase 7 durable ToolInvocation and ToolObservation lifecycle remains the execution/audit mechanism for read-only tools.
- No filesystem mutation is allowed in Phase 8A.

## Phase 8B Safe File Mutation and Patch Rules

- Phase 8B is the current and only mutation round. Phase 8 remains exactly 8A, 8B, 8C, and 8D; do not create 8B-1, 8B-2, 8E, or another Phase 8 round.
- Reuse the Phase 8A `LocalRuntime`, `RuntimeWorkspaceScope`, `WorkspacePathResolver`, and data-only `ToolExecutionEnvironment`. Do not create V2 runtime/path/environment APIs.
- The only formal mutation Tool surface in 8B is `apply_patch` with strict JSON input `{ patch: string }`; the final default catalog remains deferred to 8D.
- Patch execution is `Parse → Plan → Prepare → Guard all → Commit sequentially → Verify`; parsing/preparation must perform zero workspace mutation, and one hunk failure prevents every mutation.
- Runtime owns `PatchParser`, `PatchPlanner`, `PreparedPatch`, `PatchCommitter`, and `RuntimePatchService`; Tools owns only the thin handler/registration. Runtime must never import Tools, Core, Storage, Events, Security, or Verification.
- Do not expose generic `writeTextFile`, `overwriteFile`, `deleteAnything`, or `rawWrite` APIs. Patch-private mutation primitives may be called only by `PatchCommitter`.
- Mutation paths are stricter than read paths: sources and existing ancestors may not be symlinks; Update/Delete/Move sources must be regular UTF-8 text files; Add/Move destinations must be absent; missing destination parents are created only after containment/symlink checks.
- Enforce bounded patch bytes/files/hunks/target/prepared bytes and reuse the existing workspace-relative path byte budget. Never add a special invocation channel that bypasses the Dispatcher argument limit.
- Existing source bytes, SHA-256/size version, BOM, preferred newline, and final-newline state are prepared before commit. New files use UTF-8 LF without BOM. Hunk matching is exact and unique; never apply fuzzy guesses.
- Before the first mutation, every source must still have the prepared regular-file type, size, and raw-byte hash, and every Add/Move destination must still be absent. A stale guard produces `PATCH_STALE` or `HASH_GUARD_MISMATCH` with zero mutation.
- Commit is deterministic and sequential. On ordinary in-process failure, stop the remaining operations, rollback the committed prefix in reverse order, remove only empty directories created by this transaction, and verify exact restoration. This is best-effort, not OS-level atomic, crash-atomic, fully transactional, or exactly-once.
- Rollback failure or verification mismatch throws runtime-owned `RuntimePatchUncertainError`; the handler maps it to Tool-owned `ToolExecutionUncertainError`, Dispatcher durably records `UNCERTAIN_SIDE_EFFECT`, and Batch skips trailing calls. A recovered RUNNING patch is never automatically rerun.
- Do not add file events, `AgentState.changedFiles`, Storage tables/migrations, shell/Git delegation, watcher/LSP/formatter side channels, or Phase 9 permission evaluation. Risk/capability metadata is not authorization in 8B.

## Phase 7C Tool Batch and Runtime Integration Rules

- Phase 7 contains exactly 7A, 7B, and 7C; do not add Phase 7D.
- `ToolBatchCoordinator` is the only batch-level Tool execution port. `AgentLoop` remains unaware of Dispatcher, Invocation, Observation, Storage, EventBus, Runtime, and concrete Tool handlers.
- The coordinator must preflight the complete batch before the first dispatch. Reject empty batches, malformed IDs/names/JSON objects, duplicate `externalCallId` values, oversized UTF-8 identities, and extra fields without side effects.
- Tool calls execute sequentially in assistant source order. Do not use `Promise.all`, worker pools, implicit parallelism, or a completion-order result contract in Phase 7C.
- The model-visible catalog and runtime resolution must come from the same immutable `ToolRegistry` behind `ToolDispatcher`; do not maintain a separate `RunExecutionConfig.tools` catalog.
- `ToolDispatcher.recoverOrDispatch()` is the only restart-aware single-call entry point for a batch recovery. Terminal Invocations are reused, safe `REQUESTED` Invocations may continue, and durable `RUNNING` Invocations fail closed with an `UNCERTAIN_SIDE_EFFECT` marker.
- Once an uncertain Invocation is encountered, no trailing Tool handler may execute. Every trailing call must receive a generic `SKIPPED_AFTER_UNCERTAIN_EXECUTION` result so the model sees a complete ordered batch without pretending execution was known.
- An ordinary `ToolExecutionResult.isError === true` is a model-recoverable result and does not stop later items. An unavailable Tool is a model-facing error without a fabricated Invocation. Dispatcher, persistence, invariant, and handler infrastructure failures are sanitized and fail the Run boundary.
- A `WAITING_APPROVAL` result stops the batch before trailing items, persists a canonical Run/AgentState approval boundary with the waiting Invocation pointer, and returns `WAITING_APPROVAL`. Phase 7C does not implement Approval resolution, Permission implementation, or an Approval endpoint.
- `RunController` owns the drive loop: persist the pending Tool decision, coordinate the batch, identity-check/convert results, durably persist the complete `receivedResults` batch, then call `AgentLoop.resumeWithToolResults()` for at most one provider turn. Accepted results must not be redispatched after restart.
- Batch result conversion must preserve assistant source order and only expose model-facing `content`/`isError`; Invocation IDs, Observation IDs, structured details, raw arguments, credentials, and internal causes must not enter `LLMToolResultMessage[]` or public errors.
- Do not add a ToolBatch database table or migration. Existing Run/State/Step, Conversation, Continuation, ToolInvocation, ToolObservation, and Durable Event stores remain the sources of truth.
- Phase 7C adds no Filesystem/Shell/Process/Git handlers, Runtime implementation, Retry, Timeout, Cancellation, Budget, or Verification execution. A final candidate still stops at `VERIFYING` and never directly completes a Run.

当前是 Phase 8A 完成边界。除 Phase 1 已正式定义的 AgentSession、AgentRun、AgentStep、AgentState、AgentEvent、ToolDefinition、ToolInvocation、Observation、ApprovalRequest、VerificationResult 和 Run State Machine，以及 Phase 2 的 SQLite/Drizzle Storage、Repository、Run State Snapshot、Durable Event Store、EventBus、Replay 与 Live Watch、Phase 3 的 loopback-only Daemon、Health/Session/Run HTTP API 和 Durable/Ephemeral SSE Event Stream 外，Phase 4A/4B/4C 已建立 Caelush-owned LLM contracts、Provider Registry、single-turn streaming runtime 和真实 OpenAI-shaped SSE 兼容性边界；Phase 5A/5B/5C 已完成 Project Intelligence、Relevant File Planning 与 ContextBuilder finalization；Phase 6A/6B/6C 已完成 deterministic Agent loop、Conversation Ledger、Continuation checkpoint、原子 RunExecutionStore、Durable Event Trace、RunController 与 local-host recovery；Phase 7A/7B/7C 已完成 Tool contracts、严格 Schema Runtime、不可变 ToolRegistry、Tool Output Policy、ToolDispatcher、Gate port、ToolInvocation/ToolObservation durable lifecycle、idempotency、recovery、strict source-order Tool Batch、uncertain-side-effect recovery barrier、approval boundary、LLMToolResult conversion 与 RunController runtime integration；Phase 8A 已建立 tool-independent Local Runtime、workspace-relative path resolution、bounded strict-UTF-8 filesystem read、deterministic file discovery、fixed ripgrep search，以及四个只读 Built-in Tool。Phase 8A 仍不实现文件 mutation、patch、Shell/Process/Git、权限/Approval resolution、sandbox、retry、timeout、cancellation、parallelism、Verification execution 或 `COMPLETED` transition。

当前 Phase 8B 已在上述 8A 只读基线之上增加唯一的 `apply_patch` verified patch engine：支持严格 bounded Add/Update/Delete/Move、全量 precommit raw-byte SHA-256/size guard、顺序 commit、best-effort rollback 与 uncertainty fail-closed；它不实现 Shell/Process/Git、权限/Approval resolution、sandbox、retry、timeout、cancellation、parallelism、Verification execution 或 `COMPLETED` transition。

Phase 8 后续必须遵守固定的 8B、8C、8D 边界；不得新增 Phase 8 轮次，也不得在 8A/8B 提前实现后续能力。

Phase 5B context rules:

- Phase 5 is fixed to exactly 5A, 5B, and 5C; do not add additional Phase 5 rounds.
- Relevant-file discovery is task-dependent and must remain separate from ProjectInspector.
- Automatic context discovery must stay within the detected project root and real Workspace boundary.
- Automatic context discovery must not traverse .worktrees, node_modules, VCS metadata, generated-output directories, or directory symlinks.
- .gitignore semantics must use the pinned ignore library rather than a hand-written glob parser.
- Common credential files must not enter ambient model context automatically.
- Project instruction files already represented by ProjectIntelligenceSnapshot must not be duplicated as relevant source files.
- Candidate discovery must operate on metadata first and must not eagerly read every source file.
- Path ranking must be deterministic and explainable through score reasons.
- Relevant-file token estimation is provider-independent planning, not billing-token truth.
- Relevant-file budgets are not the final model context budget.
- Relevant file content must stay as structured runtime sections; Phase 5B must not render the final LLM prompt.
- Context discovery must not depend on @caelush/llm.
- Phase 5B must not perform conversation compaction or summarization.

Phase 5 final ContextBuilder rules:

- Phase 5 contains exactly 5A, 5B, and 5C and is complete after ContextBuilder finalization.
- `ProjectIntelligenceSnapshot`, `RelevantFileContextPlan`, and `BuiltModelContext` are separate runtime concepts and must not be merged.
- ContextBuilder consumes already-discovered project facts and relevant files; it must not perform filesystem discovery.
- ContextBuilder may depend only on the provider-independent `@caelush/llm/messages` subpath, never the `@caelush/llm` root or provider adapters.
- The final model message order is system context, selected history, optional relevant-file reference context, then the exact current user message.
- Current user content must never be silently trimmed, rewritten, or merged with synthetic project context.
- Project instructions are project-level instructions; project metadata and project files are reference data and must be labeled accordingly.
- Conversation history selection keeps a newest contiguous suffix of complete turns and must never orphan tool calls or tool results.
- Conversation overflow may mark `requiresCompaction` but Phase 5 must not invoke an LLM to summarize history.
- Relevant-file context may be further truncated to fit the final model-input budget but must preserve provenance and truncation state.
- ContextBuilder does not know models, providers, tools, or provider context windows; the caller supplies `maxInputTokens`.
- ContextBuilder must never call `LLMGateway` or emit `AgentEvents`.
