# Caelush V1 Phase 3: Local Agent Service Design

**Status:** Approved for implementation on 2026-08-28

## Goal

建立 Caelush 唯一的本地 Agent Service / Daemon，使未来的 CLI、Web 和其他客户端通过统一的 HTTP/SSE 服务访问同一套 Session、Run、Storage 与 EventBus。Phase 3 交付 Local Service Infrastructure，不交付 Agent Intelligence 或 Agent Runtime。

## Scope and non-goals

本阶段实现：

- Fastify 5 HTTP App Factory 与 Daemon Composition Root。
- Protocol 中的 API DTO 与 Zod schemas。
- Loopback-only 网络安全基线、Host Guard、Origin Guard 和统一 HTTP 错误。
- Health、Session、Run JSON API。
- 基于现有 EventBus.watch() 的 Durable/Ephemeral SSE Event Stream。
- Durable sequence cursor、Last-Event-ID、query cursor、replay/live tail、多客户端和断开清理。
- Graceful shutdown、启动失败、端口占用和同一 SQLite 文件 restart recovery。
- Architecture 文档、README/AGENTS 边界说明和可观察行为测试。

本阶段明确不实现：

- AgentLoop、RunController、LLMProvider、LLM Gateway 或 AI SDK。
- ContextBuilder、ProjectDetector、EnvironmentDetector。
- ToolRegistry、ToolDispatcher、Filesystem/Shell/Process/Git Tool。
- PermissionManager、ApprovalManager、VerificationManager。
- Runtime 执行、取消执行语义、Approval resolution。
- React、Vite、Ink、Web Search、Browser、MCP、Skill、Workflow 或 Multi-Agent。
- Workspace 浏览、文件 API、Session/Run/Event 删除 API。
- Fake runtime、Fake run.started/run.completed 事件。

Run creation 只创建持久化的 `PENDING` Run，不启动 Agent，不改变状态，也不发布 `run.started`。

## Dependency and package boundaries

采用精确依赖版本：

```text
fastify                       5.12.1
@fastify/sse                  0.6.0
fastify-type-provider-zod     7.0.0
zod                           4.4.3 (existing)
```

registry peer 检查确认 `@fastify/sse@0.6.0` 要求 Fastify `^5.x`，`fastify-type-provider-zod@7.0.0` 要求 Fastify `^5.5.0` 和 Zod `>=4.1.5`。

允许的依赖方向：

```text
apps/daemon → @caelush/protocol
apps/daemon → @caelush/storage
apps/daemon → @caelush/events
apps/daemon → fastify
apps/daemon → @fastify/sse
apps/daemon → fastify-type-provider-zod
```

禁止任何 `packages/* → apps/daemon` 反向依赖；禁止跨 package 的 `@caelush/*/src/...` deep import。Protocol 只包含 JSON-safe schema 和类型，不依赖 Fastify 或 transport runtime。

不添加 `@fastify/cors`、Swagger、React、Vite、Ink、Socket.IO、`ws`、AI SDK、dotenv、独立 Pino 或 production EventSource dependency。

## Protocol API contract

在 `packages/protocol/src/api/` 中定义 `common.ts`、`health.ts`、`session.ts`、`run.ts`、`event-stream.ts` 和 `index.ts`，并从 `@caelush/protocol` 根入口导出。

### Health

```json
{
  "service": "caelush-daemon",
  "status": "ready",
  "apiVersion": "v1",
  "protocolVersion": 1
}
```

Health 不暴露数据库路径、环境、密钥或 API key。

### Session

```text
POST /api/v1/sessions
GET  /api/v1/sessions
GET  /api/v1/sessions/:sessionId
```

`CreateSessionRequest` 只允许客户端字段：`title?`、`defaultWorkspace?`、`defaultModel?`、`metadata?`。Server 生成 `id`、`createdAt`、`updatedAt`；缺省 metadata 使用 `{}`。完整实体必须通过 `AgentSessionSchema.parse()` 后写入 Repository。创建返回 `201` 和完整 `AgentSession`；不存在返回 `404`。List 使用 `{ items: [...] }`，`limit` 默认 50、最大 100。

### Run

```text
POST /api/v1/sessions/:sessionId/runs
GET  /api/v1/sessions/:sessionId/runs
GET  /api/v1/runs/:runId
```

`CreateRunRequest` 只允许客户端字段：`goal`、`workspace`、`model`、`runtime`、`permissionProfile`、`approvalPolicy`、`limits`。`sessionId` 只从 path 取得；Server 生成 `id`、`createdAt`，并强制设置 `status: PENDING`。创建前显式验证 Session parent，parent 不存在返回 `404`，而不是泄漏 SQLite foreign-key 错误。List 使用 `{ items: [...] }`，可带 `limit` 和现有 status filter。

### Errors

所有 JSON 错误都使用：

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Requested resource was not found.",
    "requestId": "<fastify request.id>"
  }
}
```

错误代码和状态：

| 来源                                      | HTTP | code                   |
| ----------------------------------------- | ---: | ---------------------- |
| Zod/Fastify request validation            |  400 | `INVALID_REQUEST`      |
| 非法或冲突的 SSE cursor                   |  400 | `INVALID_EVENT_CURSOR` |
| `StorageNotFoundError`                    |  404 | `NOT_FOUND`            |
| `StorageConflictError`                    |  409 | `CONFLICT`             |
| `StorageDecodeError` 或其他 Storage error |  500 | `STORAGE_ERROR`        |
| 未知内部错误                              |  500 | `INTERNAL_ERROR`       |

错误响应不得泄漏 stack trace、SQL、数据库路径、secret、环境变量、内部文件路径、损坏 JSON 或数据库 row。未知路由也返回该 JSON contract。

## Daemon architecture

推荐源码边界：

```text
apps/daemon/src/
├── main.ts
├── daemon.ts
├── app.ts
├── config.ts
├── services/
│   ├── session-service.ts
│   └── run-service.ts
├── routes/
│   ├── health.ts
│   ├── sessions.ts
│   ├── runs.ts
│   └── events.ts
├── transport/
│   ├── error-handler.ts
│   ├── local-request-guard.ts
│   └── sse-event-mapper.ts
└── index.ts
```

`buildDaemonApp()` 接收已准备好的 dependencies，注册 Zod provider、error handler、security guard 和 routes，返回 Fastify instance；它不得监听、读取 `process.env`、打开数据库或调用 `process.exit()`。

`startDaemon()` 读取显式 options，打开 `openCaelushStorage({ path })`，创建 EventBus 和 Services，构建 App 并监听，返回至少包含 `url` 和幂等 `close()` 的 `DaemonHandle`。Daemon 是唯一的本地服务组合根。

配置最小字段：

```text
host: 127.0.0.1
port: 43120
databasePath: explicit path
sseHeartbeatIntervalMs: 15000
```

main entry 可使用跨平台的 `os.homedir()`/`path.join()` 默认数据库目录，但 Library API 接受显式路径。import `@caelush/daemon` 不产生 listen 副作用。

## Network security

Daemon 默认只绑定 `127.0.0.1`，不默认使用 `0.0.0.0` 或 `::`；默认端口被占用时清晰失败，不自动漂移到下一个端口。测试可以使用 port 0。

不启用 CORS。Host Guard 只接受 `127.0.0.1`、`localhost`、`[::1]` 及可选端口，拒绝 DNS rebinding 场景中的 attacker Host。Origin 缺省时允许 CLI/curl/native client；存在 Origin 时只允许 loopback HTTP(S) origin，拒绝任意公网 Origin。

这不是远程认证系统，不实现 JWT、OAuth、login 或 API key。

## SSE design

```text
GET /api/v1/runs/:runId/events
Content-Type: text/event-stream
```

Headers 提交前先通过 RunRepository 确认 Run 存在；不存在返回普通 404 JSON。存在后，route 只调用 `EventBus.watch(runId, { afterSequence, signal })`，不读取 SQLite、不重做 replay 分页。

AgentEvent 映射：

```text
event: AgentEvent.type
data: JSON.stringify(full AgentEvent)
```

只有 Durable Event 加：

```text
id: String(event.durability.sequence)
```

Ephemeral Event 和 heartbeat 永远没有 SSE id；Ephemeral 不持久化、不 replay、不能推进 `Last-Event-ID`。

支持：

- 标准 `Last-Event-ID` header。
- `?afterSequence=<integer>` query cursor。
- 未提供 cursor 时使用 0，replay 全部 Durable History。
- cursor 必须是 `integer >= 0`。
- header/query 一致时允许，冲突时 `400 INVALID_EVENT_CURSOR`。
- disconnect 时 abort watch、释放 iterator、subscriber 和缓冲区。
- graceful shutdown 时关闭 active SSE，保证 bounded-time 返回。

使用 `@fastify/sse` 的 AsyncIterable/heartbeat 能力，不新增 EventSource 生产依赖。SSE 测试至少一部分使用真实 `listen(0)`、Node `fetch()` 和 ReadableStream parser。

## Lifecycle and failure handling

启动顺序：

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

Storage migration 失败或 listen 失败时 `startDaemon()` reject，不能让服务看似已启动。关闭顺序：停止新请求、终止 active SSE/watch、等待 in-flight request、关闭 Fastify、最后关闭 Storage。`close()` 幂等；Signal handler 只存在于 `main.ts`，等待 close 后自然退出，错误设置 `process.exitCode = 1`，不在 library/routes/services 中调用 `process.exit()`。

## Tests and acceptance

所有新行为遵循 RED → GREEN → REFACTOR，先写测试并实际观察缺失功能导致的失败。测试 observable behavior，不断言私有 Map 大小。

覆盖 Protocol API schemas、unknown field rejection、Session/Run API、error mapping、Host/Origin Guard、Health、unknown route、SSE wire format、Durable/Ephemeral cursor semantics、Last-Event-ID replay、query cursor、cursor conflict、multi-client、disconnect cleanup、graceful shutdown、startup failure、port conflict、restart recovery 和真实 HTTP smoke。

最终 E2E 必须证明：临时 SQLite → 真实启动 → health → create Session → create PENDING Run → 两个 SSE client → Durable 1 → A 断开 → Durable 2/3 → A 用 Last-Event-ID 1 重连并收到 2/3 → live Durable 4 → live Ephemeral 无 id → close 关闭 streams/server/storage → 同一 DB 重启后 Session、Run 和 Durable history 可恢复。

## Documentation and future boundary

新增 `docs/architecture/local-agent-service.md`，说明：

```text
CLI / Web
    │
 HTTP / SSE
    ▼
Caelush Daemon
    ├── Routes
    ├── Services
    └── Event Adapter
    ▼
Storage + EventBus
```

文档必须解释 App Factory 与 listen 分离、Durable sequence = SSE id、Last-Event-ID → afterSequence → EventBus.watch replay/live、Ephemeral 无 id、Localhost security，以及 Cancellation/Approval endpoint intentionally deferred。

同步更新 README、AGENTS.md、`docs/architecture/package-boundaries.md` 和 architecture tests。Phase 3 完成后项目拥有 Local HTTP Service、Session API、Run API、SSE Event Stream，但仍不会真正执行 Agent Task；下一阶段是 Phase 4 LLM Gateway，本阶段停止于此。
