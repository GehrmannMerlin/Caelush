# Package Boundaries

本文档冻结 Caelush V1 当前的工程边界。Phase 1 已正式落地 Protocol Contract 与 Core 的 Run State Machine；其余职责仍是后续阶段的边界，不代表对应功能已经实现。

通用规则：

- 所有 package/app 都是 private ESM workspace project。
- 所有公共 API 从 `src/index.ts` 导出；workspace 开发可直接解析这个入口，Node package 构建仍生成 `dist/`，禁止深层 `src` import。
- app 只能向下依赖 package；package 绝不依赖 app。
- 内部 package 依赖使用 `@caelush/*` 包名与 `workspace:*` 协议。
- `protocol` 位于最底层，只承载跨边界 Contract，不依赖其他 Caelush feature package；当前唯一真实的内部依赖是 `core → protocol`。
- `shared` 只承载真正跨模块、无业务含义的通用工具；“暂时不知道放哪”不是放入 shared 的理由。

## Packages

| Package                  | 负责什么                                                                                                                        | 不负责什么                                                   | 允许依赖谁                                                                            | 禁止依赖谁                                        | 未来典型使用者                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `@caelush/protocol`      | AgentSession、AgentRun、AgentStep、AgentState、AgentEvent、Tool/Approval/Verification/API Contract 的稳定类型与 schema 边界     | Agent 执行、Provider 调用、Tool 实现、存储、HTTP、UI         | 无其他 Caelush feature package；仅可使用必要的通用外部 schema 依赖                    | 所有其他 Caelush package、所有 apps               | Core、daemon、CLI、Web、Storage、Events        |
| `@caelush/core`          | RunController、AgentLoop、AgentState 协调、SessionManager、RunExecutionContext、Retry、Budget，以及当前阶段的 Run State Machine | 具体 LLM、具体 Tool、文件/进程执行、权限实现、UI、数据库细节 | `protocol`、`events`、`llm`、`context`、`tools`、`security`、`verification`、`shared` | apps、具体 provider/tool/runtime 实现的反向耦合   | daemon、CLI adapter、Web adapter               |
| `@caelush/llm`           | Caelush LLMProvider 抽象、provider adapter 边界、流式模型调用协议                                                               | AgentLoop、Session、Tool 执行、权限、HTTP API                | `protocol`、`events`、`shared`，以及未来明确的 AI SDK adapter                         | apps、`core` 反向依赖、具体业务工具               | core、daemon composition                       |
| `@caelush/context`       | ContextBuilder、上下文来源与预算边界、Observation compact 的接口                                                                | LLM 调用、AgentLoop、文件编辑、持久化                        | `protocol`、`shared`                                                                  | apps、具体 provider、具体 Tool 执行               | core、llm adapter                              |
| `@caelush/tools`         | ToolDefinition、ToolRegistry、ToolDispatcher、Tool Invocation 与 Observation 编排边界                                           | 具体 Runtime 内核、权限策略本身、LLM provider、UI            | `protocol`、`runtime`、`security`、`events`、`shared`                                 | apps、`core` 反向依赖、绕过 Dispatcher 的工具调用 | core、daemon                                   |
| `@caelush/runtime`       | 可替换 Runtime 接口、本地/远程/容器执行能力的抽象                                                                               | Tool 注册、权限决策、AgentLoop、Provider、UI                 | `protocol`、`security`、`events`、`shared`                                            | apps、具体 AgentLoop、直接承载业务策略            | tools、core、daemon                            |
| `@caelush/security`      | Permission、Approval、Capability、Sandbox/边界策略、Secret protection 的接口                                                    | 实际命令执行、Tool 业务、Session、UI                         | `protocol`、`events`、`shared`                                                        | apps、具体 Runtime 细节、LLM provider             | tools、runtime、daemon                         |
| `@caelush/verification`  | VerificationManager、完成条件、测试/检查结果与 VerificationResult 边界                                                          | 任务规划、Tool 执行、LLM、UI、持久化实现                     | `protocol`、`runtime`、`events`、`shared`                                             | apps、具体 provider、绕过结果的 Core shortcut     | core、daemon                                   |
| `@caelush/events`        | AgentEvent stream、sequence、EventBus 与多消费者接口                                                                            | Agent 决策、UI 渲染、数据库 schema、Provider 协议            | `protocol`、`shared`                                                                  | apps、具体业务执行器、反向依赖 UI                 | core、daemon、CLI、Web、observability、storage |
| `@caelush/storage`       | SQLite/Drizzle 未来的 schema、repository、durability boundary                                                                   | AgentLoop、权限、HTTP、UI、Provider                          | `protocol`、`events`、`shared`                                                        | apps、Core 内部状态机实现、直接执行 Tool          | daemon、observability                          |
| `@caelush/observability` | Pino logging、RunTrace、metrics/trace consumers 的边界                                                                          | 业务决策、权限、数据库所有权、UI 状态                        | `protocol`、`events`、`shared`                                                        | apps、反向驱动 Core、直接控制 Runtime             | daemon、CLI diagnostics、Web diagnostics       |
| `@caelush/shared`        | 少量真正跨模块的无业务通用类型/工具                                                                                             | 业务实体、Agent 状态、万能 service、随意收纳代码             | 无 Caelush feature package                                                            | 所有 feature package 与 apps 的反向业务耦合       | 所有需要且确有跨模块价值的 package             |

## Apps

| App               | 负责什么                                                           | 不负责什么                                         | 允许依赖谁                                                | 禁止依赖谁                                                | 未来典型使用者         |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `@caelush/daemon` | Local Agent Service、Fastify HTTP API、SSE、依赖组合与进程生命周期 | 独立 AgentLoop、独立状态模型、业务 Tool 实现       | 通过公共入口组合所需 packages                             | 依赖其他 app 的内部实现、深层 package `src`               | 本机服务进程、CLI、Web |
| `@caelush/cli`    | Ink presentation、命令解析、Event 渲染、用户输入转发               | AgentLoop、Provider、Tool、Runtime、Session 持久化 | `daemon` API/client boundary 或明确公共 packages          | 拷贝 Core、直接调用具体 Tool/Provider、依赖 Web           | 终端用户               |
| `@caelush/web`    | React/Vite presentation、HTTP/SSE client、Event 渲染、Web state    | AgentLoop、Provider、Tool、Runtime、服务端存储     | `daemon` API/client boundary 或明确公共 protocol packages | 浏览器内复制 Agent、Node-only runtime、深层 package `src` | 浏览器用户             |

## Boundary intent

Phase 1 已正式化 `protocol` 中的 Contract，并由 Core 的状态机通过公共入口消费它；Events、Storage 和 adapters 仍将在后续阶段接入。保持边界现在就可验证，可以避免后续把 CLI/Web 逻辑、provider 细节或执行权限渗入 Kernel。
