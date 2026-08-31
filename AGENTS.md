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

Phase 10A cancellation rules:

- User cancellation persists one first-writer-wins `USER_REQUESTED` intent before aborting live work; intent rows are never deleted and there is no `CANCELLING` Run status.
- `RunExecutionScope` and its `AbortController` are host-only. The signal may cross Core/LLM/Tool/Runtime execution ports, but must never enter Protocol entities, durable state, continuation data, approval keys/actions, Tool arguments, security facts, observations, or events.
- `RunController.cancel()` is outside the normal Run execution lock: persist intent, abort the active scope, await unwinding, clean pending approvals and Run-owned resources, reload, and atomically settle `CANCELLED` only after confirmed cleanup.
- PENDING cancellation creates no AgentState, Step, provider call, Tool invocation, or conversation message. Active provider attempts settle a cancelled Step exactly once; late provider results and partial assistant output are discarded.
- Tool batches stop before trailing calls; Dispatcher remains the only Tool execution boundary. Preserve already durable results and `UNCERTAIN_SIDE_EFFECT`; never convert cancellation into a model/runtime failure or retry.
- Runtime process cleanup is exact-owner, cooperative, and best effort within the managed process boundary. Do not claim a hard OS sandbox or universal process-tree termination.
- Recovery gives durable cancellation intent priority over stale Steps, approvals, Tool continuations, and verification candidates; it never resumes Agent work for an intent-marked Run.

Phase 10B deadline and timeout rules:

- Phase 10 contains exactly 10A, 10B, 10C, and 10D; this round implements only 10B. Do not add 10B-1, 10B-2, 10E, or another Phase 10 round.
- A started Run deadline is exactly `startedAt + limits.timeoutMs`; never use `createdAt`, refresh `startedAt`, or replace the original deadline with `now + timeoutMs`. PENDING Runs have no active deadline.
- `timeoutMs` must be a positive safe integer and deadline arithmetic must reject unsafe overflow/precision loss. `now >= deadlineAt` is expired; equality is not active.
- Run deadline timeout and Provider-local timeout are separate authorities. Provider timeout remains `MODEL_TIMEOUT`; Run deadline aborts the Run-owned scope and settles `TIMEOUT`. Never pass remaining Run time as a replacement Provider timeout.
- Deadline scheduling is Core-owned and ephemeral. Keep one registration per non-terminal started Run, use injectable clock/timer ports, recheck after wake, rearm premature wakes, chunk long delays, and disarm PENDING/terminal Runs. Dispose timers during lifecycle shutdown.
- `DEADLINE_EXCEEDED` is a Core-only in-memory `RunExecutionAbortCause`; it must never enter Protocol, SQLite, cancellation intent, continuation, approval, Tool, observation, or event payloads. The first in-memory abort cause wins; durable user cancellation remains the settlement priority.
- Timeout must abort the live scope before taking the normal termination lock, then require confirmed cleanup of Run-owned resources and pending approvals. An unconfirmed cleanup returns `TIMEOUT_PENDING` and remains recoverable; it is not a new RunStatus.
- Successful timeout settles the canonical Run/State/Step/Continuation atomically: active Step becomes `CANCELLED` with usage counted once, AgentState and AgentRun become `TIMEOUT`, current Step and continuation are cleared, and exactly one `status.changed` plus one `run.timed_out` are emitted. It never emits `run.failed`.
- Run deadline includes context, Provider, Tool, Runtime/process work, approval wait, external Tool Result wait, and VERIFYING. Approval TTL is a separate clock: Run timeout cancels pending approvals, while approval TTL produces `EXPIRED`.
- `recover()` on an expired Run performs zero Provider/Tool calls and never resumes it. An unexpired recovered boundary rearms the remaining original deadline. Late Provider/Tool/approval results cannot reopen a terminal Run.
- Phase 10B does not implement retry/backoff, `WAITING_RETRY`, budgets, maxToolCalls/maxTokens/maxCost enforcement, BudgetManager, VerificationRunner, completed transition, daemon timeout routes, CLI/Web timeout UI, MCP, Browser, Computer Use, remote/Docker runtime, or hard sandbox.

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

当前是 Phase 8 完成边界。除 Phase 1–7 的既有契约与运行时外，Phase 8A/8B/8C/8D 已完成 Local Runtime、filesystem read/search、verified patch、shell/process、只读 Git、统一 Built-in catalog、Tool Effects 与原子 Tool settlement。Phase 8D 仍不实现权限/Approval resolution、sandbox、secret redaction、retry、timeout、cancellation、parallelism、Verification execution 或 `COMPLETED` transition。

当前 Phase 8B 已在上述 8A 只读基线之上增加唯一的 `apply_patch` verified patch engine：支持严格 bounded Add/Update/Delete/Move、全量 precommit raw-byte SHA-256/size guard、顺序 commit、best-effort rollback 与 uncertainty fail-closed；它不实现 Shell/Process/Git、权限/Approval resolution、sandbox、retry、timeout、cancellation、parallelism、Verification execution 或 `COMPLETED` transition。

当前 Phase 8C 在上述 8A/8B 基线之上增加唯一的 `exec_command` 与 `write_stdin` Tool，以及 `LocalRuntime` 持有的统一 `RuntimeExecService` → `LocalProcessManager` → pipe/PTY adapter 执行路径。Process session 只存在于一个 Runtime generation 的内存中，必须绑定 owner Run；不得新增 process table、Storage migration、PID reattach、process event side channel、AgentState.activeProcesses 直接写入或新的 default catalog。Shell 必须使用固定平台解析器与显式 argv，pipe 必须是 `spawn(..., shell: false)`，workdir 必须复用 workspace-relative/realpath containment，模型不得传 arbitrary shell、env、timeout 或 sandbox 参数。

Phase 8C 的 non-zero exit 和 signal exit 是正常 `isError: false` 结果；只有参数、workdir、shell/PTY、capacity、spawn-before-start、session 和 stdin operational errors 才是普通 Tool error。旧 runtime generation session、已开始但无法证明副作用边界的 process/stdio failure 必须经 `ToolExecutionUncertainError` 进入 `UNCERTAIN_SIDE_EFFECT`，不得自动重跑 command；既有 Tool Batch uncertainty barrier 负责跳过 trailing Tool。`yield_time_ms` 只是观察等待，不是 timeout、kill 或 cancellation；无 idle timeout。Runtime output 必须 bounded、incremental drain、记录 omitted bytes，并经过 streaming UTF-8/ANSI/OSC/CSI/control sanitization；这不是 Phase 9 secret redaction。

Phase 8 后续必须遵守固定的 8B、8C、8D 边界；不得新增 Phase 8 轮次，也不得在 8A/8B 提前实现后续能力。

## Phase 11D Completion Authority and Finalization Rules

- Phase 11 is fixed to exactly 11A, 11B, 11C, and 11D. Phase 11D is complete and is the final Phase 11 round; do not add 11E.
- Completion Authority belongs only to Core/RunController. VerificationRunner, TaskReviewer, AgentLoop, LLM providers, Tools, and Runtime may produce evidence but never transition a Run to COMPLETED.
- `Verification PASS` is necessary but not sufficient. New plans bind the final candidate with a required UTF-8 SHA-256 `candidateHash`; legacy plans may decode without it but cannot complete.
- Workspace freshness reuses the existing Phase 8 `WorkspacePathResolver` and streams raw bytes for bounded `{kind, sizeBytes, sha256}` fingerprints. No second resolver, content in evidence, silent truncation, symlink escape, or unverifiable freshness is allowed.
- Git freshness reuses RuntimeGitService status/diff and compares unmerged paths, attribution, per-path diff hashes, truncation, and review completeness. Untracked bytes are covered by the workspace hash.
- Evidence digest and Completion Seal are deterministic SHA-256 integrity digests. A seal is not a cryptographic signature and must bind Run, plan, source Step, plan hash, candidate hash, evidence digest, workspace freshness, and optional Git freshness.
- `VerifiedRunFinalResult` is strict, bounded, and contains only the exact candidate text plus verification identity/digests/counts. It must not contain stdout, stderr, diffs, raw evidence, secrets, prompts, hidden reasoning, or host paths.
- COMPLETED requires Run and AgentState COMPLETED, finishedAt, a valid verified final result, passed verification, no current Step, and no continuation. Other terminal statuses have no verified final result; VERIFYING has no final result.
- Run, State, final result, continuation clear, and lifecycle events settle atomically. Success event order is `verification.finalized`, `status.changed`, `run.completed`; failure order is `verification.finalized`, `error`, `status.changed`, `run.failed`. Publish only after commit.
- Completion and failure commits guard current status, cancellation intent, continuation/source Step, exact plan/latest plan identity, candidate hash, state/continuation revisions, and current state. The first durable cancellation or terminal authority wins; late writes cannot reopen a terminal Run.
- Terminal verification errors and repair exhaustion settle FAILED with `VERIFICATION_FAILED`; do not emit repeated repair-limit events or leave an unrecoverable VERIFYING loop.
- Recovery performs terminal/cancellation/deadline/budget checks first. It never resumes an intent-marked or expired Run. A stale RUNNING PROJECT/WORKSPACE/GIT/TASK check is settled once as bounded `VERIFICATION_INTERRUPTED` ERROR evidence and never replayed.
- A passing verification must perform a final workspace/Git freshness recheck immediately before completion. Any stale, incomplete, truncated, missing, symlink, or late result fails closed.

本轮完成后，Phase 8D 是当前完成边界；不得继续扩展 Phase 8。Phase 8 仍不提供 process persistence、权限/Approval resolution、sandbox、secret redaction、retry、timeout policy、Run cancellation、parallelism、Verification execution 或 `COMPLETED` transition。

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

## Phase 8D Git, Effects and Finalization Rules

- Phase 8D is the final Phase 8 round. Never add Phase 8E, 8D-1, 8D-2, or another Phase 8 round.
- Dedicated Git Runtime is read-only. It must call fixed `git` directly with `spawn("git", argv, { shell: false })`, deterministic non-interactive environment, and bounded output; it must not delegate to `RuntimeExecService` or expose Git mutation APIs.
- Git must detect repositories with `git rev-parse`, support parent repositories and linked worktrees, constrain status/diff pathspecs to the current Agent Workspace, and never expose repository roots, `.git` metadata, absolute paths, raw environment, or raw diagnostics.
- Git model inputs are structured `path`, `limit`, and `scope` values only. Reject absolute/UNC/drive/NUL/traversal/over-budget paths and malformed machine output with typed errors.
- `git_status` uses bounded porcelain-v2 parsing; `git_diff` disables external diff/textconv/color/binary output and reports explicit model truncation metadata. Git tools require `GIT_READ` and are `LOW` risk.
- `ToolRegistration.effectProjector` is pure host-side projection only. Effects are produced only from successful validated results; error and uncertain outcomes never fabricate effects and projector failure leaves the invocation running for uncertain recovery.
- Effects settle in the ToolExecutionStore transaction: invocation, observation, AgentState projection, domain events, and terminal tool event are persisted before notification. Reuse the existing AgentState snapshot table and canonical state writer; do not add a process table or migration.
- Public shell/process projections must use the fixed safe label `shell command`. Raw shell commands and stdin remain private invocation arguments only; they must not enter AgentState, events, event title/summary, or result details.
- `changedFiles` is a bounded latest-change projection of at most 500 entries. `activeProcesses` is updated only by successful process effects; uncertain execution never fakes a stop.
- The default catalog must be built by `createDefaultBuiltinToolRegistrations(runtimeResolver)` from one injected resolver and the immutable order `read_file`, `list_directory`, `find_files`, `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `git_status`, `git_diff`.
- Phase 8D does not implement Phase 9 security/permission/sandbox/secret redaction, Phase 10 cancellation/timeout/retry/budget policy, or Phase 11 CLI/Web product work.

## Phase 9A Security Policy Kernel and Tool Gate Rules

- Phase 9 contains exactly 9A, 9B, 9C and 9D; never add Phase 9E or another Phase 9 round.
- Phase 9A owns only deterministic `ALLOW` / `DENY` / `REQUIRE_APPROVAL` decisions and the Tool execution Gate.
- Reuse Protocol `PermissionProfile`, `ApprovalPolicy`, `Capability` and `RiskLevel`; do not create duplicate V2 enums or schemas.
- `ToolExecutionEnvironment` answers where/with what runtime; `ToolSecurityContext` answers what the Run is allowed to do. Never put permission policy in the environment.
- `ToolSecurityContext` must be derived from durable `AgentRun` policy, runtime-validated, passed through `ToolBatchRequest` and `ToolDispatchRequest`, and never come from model arguments or Tool arguments.
- Capability denial has precedence over approval. `READ_ONLY` grants only `FS_READ`/`GIT_READ`; `PROJECT_ACCESS` grants project filesystem and process capabilities plus `GIT_READ`; `FULL_ACCESS` grants the current Protocol capability set without disabling structured Tool invariants.
- `ALWAYS_ASK` requires approval for every capability-authorized Tool. `DANGEROUS_ONLY` allows LOW/MEDIUM and requires approval for HIGH/CRITICAL. `NEVER_ASK` never emits `REQUIRE_APPROVAL`.
- `PROJECT_ACCESS + NEVER_ASK` denies `UNCONFINED_LOCAL_PROCESS` because V1 has no OS hard sandbox. `FULL_ACCESS + NEVER_ASK` may allow capability-authorized unconfined local-process Tools.
- Security policy evaluation is pure/deterministic and must not read arguments, perform I/O, use time/randomness, or expose commands, stdin, file contents, environment variables, credentials, absolute paths, Provider errors, or internal stack traces.
- `@caelush/tools` defines the Gate port; `@caelush/security` implements it. Tools must not import Security. Security must not import Runtime, Core, Storage, Events, LLM, Context, Verification, or apps.
- Security never writes Storage, publishes Events, executes handlers, resolves approvals, or mutates ToolInvocation. Dispatcher owns invocation lifecycle and persists `FAILED`/`WAITING_APPROVAL` boundaries.
- A `REQUESTED` invocation may be re-evaluated during recovery with durable Run policy. `WAITING_APPROVAL`, `RUNNING`, and terminal invocations must not be silently re-authorized or replayed.
- Phase 9A alone does not own Approval persistence/resolution; Phase 9B now owns only the durable Approval workflow below. Command/file content policy, secret redaction, OS hard sandboxing, timeout, cancellation, retry, budget, parallelism, and Verification execution remain out of scope.

## Phase 9B Durable Approval Workflow Rules

- Phase 9B adds only durable ApprovalRequest persistence, resolution, restart recovery and Tool/Run continuation integration; do not implement command-content policy, sensitive-file policy, secret redaction, OS hard sandboxing, cancellation, timeout, retry, budgets, Verification, CLI/Web approval UI, or a fake daemon route.
- Reuse Protocol `ApprovalRequest`, `ApprovalStatus`, `ApprovalScope` and strict resolution schemas. `ApprovalRequest.scope` is the maximum grant scope; `grantedScope` exists only for APPROVED requests. Pending requests have no resolution fields; terminal requests have `resolvedAt` and no grant except APPROVED.
- Approval identity is a host-internal SHA-256 over canonical Tool name, canonical arguments, risk level, sorted capabilities, runtime requirements, PermissionProfile, and ApprovalPolicy. It must never include or expose action/title text, events, Provider/model data, credentials, raw error text, or other presentation fields.
- Security Gate precedence is immutable: current Gate evaluation runs first; DENY always wins and ignores cached grants; ALLOW runs; only REQUIRE_APPROVAL may consult an exact same-Run RUN grant. No name-only, wildcard, cross-Run or mismatched-key grant is valid. ONCE grants are bound to their ToolInvocation.
- `approval_requests` is the only new durable entity in Phase 9B. Storage owns its SQLite migration, JSON codec, repository, lazy expiration and resolution transaction; public APIs must not expose database rows, Drizzle clients or `approval_key`.
- Default pending Approval TTL is 15 minutes with an injected clock. There is no sweeper. Loading, recovery and resolution may lazily transition an expired PENDING request to EXPIRED and must append exactly one durable `approval.resolved` event.
- Approval creation must atomically persist `REQUESTED → WAITING_APPROVAL`, the PENDING ApprovalRequest and `approval.requested` before any live notification. Creation is idempotent by unique ToolInvocation identity; conflicting identity or duplicate event data fails closed.
- Approval resolution must validate APPROVE scope (`ONCE` or `RUN`) and reject RUN scope when the request maximum is ONCE. `BEGIN IMMEDIATE` must atomically load PENDING, transition the terminal Approval state, and append `approval.resolved`; identical resolution is idempotent and conflicting resolution is an explicit conflict. Expired approvals cannot be approved.
- Tool lifecycle allows `WAITING_APPROVAL → RUNNING` for an approved exact invocation and `WAITING_APPROVAL → FAILED` for REJECTED/EXPIRED/CANCELLED. Rejection is a sanitized, non-retryable `APPROVAL_REJECTED` Security-phase Tool error and Observation; never execute the handler.
- RunController is the only approval-resolution orchestrator. `resolveApproval(runId, approvalId, resolution)` must run under the existing per-Run lock, validate Run/State/Continuation/Approval ownership and pointer identity, transition WAITING_APPROVAL → RUNNING through the canonical Run State Machine, clear only the waiting pointer, and invoke Coordinator recovery. It must not replay the LLM turn or rerun completed Tool calls.
- Recovery is local and durable: pending approval remains waiting; approved waiting invocation resumes the exact Tool; rejected/expired/cancelled resumes as a Tool error; uncertain RUNNING remains fail-closed; terminal invocations and completed Runs are never rerun. Batch trailing calls continue only after the waiting invocation has produced a result, in assistant source order.
- Durable events are persisted before notification. `approval.requested` and `approval.resolved` payloads are safe Protocol data only; raw Tool arguments and the internal approval key do not enter model messages, public errors or events.

## Phase 9C Input Security and Secret-Safe Projection Rules

- Phase 9C owns input-aware sensitive-resource policy, command policy, and secret-safe public/model projections; Phase 9D integrates these boundaries without changing their ownership.
- Phase 9A metadata policy remains authoritative. Phase 9C input-aware rules may only preserve or tighten a base decision; they must never downgrade `DENY` or `REQUIRE_APPROVAL` to `ALLOW`.
- The current Security Gate evaluation always precedes Phase 9B RUN grant lookup. A cached approval must never override a current input-aware `DENY`.
- Tool-specific input semantics are projected into host-only pure Tool Security Facts rather than hard-coded into `ToolDispatcher`. Facts may temporarily contain raw command, patch, or stdin text for analysis, but must never be persisted, emitted, or sent to the model.
- Sensitive path classification is pure and path-based. Known environment, credential, auth, private-key, cloud-credential, and certificate-container files require review; `NEVER_ASK` denies them. Template files such as `.env.example` remain ordinary project resources.
- Command policy is a conservative parser/classifier, not raw substring matching. Common shell wrappers have bounded recursion; ambiguous, dynamic, encoded, or over-depth commands are opaque rather than safe.
- High-confidence system-destructive commands are denied. Destructive local actions, repository mutations, network access, remote mutation, privilege escalation, and opaque commands require approval and are denied under `NEVER_ASK`.
- Secret detection and redaction are deterministic and high-confidence, not complete DLP coverage. Raw Tool results must be sanitized before ToolObservation, durable Tool events, or model-facing ToolResult creation.
- The Tool result pipeline is raw validation → sanitize → sanitized revalidation → effect projection → durable observation. Sanitizer failure after a Tool may have executed leaves the durable invocation `RUNNING` and must not cause handler replay.
- Approval previews are generated from security facts and redacted before persistence. Raw shell commands, stdin, patch bodies, full file content, absolute host paths, secret fragments, hashes, and fingerprints must not enter `ApprovalRequest.action`.
- Redacted previews never participate in Approval identity. Exact approval keys continue to use private canonical Tool arguments. `ToolInvocation.args` remains private durable execution data; Phase 9C does not encrypt it at rest and must not claim secrets never exist in SQLite.
- Phase 9C itself does not implement OS hard sandboxing, cancellation, timeout, retry, budgets, Verification, configurable wildcard permission rules, CLI UI, Web UI, or the Phase 9D integration layer.

## Phase 9D V1 Security Integration and Finalization Rules

- Phase 9D is complete and is the final Phase 9 round. Do not add Phase 9E or silently begin Phase 10.
- The V1 logical sandbox is a policy/admission boundary, not an OS sandbox. Structured workspace Tools are `STRUCTURED_WORKSPACE`; `exec_command` and `write_stdin` are `UNCONFINED_LOCAL_PROCESS`.
- `UNCONFINED_LOCAL_PROCESS` must remain an explicit limitation: V1 provides Gate/Approval checks, workspace path guards where applicable, bounded IO, and sanitized child environments, but no syscall, network, filesystem, container, seccomp, Windows Job Object, or process-identity isolation.
- Runtime owns child-process environment policy. Child environments are allowlisted, caller-input immutable, platform-aware, case-insensitive for Windows names, and must remove credentials, proxy credentials, SSH-agent variables, injection variables, and helper configuration variables.
- Git and ripgrep helpers must use fixed executable/argument construction, `shell: false`, sanitized minimal environments, bounded stdout/stderr, no arbitrary stdin, no interactive prompts, and hardened configuration. Git read paths must disable external diff/textconv/fsmonitor behavior where supported.
- Context may import only `@caelush/security/sensitive-path` and `@caelush/security/redaction`; it must not import the Security root, Tools, Runtime, Storage, Events, approval code, or host services. Sensitive files are excluded before content reads; project-derived text is redacted before provider messages; the current user message is not rewritten.
- The documented production composition must use the real Security Gate and real Result Sanitizer and must audit Security Facts coverage for every default Built-in. `REQUIRE_APPROVAL` without durable approval infrastructure fails closed and never emits an anonymous waiting state or executes a handler.
- The current Gate/admission decision always precedes cached approval lookup. Approval resolution and recovery must re-enter the Gate and Runtime/path guards; an old grant never overrides a current `DENY`.
- Phase 9D does not implement OS sandboxing, remote runtime, MCP, Browser, cancellation, timeout, retry, budgets, Verification execution, new execution HTTP routes, or other Phase 10 behavior.

## Phase 10C Bounded Retry and Provider Recovery Rules

- Phase 10 contains exactly 10A, 10B, 10C, and 10D; Phase 10D is the final round. Do not add 10E, another retry round, or any later Phase 10 work.
- Automatic retry is limited to provider/LLM failures whose `LLMError.retryable` is true and whose safe code is `LLM_RATE_LIMIT`, `LLM_NETWORK`, or `LLM_TIMEOUT`. Core must not inspect HTTP status, headers, provider names, messages, raw response data, or stack traces; generic Tool, Runtime, Storage, approval, and uncertain-side-effect failures are never retried.
- `RetryPolicy` is bounded: `maxAttempts` includes the initial attempt and is a safe integer in `[1, 10]`; delays use overflow-safe capped exponential backoff, optional safe bounded Retry-After, and injected jitter. Retry decision code owns no I/O, sleeping, provider call, Tool execution, Run mutation, or persistence.
- Every provider attempt is a new Agent Step and a new Gateway-owned LLMCallId. A failed Step settles once and increments `UsageState.steps` once. Retryable intermediate failures do not enter `AgentState.errors`; only final exhaustion/non-retryable failure does.
- `WAITING_RETRY` is a strict durable continuation, never a RunStatus or AgentState status. It preserves only bounded safe metadata and, for an open Tool turn, the existing pending decision plus normalized Tool Results. Failed/partial provider output is never appended to durable conversation.
- The failed Step, RUNNING Run/State, `WAITING_RETRY`, `llm.failed`, and `retry.scheduled` must settle through one atomic execution commit. Durable events are persisted before notification; the retry timer is armed only after commit and notification.
- `RunRetryRegistry` is separate from the deadline registry, has one token-protected registration per Run, uses injectable clock/timer/jitter boundaries, rechecks after wake, chunks long delays, disarms terminal/cancelled/expired Runs, and never holds a RunExecutionScope during idle waiting.
- Cancellation intent, Run deadline, and maxSteps take priority over retry. A retry delay that reaches the original Phase 10B deadline is not scheduled and does not directly write TIMEOUT; the deadline authority settles the Run. Recovery before `nextAttemptAt` makes zero provider/Tool calls and preserves the original timestamp.
- Retry after Tool Results calls `AgentLoop.resumeWithToolResults()` with the preserved normalized batch and never redispatches a completed Tool. Existing approval, security, and uncertainty boundaries remain authoritative for any later new Tool decision.
- Phase 10C does not implement budgets, retry HTTP endpoints, Tool retry, Verification execution, `COMPLETED` transition, remote runtime, MCP, Browser, Computer Use, host retry UI, or hard OS sandboxing. See `docs/architecture/retry.md`.

## Phase 10D Budget Enforcement, Durable Usage Accounting and Finalization Rules

- Phase 10D is the final Phase 10 round. Phase 10 is sealed at 10A, 10B, 10C, and 10D; do not add 10D-1, 10E, or another Phase 10 implementation round. Phase 11 is separately fixed to 11A, 11B, 11C, and 11D.
- Budget dimensions are Tool calls, canonical total LLM tokens, and estimated external USD cost. Limits are positive safe integers; cost is represented internally as safe integer micro-USD and uses injected versioned pricing snapshots. Budget accounting is not a billing guarantee and must not consult live pricing or billing services.
- Enforcement uses one durable `run_budget_entries` ledger with unique `(run_id, kind, owner_id)`. Admission is `RESERVED`, external work is preceded by `IN_FLIGHT`, and settlement is `SETTLED`, `CONSERVATIVE`, or provably unstarted `RELEASED`. `IN_FLIGHT` is never released after an ambiguous crash.
- `AgentState.usage` is a projection of ledger accounting. Steps count settled Agent Step attempts, including failed attempts; Tool calls count only handlers that reach the durable start boundary. Security DENY, schema/preflight failure, unavailable Tool, approval wait/rejection, and never-started handlers consume zero.
- Tool batches preflight the whole executable segment before the first handler. A segment that cannot fit has zero handler side effects and returns budget governance to RunController; uncertain Tool execution stops trailing calls and is never automatically replayed.
- LLM admission occurs after full request preparation but before durable Step/provider start. The estimator covers context, messages, Tool definitions/schemas, and Tool results. `maxOutputTokens` is clamped before the Provider call. Missing safe estimation or required pricing fails closed as `BUDGET_ENFORCEMENT_UNAVAILABLE`, not as budget exhaustion.
- LLM usage includes all Provider attempts and retries. Cached-input and reasoning fields are subsets, not extra totals. Missing or inconsistent usage is conservative. Actual usage exceeding a reservation is recorded truthfully and prevents downstream work after the post-settlement budget recheck.
- Governance priority is terminal state, durable cancellation, Run deadline, maxSteps, budget, retry, then normal execution. Budget finalization disarms timers, cancels approvals, cleans owned resources, clears continuation, and atomically settles Run/State/Step/events. Unconfirmed cleanup returns `BUDGET_EXCEEDED_PENDING` and recovery performs cleanup only.
- Successful budget finalization emits exactly one sanitized `budget.exceeded` and one `status.changed`, never `run.failed`, and never changes a final candidate directly to `COMPLETED`; final candidates remain at `VERIFYING`.
- Runtime remains a replaceable execution substrate and does not own budget, retry, timeout, cancellation, storage, pricing, or policy. Provider adapters perform one turn, never execute Tools, never generate Caelush call IDs, and never own retry/timeout policy.

## Phase 11 Verification Domain and Execution Rules

- Phase 11 contains exactly 11A, 11B, 11C, and 11D. The current completed boundary is 11D. Do not add 11A-1, 11A-2, 11B-1, 11E, or another Verification round.
- Phase 11A planning creates intent-only `VerificationPlan`/`VerificationCheck`/`VerificationEvidence` contracts and a durable Final Candidate → `VERIFYING` boundary. The 11A planning sub-boundary does not execute checks or transition `VERIFYING` to `COMPLETED`; Phase 11B execution rules are below.
- `@caelush/protocol` owns `VerificationPlanId`, `VerificationCheckId`, and `VerificationEvidenceId` with the existing UUIDv7 ID convention. Protocol values remain JSON-safe and provider/runtime/storage/UI free; no command, Runtime object, service object, credential, raw hidden reasoning, or raw candidate text enters these contracts.
- `VerificationPlan` binds exactly one Run and one final-candidate source Step to an immutable planner version, canonical SHA-256 plan hash, ordered checks, and creation timestamp. Hash input excludes random plan/check IDs and timestamps and includes the source Step, planner version, and ordered intent/stage/requirement data.
- Check intents are discriminated `PROJECT` (`LINT`, `TYPECHECK`, `TEST`, `BUILD`), `WORKSPACE` (`CHANGESET_SANITY`), `GIT` (`CHANGESET_REVIEW`), and `TASK` (`ACCEPTANCE`). Requirements are `REQUIRED`, `IF_AVAILABLE`, and `ADVISORY`; stages are `FAST_STATIC`, `BEHAVIORAL`, `BROAD`, `CHANGE_REVIEW`, and `ACCEPTANCE`; lifecycle statuses are `PENDING`, `RUNNING`, `PASSED`, `FAILED`, `ERROR`, `SKIPPED`, and `CANCELLED`.
- `DefaultVerificationPlanner` is deterministic, pure, and depends only on Protocol. It receives Run/source Step/goal/workspace/changed-file/project facts; it must not depend on filesystem, network, Runtime, Tools, Storage, EventBus, LLM, clock, or ID factories. It emits no commands. The default matrix includes code checks for code/unknown projects, adds required workspace review for non-empty changes, includes Git review as required/if-available unless known non-Git, and always includes required task acceptance.
- The evaluator is pure: zero checks, required pending/running/cancelled/missing evidence, blocking failure, and blocking error remain distinct outcomes. An `IF_AVAILABLE` skip is acceptable only with matching trustworthy unavailable evidence. Advisory failures are warnings. Evaluator output never authorizes `COMPLETED` in 11A.
- Storage adds one committed migration with only `verification_plans`, `verification_checks`, and `verification_evidence`; foreign keys and unique `(run_id, source_step_id)` / `(plan_id, ordinal)` constraints are mandatory. Repositories use Protocol JSON as source of truth and expose no database rows or clients. Same-hash plan creation is idempotent; differing hash conflicts and cannot replace the plan.
- Existing `RunExecutionStore.commit()` must atomically persist Run, AgentState, final Step, real conversation messages, `AWAITING_VERIFICATION` with `verificationPlanId`, Plan/Checks, and durable events. Durable events persist before publish. The only new event is bounded `verification.planned`; it contains plan/source Step IDs, count, planner version, and requirement counts only.
- A `VERIFYING` snapshot is invalid without a matching durable plan and continuation pointer. Recovery loads the existing plan/checks, performs zero Planner/Provider/Tool/Runtime/Verification calls, never replans, and fails closed on missing, mismatched, or corrupt plan data. Existing Phase 10 cancellation/deadline/retry/budget and Phase 8/9 runtime/security boundaries remain authoritative.

Phase 11B rules:

- Phase 11B executes only `PROJECT` checks for `LINT`, `TYPECHECK`, `TEST`, and `BUILD`. `WORKSPACE`, `GIT`, and `TASK` checks remain `PENDING`; passing project checks never transitions `VERIFYING` to `RUNNING` or `COMPLETED`, writes `finalResult`, or emits `run.completed`.
- Verification reuses the existing Phase 5 `ProjectInspector` through a Core composition port. `@caelush/verification` must not create a second project detector, recursively scan child packages, or re-parse manifests/lockfiles. Fresh project facts are runtime-only structural input.
- Project resolution is deterministic and conservative. Node uses only exact `lint`, `typecheck`/`type-check`, `test`, and `build` scripts with explicit `<manager> run <script>` argv; root wins and active package is the only fallback. Rust requires explicit Cargo evidence and uses `--offline`; Java requires one explicit Maven/Gradle evidence source and uses offline commands. Python/Go and missing/ambiguous facts remain unavailable; no installer, downloader, fuzzy alias, or guessed command is allowed.
- Candidate hashes may include ephemeral resolver metadata and ordered lifecycle script bodies, but raw scripts, candidate objects, absolute paths, environment values, and secrets must never enter Protocol entities, durable events, AgentState, Conversation, ToolObservation, or public summaries.
- Verification is a host action, not a Tool call. It must not create ToolInvocation/ToolObservation, Tool Effects, conversation messages, Agent Steps, LLM calls, budget entries, or a second approval workflow. `ToolDispatcher`, `ToolRegistry`, `ToolBatchCoordinator`, concrete Tool handlers, and provider SDK types remain outside verification.
- Resolved commands pass the existing Phase 9 capability/command/input policy through a narrow Security adapter. `DENY` and `REQUIRE_APPROVAL` both fail closed as verification `ERROR`; no process or ApprovalRequest is created. Security must remain independent of `@caelush/verification`.
- Runtime integration is a narrow typed-argv port over the existing Phase 8 `LocalRuntime`/`LocalProcessManager` pipe path with `shell:false`, workspace-relative containment, bounded output, exact owner Run ID, and the existing Run-owned AbortSignal. Runtime must not depend on Verification; Verification must not import Runtime implementation or `node:child_process`.
- For an executable check, durable `RUNNING` and Discovery evidence persist before process launch. Terminal Check, bounded/redacted Command evidence, and `verification.check.completed` persist atomically; durable events publish only after commit and use durable sequence order. There is no verification-specific timeout, retry, budget, process persistence, or PTY path.
- Command evidence is redacted before bounded snippets are persisted. Protocol evidence details are JSON-safe and capped at 32 KiB serialized UTF-8; raw stdout/stderr, exception text, command lines, credentials, and full scripts must not enter public errors or event payloads.
- PROJECT checks execute in ordinal order with fail-fast for blocking failures/errors. Unavailable `IF_AVAILABLE`/`ADVISORY` checks become `SKIPPED` with bounded discovery evidence; security rejection and runtime infrastructure errors become `ERROR`; non-zero/signal exits are normal failed checks.
- Recovery must never replay a durable `RUNNING` verification check because its process side-effect boundary is uncertain. A clean `PENDING` boundary may continue only the next project check. Existing Run cancellation and deadline authorities win, and late verification results cannot reopen a terminal Run.

## Phase 12A Production Daemon and Shared Client Rules

- Phase 12 contains exactly 12A, 12B, 12C, 12D and 12E. The current round is 12A; do not implement 12B/12C/12D/12E capabilities in this round.
- Phase 12A owns the production daemon execution surface and shared client transport. It does not implement the Ink TUI, React/Web UI, timeline UI, approval prompts, resume pickers, CLI packaging, or host presentation behavior.
- CLI and Web are clients of the Caelush Local Agent Service and must not import `RunController`, `AgentLoop`, Runtime, Storage, Security or Tool internals. The production daemon composition root is the only application layer responsible for wiring concrete Agent Kernel dependencies.
- The daemon owns one process-scoped `Storage`/`EventBus` lifecycle, one Runtime/RuntimeResolver, one Tool Registry/Dispatcher/Coordinator, one Provider Registry/Gateway, one AgentLoop, one RunController and one `RunExecutionSupervisor`. Routes remain thin dependency-injected adapters.
- Run creation and Run execution remain separate operations. Creating a Run must not implicitly start it, create AgentState, call a Provider, execute a Tool, or publish `run.started`.
- Long-running `RunController` operations must not keep an HTTP control request open for the entire Agent lifecycle. Accepted start/recover/approval continuation is driven server-side and progress is observed through the committed AgentEvent SSE stream.
- `RunExecutionSupervisor` is process-local coordination only. It may deduplicate one active driver per Run and capture background failures, but durable SQLite state and Core's canonical Run State Machine remain authoritative. It must never execute Tools or Verification itself.
- Cancellation retains Phase 10A priority and must not wait behind the normal background Run driver. Recovery calls `RunController.recover()` and never resets non-terminal durable state to `PENDING`.
- Approval resolution uses the existing durable Approval workflow through `RunController.resolveApproval()`; HTTP routes must not directly mutate Approval storage or create a second approval state machine.
- Public HTTP contracts live in `@caelush/protocol` and use strict schemas. Internal `RunControllerResult` and provider/runtime/storage types must never be serialized directly as public responses.
- The shared `@caelush/client` package may depend only on Protocol and standard browser-compatible Web APIs. Its production code must not import Node built-ins, Core, Runtime, Storage, Security, Tools, Context, Verification, LLM, Fastify or EventBus.
- `@caelush/client` validates JSON responses, bounded API error envelopes, `/api/v1/info` compatibility, and every `AgentEvent` SSE payload. Durable SSE IDs must match durable event sequence; ephemeral events never carry an ID.
- Phase 12A provides explicit `afterSequence`/`Last-Event-ID` replay primitives but no automatic SSE reconnect, retry, deduplication cache, or host UI policy.
- Provider credentials and provider endpoints are daemon-side startup configuration. Clients select only `{ provider, model }`; client-provided `ModelRef.baseUrl`, headers, credentials and arbitrary provider options must be rejected before provider transport.
- The daemon remains loopback-only in V1 and must not add permissive CORS or trust forwarded headers. Permission, Security, Approval, Budget and Verification authority remain server-side and cannot be overridden by client transport.
- Phase 12A must not introduce duplicate Provider fetch/SSE parsing, duplicate Runtime process/filesystem/Git execution, React/Ink UI, WebSocket, Web Search, MCP, Browser, Computer Use, remote/Docker Runtime, provider CRUD, auth, or a new database/event side channel.
