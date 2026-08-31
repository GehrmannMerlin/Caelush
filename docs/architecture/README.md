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
SQLite durability, event stream and observability consumers
```

当前已完成 Phase 0 的仓库基础、Phase 1 的 Protocol Contract/Core State Machine，以及 Phase 2 的 `@caelush/storage` SQLite durability 和 `@caelush/events` EventBus。Storage 通过 Repository 与 Durable Event Store 提供恢复所需的持久化；Events 只定义 Event Store port 和消费语义，具体 SQLite 实现仍由 Storage 持有。LLM、Tool 执行、Runtime、服务端和 UI 的运行时行为仍会在后续 Phase 逐步实现。

依赖方向遵循：

```text
apps
  ↓
packages
  ↓
protocol（稳定底层 Contract）
```

实际 package 的职责、允许依赖和禁止依赖见 [package-boundaries.md](package-boundaries.md)；Phase 2 的数据与消费语义见 [storage-and-events.md](storage-and-events.md)。

Phase 1 的协议细节见 [protocol-v1.md](protocol-v1.md)。

Phase 10 的生命周期治理已封存为 10A cancellation、10B deadline/timeout、10C bounded retry/backoff 和 10D budget enforcement。预算账本与保守 usage accounting 见 [budget.md](budget.md)，统一优先级、清理和终止边界见 [execution-governance.md](execution-governance.md)。
