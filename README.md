# Caelush

Caelush 是一个面向通用 Agent 的本地 Kernel 项目，目标是让 CLI、Web 和其他宿主共享同一个可观察、可取消、可验证、可扩展的 Agent Core。

当前仓库处于 **V1 Phase 3：Local Agent Service**。Phase 1 的 JSON-safe Protocol Contract、Typed AgentEvent 和 Core Run State Machine，以及 Phase 2 的可恢复 SQLite 持久化、Durable Event Store 和 EventBus 已完成；本阶段补齐唯一的本地 Daemon、Session/Run HTTP API 和 SSE Event Stream，但仍不能自主执行 Agent Task。

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
  context/      Context 构建边界
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

Phase 1 在 `@caelush/protocol` 中定义 Session、Run、Step、State、Tool/Observation/Approval/Verification 和 Event Contract，在 `@caelush/core` 中提供 Run State Machine。Phase 2 在 `@caelush/storage` 中提供 Repository、Run State Snapshot、SQLite Migration 和 Durable Event Store，在 `@caelush/events` 中提供 EventBus、Replay 与 Live Watch。Phase 3 在 `@caelush/daemon` 中提供 Local HTTP Service、Session API、Run API 和 SSE Event Stream。仍未实现 AgentLoop、LLM Provider、Tool 执行、Runtime、CLI 产品或 Web 产品；Run creation 也不会启动 Agent。详见 [Package Boundaries](docs/architecture/package-boundaries.md)、[Architecture Overview](docs/architecture/README.md)、[Protocol V1](docs/architecture/protocol-v1.md)、[Storage & Events](docs/architecture/storage-and-events.md) 和 [Local Agent Service](docs/architecture/local-agent-service.md)。
