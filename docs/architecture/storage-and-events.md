# Storage & Events

Phase 2 为 Caelush V1 建立恢复边界，但不实现 AgentLoop、Provider、Tool 执行、Runtime 或宿主 API。

## Dependency direction

```text
events  → protocol
storage → events + protocol
core    → protocol
```

`@caelush/events` 定义 `DurableEventStore` port、`EventBus`、replay 和 live watch；它不知道 SQLite 或任何具体 storage 实现。`@caelush/storage` 提供 SQLite/Drizzle adapter，并在组合根中把 `SqliteDurableEventStore` 注入 EventBus。

## SQLite lifecycle

`openCaelushStorage({ path })` 只接受显式数据库路径。打开数据库后会启用 foreign keys、busy timeout 和 file-backed WAL，并通过已提交的 Drizzle migration 初始化 schema。migration 失败会转换成 `StorageMigrationError`，同时关闭已经打开的连接；调用方不会得到半初始化的 storage。

public storage API 只暴露 `openCaelushStorage`、repository、codec、event store 和 storage errors，不暴露 `DatabaseSync`、Drizzle client、数据库 row 或 migration internals。

## Repository and codec boundary

Session、Run、Step 和 Run State Snapshot 以 Protocol schema 作为 source of truth。实体的完整 JSON 放在 `data_json`，用于筛选和排序的字段使用受约束的索引列；读取时同时校验 JSON entity 与索引列，发现损坏立即抛出 `StorageDecodeError`。

Run State Snapshot 使用单行 revision：首次保存为 revision 1，后续保存递增 revision。它不是 Event Sourcing projection，也不从 Event Store 推导第二套状态模型。

## Durable events

Durable event append 在一个 `BEGIN IMMEDIATE` 事务内完成：为 run 初始化 sequence row，原子递增该 run 的 counter，读取新 sequence，校验并插入完整 event JSON，最后提交。sequence 不是通过 `MAX(sequence) + 1` 计算，因此并发 append 不会产生重复 sequence；任何冲突都会回滚 counter 和 event row。

Replay 使用 `aggregate_sequence > afterSequence` 的排他游标，按 sequence 升序返回，并限制单次读取数量。EventBus 的 watch 先注册 live listener，再读取 replay；catch-up 期间的事件进入缓冲区，replay 完成后按 sequence 合并并去重，再继续消费 live tail，从而避免 replay/live race 导致丢失或重复。

Ephemeral event 不写入 Storage，只在当前 EventBus 订阅者中 live fan-out。Durable event 必须先 append 成功，再向订阅者发布；持久化失败时不会产生可见发布。

## Recovery and integrity

关闭并重新打开同一个数据库文件后，Session、Run、Step、State Snapshot、Durable Event 和 per-run sequence 都可以恢复。SQLite `PRAGMA integrity_check` 必须返回 `ok`；这项检查是测试中的数据库完整性门，不是业务状态投影。
