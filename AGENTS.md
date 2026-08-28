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

当前是 Phase 4B：LLMGateway & Streaming Runtime。除 Phase 1 已正式定义的 AgentSession、AgentRun、AgentStep、AgentState、AgentEvent、ToolDefinition、ToolInvocation、Observation、ApprovalRequest、VerificationResult 和 Run State Machine，以及 Phase 2 的 SQLite/Drizzle Storage、Repository、Run State Snapshot、Durable Event Store、EventBus、Replay 与 Live Watch、Phase 3 的 loopback-only Daemon、Health/Session/Run HTTP API 和 Durable/Ephemeral SSE Event Stream 外，Phase 4A 已建立 Caelush-owned LLM contracts、LLMProvider 和显式 Provider Registry，Phase 4B 已建立注入式 LLMGateway 的 single-turn streaming runtime、runtime event validation、tool-call lifecycle validation、abort/timeout/cancellation 和 result aggregation；仍不实现 AgentLoop、真实 LLM/provider adapter、AI SDK、网络请求、Tool 执行、Runtime、AgentEvent bridge、Storage integration、Approval resolution、Ink CLI 功能或 React Web 功能。

下一阶段由后续任务另行定义；不得提前实现 AgentLoop 或其他宿主产品功能。
