# Caelush

Caelush 是一个面向通用 Agent 的本地 Kernel 项目，目标是让 CLI、Web 和其他宿主共享同一个可观察、可取消、可验证、可扩展的 Agent Core。

本轮当前阶段为 **V1 Phase 11B：Deterministic Verification Execution**；Phase 8A/8B/8C/8D、Phase 9A、Phase 9B、Phase 9C、Phase 9D、Phase 10A、Phase 10B、Phase 10C 与 Phase 10D 已完成，Phase 10 overall 已封存。本阶段在 11A 的 intent-only Verification Plan/Check/Evidence 边界上，增加复用 Phase 5 的项目画像、确定性 PROJECT 检查解析、Phase 9 安全准入、Phase 8 typed-argv 执行、bounded/redacted evidence 与 SQLite durable check lifecycle；本轮仍不执行 WORKSPACE/GIT/TASK 检查、不运行 LLM reviewer，也不授权 `COMPLETED`。

当前仓库已经完成 Phase 1–7 以及 Phase 8A/8B/8C/8D；Phase 8D 增加 tool-independent 的只读 Git Runtime、`git_status`/`git_diff`、统一默认 Built-in catalog、纯 Tool Effects、AgentState 投影和原子 Tool settlement。Phase 9A 增加独立的 `@caelush/security` policy kernel、Run-derived `ToolSecurityContext` 与真实 `ToolExecutionGate`；Phase 9B 增加 durable Approval workflow、精确 grant matching、lazy expiry 与 Tool/Run recovery；Phase 9C 增加 sensitive resource/command policy、host-only facts、high-confidence secret redaction 和 sanitize-before-persist，但不实现 OS hard sandbox；Phase 10A 增加 user-requested cancellation control plane 和 end-to-end abort propagation；Phase 10B 增加 Run deadline 与 Provider local timeout 的分层、超时 abort/cleanup 以及恢复安全边界；Phase 10C 增加仅 Provider 瞬态失败的 bounded retry/backoff、持久化等待边界、事件审计与崩溃恢复；Phase 10D 增加 durable budget ledger、Tool/LLM admission、保守 usage accounting、预算优先级和终止清理。Phase 10D 不实现 Verification execution、公共 budget UI/API 或 `COMPLETED` transition。

## Phase 6 Status

- Phase 6A — Agent Execution Contracts & Kernel State: **COMPLETED**
- Phase 6B — Context → LLM Resumable Decision Loop: **COMPLETED**
- Phase 6C — RunController, Persistence & Event Trace: **COMPLETED**

## Phase 7 Status

- Phase 7A — Tool Contracts, Registry & Schema Runtime: **COMPLETED**
- Phase 7B — Tool Dispatcher & Durable Invocation Lifecycle: **COMPLETED**
- Phase 7C — Tool Batch Coordination & Agent Runtime Integration: **COMPLETED**

## Phase 8 Status

- Phase 8A — Local Runtime Foundation & Filesystem Read/Search: **COMPLETED**
- Phase 8B — Safe File Mutation & Patch Engine: **COMPLETED**
- Phase 8C — Shell Execution & Managed Process Runtime: **COMPLETED**
- Phase 8D — Git Runtime, Built-in Tool Integration & Phase 8 Finalization: **COMPLETED**
- Phase 8 — overall: **COMPLETED**

## Phase 9 Status

- Phase 9A — Security Policy Kernel & Tool Execution Gate: **COMPLETED**
- Phase 9B — Durable Approval Workflow & Resolution: **COMPLETED**
- Phase 9C — Sensitive Resource Policy, Command Policy & Secret Redaction: **COMPLETED**
- Phase 9D — V1 Security Integration, Logical Sandbox Boundary & Finalization: **COMPLETED**
- Phase 9A owns deterministic metadata decisions; Phase 9B owns durable ApprovalRequest creation/resolution, exact grant matching, lazy expiry, and Tool/Run recovery; Phase 9C adds monotonic input-aware policy and high-confidence secret-safe projections; Phase 9D integrates the logical/policy boundary, sanitized child environments, hardened structured helpers, Context reuse, secure composition, and final adversarial audits.
- Phase 9 overall: **COMPLETED**

## Phase 10 Status

- Phase 10A — Run Cancellation Control Plane & End-to-End Abort Propagation: **COMPLETED**
- Phase 10B — Deadline & Timeout Hierarchy & Timeout Recovery: **COMPLETED**
- Phase 10C — Bounded Retry, Backoff & Transient Provider Recovery: **COMPLETED**
- Phase 10D — Budget Enforcement, Durable Usage Accounting & Finalization: **COMPLETED**
- Phase 10 — overall: **COMPLETED**

## Phase 11 Status

- Phase 11A — Verification Domain, Planning & Evidence Contract: **COMPLETED**
- Phase 11B — Verification Execution: **COMPLETED**
- Phase 11C — Evidence & Review Integration: **NOT STARTED**
- Phase 11D — Completion Authority & Finalization: **NOT STARTED**
- Phase 11 — overall: **IN PROGRESS**

Phase 7 contains exactly 7A, 7B, and 7C. Caelush now has an immutable validated Tool Registry and a single-Tool Dispatcher. A valid call is durably recorded as `REQUESTED`, gated, durably checkpointed as `RUNNING`, executed once through the resolved handler, output-validated, and atomically settled with its `ToolObservation` and lifecycle event. Exact duplicate calls are idempotent, stale `RUNNING` calls fail closed during recovery, and raw arguments/results are kept out of lifecycle events.

Caelush now has an injected `AgentLoop` and a durable `RunController`. The loop performs at most one provider turn per invocation; the controller checkpoints Run/State/Step before the provider, persists real conversation messages and continuation boundaries atomically, publishes only committed lifecycle events, and recovers known local-host boundaries after restart. A model Tool-call group is executed by the injected `ToolBatchCoordinator` in assistant source order through the single `ToolDispatcher`; completed Tool Results are converted and durably accepted before the next turn, while approval and uncertain-side-effect states remain explicit durable boundaries. Tools are never executed by AgentLoop, and a final candidate stops at `VERIFYING` until a future Verification boundary.

Phase 8A adds a concrete local execution substrate below the Tool layer. Built-in filesystem paths are always workspace-relative and are checked both lexically and through realpath containment; internal symlinks are allowed, while symlink escapes fail closed. Reads are streaming/bounded, strict UTF-8, binary-aware, and line-paginated. File discovery uses bounded deterministic `fast-glob`, and text search uses a fixed `rg` adapter with `shell=false` and no model-controlled arguments. These tools are read-only and do not provide mutation, shell, process management, Git, permissions, approvals, sandboxing, retries, cancellation, or verification execution.

Phase 8B adds the narrow `apply_patch` mutation surface. A strict, bounded Add/Update/Delete/Move document is fully parsed and prepared in memory; all source SHA-256/size guards and destination absence checks pass before the first mutation. Existing mutation paths cannot traverse symlinks, existing UTF-8 BOM/newline/final-newline state is preserved, and in-process commit failures attempt verified reverse rollback. This is best-effort and is not an OS-level atomic transaction, crash-atomic, exactly-once mutation, sandbox, production permission evaluator, shell runtime, or Git runtime. The read-only and mutation registrations remain explicit factories; the final default catalog belongs to Phase 8D.

Phase 8C adds the shared Shell/Managed Process substrate described in [Shell and Process Runtime](docs/architecture/process-runtime.md). Phase 8D completes the final integration: [Git Runtime](docs/architecture/git-runtime.md) adds bounded read-only Git inspection, while [Tool Effects](docs/architecture/tool-effects.md) defines pure file/process projections and atomic durable settlement. Phase 9C adds the [Input Security Policy](docs/architecture/input-security-policy.md) and [Secret Redaction](docs/architecture/secret-redaction.md) boundaries. Phase 9D adds the [Security Threat Model](docs/architecture/security-threat-model.md), [Security Capability Matrix](docs/architecture/security-capability-matrix.md), explicit logical/policy sandbox admission, sanitized child environments, fixed-config Git/rg helpers, and secure default Tool Dispatcher composition. Shell output is terminal-sanitized and also passes the injected high-confidence secret sanitizer; process sessions remain runtime-local and are represented in AgentState only through successful effects. The default catalog is injected and immutable.

Phase 9D's sandbox is logical and policy-based, not an OS sandbox: structured workspace tools retain lexical/realpath containment, while `exec_command` and `write_stdin` are explicitly `UNCONFINED_LOCAL_PROCESS` capabilities with sanitized environments and policy/approval gates. Phase 10A's process cancellation, Phase 10B's timeout cleanup, Phase 10C's provider retry waiting, and Phase 10D's budget cleanup are cooperative lifecycle controls and do not claim universal descendant termination or hard isolation. V1 does not claim syscall, network, filesystem, container, seccomp, job-object, or remote-runtime isolation. Phase 10 is sealed after 10D; budget accounting is not billing. Phase 11B executes only resolved PROJECT checks through the shared Runtime/ProcessManager path, records bounded evidence, and leaves the Run at `VERIFYING` until future 11C/11D authority.

## Phase 5 Status

- Phase 5A — Workspace & Project Intelligence: **COMPLETED**
- Phase 5B — Relevant File Discovery & Context Budget: **COMPLETED**
- Phase 5C — ContextBuilder & Final Context Assembly: **COMPLETED**

Caelush can build provider-independent, budgeted LLMRequest-ready message context from project facts, project instructions, relevant files, and conversation history. Phase 6C consumes that context through a resumable one-turn AgentLoop and persists only the real conversation separately from synthetic provider context. See [Run Controller](docs/architecture/run-controller.md) for the durable execution and recovery boundary.

Phase 8B architecture details are documented in [Patch Engine](docs/architecture/patch-engine.md). Phase 8D details are documented in [Git Runtime](docs/architecture/git-runtime.md) and [Tool Effects](docs/architecture/tool-effects.md). Phase 9A details are documented in [Security Policy Kernel](docs/architecture/security.md); Phase 9B details are documented in [Durable Approval Workflow](docs/architecture/approval-workflow.md).

Phase 10A details are documented in [Run Cancellation](docs/architecture/cancellation.md), including the durable intent, scope/lock sequence, signal fan-out, approval/process cleanup, recovery priority, race semantics, and explicit non-goals.

Phase 10B details are documented in [Run Deadline and Timeout](docs/architecture/timeout.md), including absolute deadline arithmetic, timer lifecycle, Provider timeout separation, idle boundaries, cleanup ownership, `TIMEOUT_PENDING`, and restart-safe recovery.

Phase 10C details are documented in [Provider Retry and Backoff](docs/architecture/retry.md), including transient classification, bounded backoff/jitter, durable `WAITING_RETRY`, event ordering, new Step/LLM call identity, timer recovery, cancellation/deadline priority, and the no-Tool-replay boundary.

Phase 10D details are documented in [Budget Architecture](docs/architecture/budget.md) and [Execution Governance](docs/architecture/execution-governance.md), including the durable ledger lifecycle, request admission, conservative missing usage, pricing snapshots, Tool batch preflight, authority priority, cleanup, and the explicit Phase 10 final boundary.

Phase 11A/11B details are documented in [Verification Architecture](docs/architecture/verification.md) and [Verification Execution](docs/architecture/verification-execution.md), including the immutable Protocol contract, deterministic plan matrix/hash, fresh Phase 5 project facts, exact project resolvers, typed argv Runtime path, Phase 9 admission, bounded redacted evidence, atomic check lifecycle, event publication, fail-fast and stale recovery rules. Phase 11B remains below completion authority: WORKSPACE/GIT/TASK checks stay pending and the Run remains `VERIFYING`.

## 技术栈

- TypeScript、ESM、Node.js 24 LTS
- pnpm 11 workspace monorepo
- Vitest、ESLint flat config、Prettier
- 当前 Protocol 使用 Zod 4，ID 使用 UUIDv7；Storage 使用 Node 原生 `node:sqlite`、Drizzle ORM/Kit RC；Daemon 使用 Fastify 5、`@fastify/sse` 和 `fastify-type-provider-zod`；React/Vite、Ink、AI SDK、Pino、node-pty 等仍留待后续阶段

## Repository 结构

```text
apps/
  daemon/       Local Agent Service 边界
  cli/          CLI 宿主边界
  web/          Web 宿主边界
packages/
  protocol/     稳定 Contract 边界
  core/         Agent Kernel 边界
  llm/          LLM Provider 边界
  context/      Workspace/project intelligence 与 ContextBuilder 边界
  tools/        Tool Contracts、Schema Runtime 与 Registry 边界
  runtime/      执行 Runtime 边界
  security/     Permission / Sandbox 边界
  verification/ 完成验证边界
  events/       Event Stream 边界
  storage/      持久化边界
  observability/日志与 Trace 边界
  shared/       少量真正跨模块的无业务工具
docs/           架构与工程文档
tests/          架构守卫测试
```

每个 workspace project 都通过自己的 `src/index.ts` 建立公共入口；内部依赖必须使用 `@caelush/*` 和 `workspace:*`，不能通过深层 `src` 路径绕过入口。

## 安装与检查

使用 Node 24.x 和 pnpm 11.x。仓库通过 `packageManager` 固定到 pnpm 11.21.0，也提供 `.nvmrc`。

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check
```

`pnpm check` 是本地统一质量门，依次执行 lint、typecheck、test、build 和 format check。

## Packages 基础说明

Phase 1 在 `@caelush/protocol` 中定义 Session、Run、Step、State、Tool/Observation/Approval/Verification 和 Event Contract，在 `@caelush/core` 中提供 Run State Machine。Phase 2 在 `@caelush/storage` 中提供 Repository、Run State Snapshot、SQLite Migration 和 Durable Event Store，在 `@caelush/events` 中提供 EventBus、Replay 与 Live Watch。Phase 3 在 `@caelush/daemon` 中提供 Local HTTP Service、Session API、Run API 和 SSE Event Stream。Phase 4A 在 `@caelush/llm` 中定义 provider-neutral LLM contracts 和显式 Provider Registry；Phase 4B 增加注入式 `LLMGateway` 和 one-turn streaming runtime；Phase 5A 在 `@caelush/context` 中发现 workspace、project root、环境、项目画像和层级指令，Phase 5B 增加 task-dependent relevant file discovery、deterministic ranking、provider-independent estimation 与 file budget，Phase 5C 增加 deterministic final context assembly、conversation integrity、compaction boundary 和 caller-supplied model-input budget；Phase 6B 在 `@caelush/core` 中以 ports 方式编排 ContextBuilder、LLMRequest 与单次 provider turn，并以 normalized tool-result batch 支持恢复；Phase 7A 在 `@caelush/tools` 中增加 Tool Registration、严格 Ajv Schema Runtime、immutable ToolRegistry 与 model/runtime catalog consistency，Phase 7B 增加 ToolDispatcher、Gate、durable invocation/observation lifecycle、atomic SQLite settlement、idempotency 与 recovery；Phase 8A 在 `@caelush/runtime` 中增加本地只读 Runtime 与四个 bounded filesystem/search Tool。详见 [Package Boundaries](docs/architecture/package-boundaries.md)、[Architecture Overview](docs/architecture/README.md)、[Protocol V1](docs/architecture/protocol-v1.md)、[Tool System](docs/architecture/tool-system.md)、[Runtime](docs/architecture/runtime.md)、[Context & Project Intelligence](docs/architecture/context-and-project-intelligence.md)、[Relevant Context Discovery](docs/architecture/relevant-context-discovery.md)、[ContextBuilder](docs/architecture/context-builder.md)、[Agent Loop](docs/architecture/agent-loop.md)、[Storage & Events](docs/architecture/storage-and-events.md)、[Local Agent Service](docs/architecture/local-agent-service.md) 和 [LLM Gateway](docs/architecture/llm-gateway.md)。
