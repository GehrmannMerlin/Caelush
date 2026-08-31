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

当前已完成 Phase 0 的仓库基础、Phase 1 的 Protocol Contract/Core State Machine、Phase 2 的 `@caelush/storage` SQLite durability 和 `@caelush/events` EventBus，以及 Phase 12A 的生产 Daemon execution surface 与共享 `@caelush/client` transport。Storage 通过 Repository 与 Durable Event Store 提供恢复所需的持久化；Events 只定义 Event Store port 和消费语义，具体 SQLite 实现仍由 Storage 持有。CLI/Web 仍是后续的 client host，不在本阶段复制 Agent 执行逻辑。

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

Phase 11A adds the intent-only Verification planning foundation; Phase 11B adds deterministic PROJECT check execution through fresh Phase 5 facts, Phase 9 admission, the shared typed-argv Runtime path, bounded evidence, and atomic check lifecycle events. Neither round authorizes completion. See [verification.md](verification.md) and [verification-execution.md](verification-execution.md).

Phase 11D is complete and owns guarded Completion Authority and finalization. Phase
12A adds the production daemon composition, asynchronous start/recover/cancel and
Approval control routes, `/api/v1/info`, loopback-only provider configuration, and
the browser-compatible typed HTTP/SSE client. See
[daemon-production-composition.md](daemon-production-composition.md) and
[client-transport.md](client-transport.md). Phase 12A does not implement the Ink
TUI or Web presentation layer.
