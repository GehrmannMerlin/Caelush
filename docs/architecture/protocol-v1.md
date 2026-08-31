# Caelush Protocol V1

Phase 1 只定义跨模块 Contract 和 Core 状态边界，不实现 AgentLoop、Provider、Tool 执行器、Runtime 或持久化。

## Contract 分层

```text
Primitives / IDs / JSON-safe values
        ↓
Session / Run / Step / PlanItem / AgentState
        ↓
ToolDefinition / ToolInvocation / Observation / Approval / Verification
        ↓
Typed AgentEvent
        ↓
Core Run State Machine
```

`@caelush/protocol` 是稳定底层 Contract Package。Schema 使用 Zod，公共类型从 `src/index.ts` 导出，业务 package 不应通过深层路径访问实现文件。

## Domain relationships

- `AgentSession` 是跨多个执行任务的用户会话容器。
- `AgentRun` 是一次有明确 goal、workspace、model、runtime、policy 和 limits 的执行。
- `AgentStep` 是 Run 内按 sequence 排序的单次推理/动作步骤。
- `PlanItem` 是可展示、可更新的计划条目，不与 Step 混为同一实体。
- `AgentState` 是当前 Run 的可重建状态快照，包含计划、观察、文件变化、进程、错误、验证和 usage 摘要。

## Tool and observation boundary

`ToolDefinition` 是数据描述，只包含名称、说明、JSON 输入/输出 schema、风险级别、能力和 Runtime 要求；它不携带函数、闭包、Provider SDK 类型或执行逻辑。`ToolInvocation` 描述一次请求及其状态和结果引用。未来的 Dispatcher、Permission 和 Runtime 才负责执行链路。

`Observation` 是执行结果的 Contract，按 `tool`、`verification`、`system` 区分来源。`ApprovalRequest` 描述等待授权的动作，`VerificationResult` 描述完成条件检查的结果；它们不能被一个含糊的通用字符串替代。

Phase 11A adds immutable `VerificationPlan`/`VerificationCheck`/`VerificationEvidence` contracts alongside the legacy execution-result types. The new planning contract is intent-only and command-free; a final candidate carries a plan pointer into the durable `VERIFYING` boundary, while actual check execution and completion authority remain future Phase 11 rounds.

## Events and durability

`AgentEvent` 是按 `type` 判别的 Typed Union。事件 envelope 包含 `eventId`、`runId`、`timestamp`、`visibility`、`durability` 和类型化 `payload`。

- Durable 事件具有 `durability.kind = DURABLE`、`version = 1` 和正整数 `sequence`。
- Ephemeral 事件只有 `durability.kind = EPHEMERAL`，不伪造持久化 sequence。
- Durable `sequence` 是恢复与消费时的权威顺序；timestamp 只表示时间，不承担排序职责。
- 用户可见过程通过 Event Contract 暴露，UI 不应自行猜测 Core 内部状态。

Phase 1 的事件联合覆盖 Run 生命周期、状态变化、推理摘要、计划、Tool、文件、Shell、Process、Verification、Approval、LLM 和错误事件，但没有实现 EventBus、EventStore 或其他持久化设施。

## Run state machine

允许的主路径为：

```text
PENDING → RUNNING
RUNNING → WAITING_APPROVAL → RUNNING
RUNNING → VERIFYING → RUNNING
VERIFYING → COMPLETED
```

执行失败、取消、超时、步数上限和预算超限只能进入对应终态；所有终态不可重新激活。`RUNNING → COMPLETED` 被明确禁止，完成必须先经过 `VERIFYING`。
