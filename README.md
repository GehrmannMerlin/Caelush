# Caelush

Caelush 是一个面向通用 Agent 的本地 Kernel 项目，目标是让 CLI、Web 和其他宿主共享同一个可观察、可取消、可验证、可扩展的 Agent Core。

当前仓库处于 **V1 Phase 6A：Agent Execution Contracts & Kernel State**。Phase 1 的 JSON-safe Protocol Contract、Typed AgentEvent 和 Core Run State Machine、Phase 2 的可恢复 SQLite 持久化/Durable Event Store/EventBus、Phase 3 的唯一本地 Daemon/Session/Run HTTP API/SSE Event Stream，以及 Phase 4 的 Caelush-owned LLM contracts、Provider Registry 和单次 provider-turn streaming runtime 已完成；Phase 5A 建立只读 workspace/project intelligence，Phase 5B 针对具体任务发现、排序并预算项目文件，Phase 5C 将项目事实、指令、相关文件和最近完整对话按 caller-supplied input budget 组装为 provider-independent、LLMRequest-ready 的 `LLMMessage[]`；Phase 6A 现在定义 deterministic Agent decision、step、tool-boundary 和 kernel-state semantics。Caelush 仍不能自动执行 AgentLoop 或本地 Tool。

## Phase 6 Status

- Phase 6A — Agent Execution Contracts & Kernel State: **COMPLETED**
- Phase 6B — Context → LLM Resumable Decision Loop: **NOT STARTED**
- Phase 6C — RunController, Persistence & Event Trace: **NOT STARTED**

Caelush now defines deterministic Agent decision, step, tool-boundary, tool-result resume, and kernel-state semantics. A model turn can be classified as a tool request or a final candidate, state can be advanced through a bounded step gate, and a final candidate stops at verification. It does not autonomously execute agent tasks yet; the resumable AgentLoop belongs to Phase 6B.

## Phase 5 Status

- Phase 5A — Workspace & Project Intelligence: **COMPLETED**
- Phase 5B — Relevant File Discovery & Context Budget: **COMPLETED**
- Phase 5C — ContextBuilder & Final Context Assembly: **COMPLETED**

Caelush can build provider-independent, budgeted LLMRequest-ready message context from project facts, project instructions, relevant files, and conversation history. Phase 6A now defines the deterministic AgentLoop boundary contracts; it does not autonomously execute agent tasks, and the resumable AgentLoop belongs to Phase 6B.

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
  tools/        Tool System 边界
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

Phase 1 在 `@caelush/protocol` 中定义 Session、Run、Step、State、Tool/Observation/Approval/Verification 和 Event Contract，在 `@caelush/core` 中提供 Run State Machine。Phase 2 在 `@caelush/storage` 中提供 Repository、Run State Snapshot、SQLite Migration 和 Durable Event Store，在 `@caelush/events` 中提供 EventBus、Replay 与 Live Watch。Phase 3 在 `@caelush/daemon` 中提供 Local HTTP Service、Session API、Run API 和 SSE Event Stream。Phase 4A 在 `@caelush/llm` 中定义 provider-neutral LLM contracts 和显式 Provider Registry；Phase 4B 增加注入式 `LLMGateway` 和 one-turn streaming runtime；Phase 5A 在 `@caelush/context` 中发现 workspace、project root、环境、项目画像和层级指令，Phase 5B 增加 task-dependent relevant file discovery、deterministic ranking、provider-independent estimation 与 file budget，Phase 5C 增加 deterministic final context assembly、conversation integrity、compaction boundary 和 caller-supplied model-input budget。Caelush can build provider-independent, budgeted LLMRequest-ready message context from project facts, instructions, relevant files and conversation history, but no real model provider or AgentLoop is connected. 详见 [Package Boundaries](docs/architecture/package-boundaries.md)、[Architecture Overview](docs/architecture/README.md)、[Protocol V1](docs/architecture/protocol-v1.md)、[Context & Project Intelligence](docs/architecture/context-and-project-intelligence.md)、[Relevant Context Discovery](docs/architecture/relevant-context-discovery.md)、[ContextBuilder](docs/architecture/context-builder.md)、[Storage & Events](docs/architecture/storage-and-events.md)、[Local Agent Service](docs/architecture/local-agent-service.md) 和 [LLM Gateway](docs/architecture/llm-gateway.md)。
