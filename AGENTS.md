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
- 公共 API 只能从每个 package 的 `src/index.ts` 进入；禁止 `@caelush/*/src/...` 和深层相对路径跨 package import。

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

## V1 Phase Boundary

当前是 Phase 0：只建立 Repository & Architecture Foundation。当前阶段不实现 AgentLoop、LLM、Tool、Runtime、正式 Agent State/Session/Run、Storage、Fastify API、SSE、Ink CLI 功能或 React Web 功能。

下一阶段是 Phase 1：Protocol & State Model。届时再正式定义 AgentSession、AgentRun、AgentStep、AgentState、AgentEvent、ToolDefinition、ToolInvocation、Observation、ApprovalRequest、VerificationResult 和 Run State Machine。
