# Caelush Local Agent Service

Phase 3 建立 Caelush 唯一的本地 Agent Service。CLI、Web 和未来的其他宿主通过同一个 Daemon 访问共享的 Session、Run、Storage 和 EventBus，而不是各自创建 Agent runtime。

```text
CLI / Web
    │
    │ HTTP / SSE
    ▼
Caelush Daemon
    │
    ├── Routes
    ├── Application Services
    └── Event Adapter
    │
    ├──────────────┐
    ▼              ▼
Storage        EventBus
    │              │
    └──────┬───────┘
           ▼
       SQLite
```

## Composition root and app factory

`buildDaemonApp()` 和 `startDaemon()` 是两个不同的边界：

- `buildDaemonApp(dependencies)` 接收已经准备好的 Repository、EventBus 和配置，注册 Fastify、Zod provider、错误处理、Local Request Guard、JSON routes 和 SSE route，然后返回一个未监听的 App。
- `startDaemon(options)` 是 Composition Root，按 Storage → EventBus → Services → App → listen 的顺序创建运行时，并返回包含 `url` 和幂等 `close()` 的 DaemonHandle。

分离的原因是可测试性、依赖注入、避免 import side effect，以及明确的生命周期所有权。导入 `@caelush/daemon` 不会打开端口；只有显式调用 `startDaemon()` 或 command entry 才会监听。

应用服务只依赖 Storage 的公共 Repository API，不依赖 Fastify。SessionService 负责创建、读取和列出 Session；RunService 负责验证 parent Session、创建 PENDING Run、读取和列出 Run。

## HTTP contract

业务 API 统一使用 `/api/v1`：

```text
GET  /api/v1/health

POST /api/v1/sessions
GET  /api/v1/sessions
GET  /api/v1/sessions/:sessionId

POST /api/v1/sessions/:sessionId/runs
GET  /api/v1/sessions/:sessionId/runs
GET  /api/v1/runs/:runId

GET  /api/v1/runs/:runId/events
```

Protocol 中的 Zod schemas 是 API source of truth。Create Session/Run DTO 只接受客户端字段，未知字段和 server-owned 字段会被拒绝。Session/Run list 使用 `{ items: [...] }`，初期只支持默认 50、最大 100 的 limit。

Run creation 只持久化一个 `PENDING` Run。它不启动 Agent、不调用 AgentLoop、不改变状态、不发布 `run.started`，因为 Phase 3 还没有执行 runtime。

API 错误统一包含 `code`、安全的 `message` 和 Fastify `request.id`。Validation、NotFound、Conflict、Storage 和 Unknown error 分别映射到明确的 HTTP 状态和有限错误代码，不能泄漏 SQL、路径、stack、secret 或损坏 row。

## Local security baseline

Daemon 默认绑定 `127.0.0.1:43120`，测试使用 port 0。默认不绑定 `0.0.0.0` 或 `::`，端口占用时直接失败，不自动漂移。Phase 3 不启用 CORS，也不实现 JWT、OAuth、login 或 API key。

Host Guard 只接受 `127.0.0.1`、`localhost` 和 `[::1]` 加可选端口。没有 Origin 的 CLI、curl 和 native client 可以访问；有 Origin 时只接受 loopback HTTP(S) origin。这样可以阻止请求虽然到达 loopback、但 Host 来自攻击者域名的 DNS rebinding 场景。

## SSE and cursor semantics

Event Stream route 在提交 SSE headers 前先确认 Run 存在。确认后只调用 `EventBus.watch()`，由 EventBus 负责 Durable replay、live tail 和 replay/live race 合并；Daemon 不直接查询 SQLite，也不重新实现分页。

```text
EventBus.watch(runId, { afterSequence, signal })
    ↓
SSE Event Mapper
    ↓
@fastify/sse
    ↓
HTTP Client
```

Durable event 的 `durability.sequence` 是恢复和消费的权威顺序，也是 SSE id：

```text
Durable sequence
    =
SSE id
```

`Last-Event-ID: 143` 会转换为 `afterSequence: 143`。也支持 `?afterSequence=143`；两个值一致时允许，冲突时返回 `400 INVALID_EVENT_CURSOR`。Fresh connection 使用 cursor 0。Replay 完成后继续同一个 EventBus live tail，因此 reconnect 不会产生 duplicate 或 gap。

Ephemeral event 不写入 Event Store、不 replay、不推进 durable cursor。它可以实时发送给当前 subscribers，但 SSE frame 永远没有 `id`。Heartbeat 是 `@fastify/sse` 的 transport comment，不是 AgentEvent，不写入 Storage，也没有 id。

客户端断开会 abort 当前 watch、解除 subscriber、关闭 queue 并释放缓冲。Daemon shutdown 会先 abort 所有 active streams，再关闭 Fastify，最后关闭 Storage。

## Lifecycle and deferred semantics

启动顺序是：

```text
open Storage
    ↓
migration success
    ↓
create EventBus
    ↓
build app
    ↓
listen
```

关闭顺序是：停止接受新请求、关闭 streaming consumers、等待 HTTP 请求、关闭 Fastify、关闭 Storage。`close()` 幂等；SIGINT/SIGTERM 只由 `main.ts` 处理，library code 不调用 `process.exit()`。

Phase 12A 已将真实的 RunController cancellation 和 durable Approval resolution
暴露为 daemon control routes。`POST /start`、`/recover` 和 Approval resolution
只接受动作并在后台驱动 Core；`POST /cancel` 直接进入 Phase 10A 的高优先级
取消路径。HTTP 不等待整个 Agent 生命周期，进度和最终结果必须通过
`EventBus.watch()` 驱动的 SSE 与 Run 查询观察。

## Package boundaries

```text
daemon → protocol
daemon → storage
daemon → events

packages/* → daemon   forbidden
```

Daemon 只能通过各 package 的 public `src/index.ts` 进入 Protocol、Storage 和 Events。Storage、Events 和 Protocol 不知道 `apps/daemon`，从而保持 Core/Storage/EventBus 可独立测试与替换。

## Current boundary

Phase 12A 之后，Production daemon 已是 Caelush Local Agent Service：它组合
共享 AgentLoop/RunController、Provider Gateway、Tool Dispatcher、Local Runtime、
Approval/Budget/Verification 和单一 Storage/EventBus 生命周期，并提供 typed
HTTP control APIs 与 durable SSE replay。Session/Run creation 仍不会隐式执行
Run；CLI/Web 通过 `@caelush/client` 作为后续 host 接入。当前未实现 Ink/React
TUI、Web UI、自动 SSE reconnect、remote runtime、MCP、Browser、Computer Use
或新的 Core/Provider/Tool state machine。
