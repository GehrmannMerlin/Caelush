# Caelush Architecture Overview

Caelush V1 采用 CLI/Web 共核的分层方式。Presentation 层只负责宿主交互，不能复制 Agent 执行逻辑。

```text
Presentation
CLI / Web
    ↓
Local Agent Service
HTTP API / SSE / composition boundary
    ↓
Caelush Kernel
Core / Protocol / Context / Events
    ↓
LLM / Tool System
Provider abstraction / Dispatcher / observation boundary
    ↓
Security / Runtime
Permission / approval / sandbox / replaceable execution
    ↓
Filesystem / Shell / Process / Git / Web
External system adapters
    ↓
Storage / Events / Trace
Durability and observability consumers
```

当前已完成 Phase 0 的仓库基础，并在 Phase 1 落地 `@caelush/protocol` 的稳定 Contract、Typed AgentEvent 与 `@caelush/core` 的 Run State Machine。LLM、Tool 执行、Runtime、持久化、服务端和 UI 的运行时行为仍会在后续 Phase 逐步实现；空 package 不是功能缺失的临时替代，而是刻意冻结的边界。

依赖方向遵循：

```text
apps
  ↓
packages
  ↓
protocol（稳定底层 Contract）
```

实际 package 的职责、允许依赖和禁止依赖见 [package-boundaries.md](package-boundaries.md)。

Phase 1 的协议细节见 [protocol-v1.md](protocol-v1.md)。
