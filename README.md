# Caelush

Caelush 是一个面向通用 Agent 的本地 Kernel 项目，目标是让 CLI、Web 和其他宿主共享同一个可观察、可取消、可验证、可扩展的 Agent Core。

当前仓库处于 **V1 Phase 0：Repository & Architecture Foundation**。本阶段只建立 Monorepo、package 边界、公共入口、工程检查和架构守卫；它还不能自主执行 Agent Task。

## 技术栈

- TypeScript、ESM、Node.js 24 LTS
- pnpm 11 workspace monorepo
- Vitest、ESLint flat config、Prettier
- 后续阶段再按实际需求引入 Fastify、React/Vite、Ink、Zod、AI SDK、SQLite/Drizzle、Pino、node-pty 等依赖

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

Phase 0 只创建职责边界和可导入的空公共入口，不提前实现 AgentLoop、正式 Agent State/Session/Run、LLM Provider、Tool、Runtime、Storage、CLI 产品或 Web 产品。详见 [Package Boundaries](docs/architecture/package-boundaries.md) 和 [Architecture Overview](docs/architecture/README.md)。
