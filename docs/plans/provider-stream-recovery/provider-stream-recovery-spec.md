# Caelush Provider 流静默检测、恢复与可观测性正式规格

状态：实施前冻结稿  
日期：2026-10-04  
适用代码库：Caelush 仓库
基线：`main`，Message V2 Phase 5F 与 Event V2 Phase 6H 已完成

## 1. 目标

本规格解决以下同一故障链上的问题：Provider 流在已经建立后长期不再产生任何数据，Gateway 永久等待 `AsyncIterator.next()`，Run 继续显示为运行中，Daemon 关闭或重启可能等待活动执行，前端只有静态“思考中/正在等待模型响应”，用户无法区分正常长思考、Provider 静默、重试、传输切换、连接异常和明确失败。

目标不是公开模型的原始隐性思维链。目标是提供安全的过程摘要和真实的运行状态，包括：当前阶段、最近 Provider 活动、等待时长、恢复进度、浏览器到 Daemon 的连接状态，以及最终失败原因。

## 2. 不变式与边界

1. `apps/daemon` 仍是唯一生产 composition root；Web/CLI 不创建 Provider、AgentLoop 或第二套 Run 状态机。
2. `@caelush/ai` 的一次 Gateway 调用仍只代表一次 Provider 尝试；Gateway 和 adapter 不重试。
3. 重试、退避、备用传输选择和持久恢复的唯一权威仍是 Core/RunController。
4. adapter 必须把同一个 Gateway `AbortSignal` 传给真实网络传输，并在取消后停止读取；仅用 `Promise.race()` 返回而不取消底层 I/O 不合格。
5. Provider 的部分文本、部分 reasoning summary 和未完成 tool call 都是临时展示信号。失败尝试不得提交为 durable assistant message，未完成 tool call 永远不得进入 Dispatcher。
6. 不在公共事件、错误或 Transcript 中暴露原始隐性推理、Provider 原始 SSE、凭据、请求体、Tool 原始参数或异常文本。
7. “没有 Token”只能表示“近期无 Provider 活动”，不能单独推导网络连接不健康。
8. 浏览器↔Daemon SSE、Daemon↔Provider 传输和 Provider 内容活动必须作为三个独立维度呈现。
9. 硬崩溃后未知副作用边界继续 fail closed；尤其不得因为本功能重放 Tool。

## 3. 默认参数与产品语义

| 参数                          |     默认值 | 语义                                                                                    |
| ----------------------------- | ---------: | --------------------------------------------------------------------------------------- |
| `providerNudgeAfterMs`        |  30,000 ms | 连续无 Provider 事件达到该值，发布“近期无活动”状态；不判定断线，不中止                  |
| `providerStreamIdleTimeoutMs` | 300,000 ms | 每次成功取得 Provider 事件后重新计时；连续静默达到 5 分钟即取消本次传输并产生 `TIMEOUT` |
| `providerTeardownGraceMs`     |   5,000 ms | 发出取消后等待 iterator/transport 收尾的最大时间；超时后隔离晚到事件并继续失败结算      |
| `retryCount`                  |          5 | 初始请求之外最多重试 5 次                                                               |
| `maxAttempts`                 |          6 | 内部尝试总数：1 次初始请求 + 5 次重试                                                   |
| `retryBaseDelayMs`            |   1,000 ms | 本地指数退避基数                                                                        |
| `retryMaxDelayMs`             |  30,000 ms | 本地指数退避上限                                                                        |
| `retryJitterRatio`            |       0.10 | 本地退避使用对称 ±10% 抖动                                                              |
| `maxProviderRetryAfterMs`     | 300,000 ms | 可自动等待的 Provider `Retry-After` 上限                                                |

本地退避的无抖动基线为 `1s, 2s, 4s, 8s, 16s`。前端只显示重试序号 `1/5` 到 `5/5`，不把初始请求显示成“第 1 次重试”。durable continuation/event 中保留 attempt 总尝试编号时，必须由 client projector 显式换算 `retryOrdinal = attempt - 1`。

所有超时配置必须是正安全整数。生产默认不得是 `0`、`Infinity`、`undefined` 或负数。测试可以通过受控依赖注入使用短时间，但不能通过公共生产配置关闭流空闲超时。

## 4. Provider 流空闲看门狗

### 4.1 计时边界

空闲看门狗位于 `@caelush/ai` Gateway 运行时，包裹每一次 `adapterIterator.next()`：

1. `stream.start` 后进入 `WAITING_PROVIDER`。
2. 任一合法 adapter event 到达即更新 `lastActivityAt` 并重置 nudge 与 idle 定时器。活动包括文本、reasoning summary、tool call 分片、usage、finish；协议层 keepalive 只有在 adapter 明确翻译为受信活动时才算活动。
3. 连续静默 30 秒时产生一次 `stream.status(NO_RECENT_ACTIVITY)`；继续静默不重复刷屏。
4. 连续静默 300 秒时，以新的内部 abort kind `idle_timeout` 取消作用域，产生安全的 `AI_TIMEOUT`。
5. `iterator.next()`、iterator `return()` 和底层 fetch 必须观察该信号。取消后最多等待 5 秒收尾。
6. 收尾超过宽限时间时，Gateway 不再等待 adapter；以 invocation generation/closed flag 丢弃所有晚到事件，确保只产生一个 terminal outcome。

总调用 timeout 与流 idle timeout 独立：总 timeout 限制整个调用；idle timeout 限制相邻 Provider 活动之间的最长间隔。先触发者获胜，其 abort kind 不得被后触发者改写。

### 4.2 AI 流状态

扩展内部公共 AI 流联合类型，加入 Gateway 自有、非 durable 的 `stream.status`：

```ts
type AIStreamStatusPhase =
  | "WAITING_PROVIDER"
  | "RECEIVING_PROVIDER_DATA"
  | "NO_RECENT_ACTIVITY"
  | "CANCELLING_IDLE_STREAM";

interface AIStreamStatusEvent {
  readonly type: "stream.status";
  readonly payload: {
    readonly phase: AIStreamStatusPhase;
    readonly lastActivityAt: number;
    readonly idleForMs: number;
    readonly idleTimeoutMs: number;
  };
}
```

`stream.status` 只描述状态，不进入 assistant content，不改变 assembler 结果。`lastActivityAt` 由 Gateway 注入时钟生成；测试使用 fake timers/clock。状态只在相位变化时发送，正常内容 delta 仍是主要活动信号。

### 4.3 adapter 合同

- OpenAI-compatible adapter 继续设置 AI SDK `abortSignal` 且固定 `maxRetries: 0`。
- Anthropic native adapter 继续把 signal 传给 `fetch`，并在 SSE reader/iterator 关闭时 cancel reader。
- adapter conformance 增加“挂起读取在 abort 后必须 settle”的测试；不满足者不能注册为生产 adapter。
- 禁止在 adapter 内新增 sleep/retry/fallback。

## 5. Retry-After、有限重试与退避

### 5.1 Retry-After 解析

OpenAI-compatible 与 Anthropic error normalizer 共享一个 `parseRetryAfterMs(raw, nowMs)`：

- 支持非负 delta-seconds，允许小数并四舍五入为毫秒。
- 支持 RFC HTTP-date；计算 `max(0, parsedDate - nowMs)`。
- header 名大小写不敏感。
- 空值、负数、非有限数、无效日期或超出安全整数返回 `undefined`。
- 解析仅产生 Provider hint，不在 adapter 决定是否重试。

### 5.2 Retry 决策顺序

Core `RetryController.decide()` 的固定顺序：

1. 已取消 → `CANCELLED`。
2. 当前时间已越过 Run deadline → `DEADLINE_EXCEEDED`。
3. 达到 max steps → `MAX_STEPS_REACHED`。
4. 错误不可重试 → `NOT_RETRYABLE`。
5. 已完成 6 次总尝试 → `ATTEMPTS_EXHAUSTED`。
6. 若有合法 `Retry-After` 且 `<= 300,000ms`，精确采用该延迟，不加 jitter，不早于 Provider 指定时间重试。
7. 若 `Retry-After > 300,000ms`，停止并记为 `RETRY_AFTER_EXCEEDS_POLICY`；不得忽略 Provider 指示改成本地更早重试。
8. 若计算后的时间达到或越过 Run deadline → `DEADLINE_EXCEEDED`。
9. 否则采用指数退避并施加 ±10% jitter，结果限制在 `[1ms, 30,000ms]`。

`Retry-After: 0` 允许立即排入调度器，但必须通过 durable `WAITING_RETRY` 检查点，不允许在当前调用栈内递归重试。

### 5.3 durable 顺序

每次可重试失败：

1. 原子提交失败 Step、`llm.failed`、`retry.scheduled`、`WAITING_RETRY` continuation 与 Run 状态。
2. commit 成功后通知 live subscribers。
3. 到点恢复时，先原子提交新 RUNNING Step 与 `retry.started`，再做 Provider I/O。

最后一次失败或政策拒绝重试：原子提交失败 Step、`llm.failed`、新的 `retry.exhausted` 与终态 Run 事实。`retry.exhausted` payload：

```ts
{
  attempt: 6,
  maxAttempts: 6,
  retriesUsed: 5,
  maxRetries: 5,
  errorCode: "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT",
  reason:
    | "ATTEMPTS_EXHAUSTED"
    | "DEADLINE_EXCEEDED"
    | "MAX_STEPS_REACHED"
    | "RETRY_AFTER_EXCEEDS_POLICY";
}
```

不可重试错误仍由既有 `llm.failed`/Run failure 表示，不伪装为“重试耗尽”。

## 6. 备用传输

### 6.1 安全范围

自动 fallback 只允许：同一 Provider id、同一 model id、相同 API dialect/能力、由管理员预配置且经过验证的等价 transport candidate。禁止静默跨 Provider、跨模型或降低能力。当前生产配置若没有第二个真实 transport，则 fallback 功能保持无候选状态；必须以 fake dual-transport 完成合同测试，但不得制造一个虚假的生产备用端点。

### 6.2 权威与持久化

Daemon composition 将 provider transport candidates 投影为 Core 可消费的通用 `ModelTransportRecoveryPort`。Core 决定下一次尝试的 transport，并把选择写入 `WAITING_RETRY` continuation；AI Gateway 只执行传入的一次选择。

建议合同：

```ts
interface ModelTransportSelection {
  readonly transportId: string;
  readonly providerId: string;
  readonly modelId: string;
}

interface ModelTransportRecoveryPort {
  initial(input: {
    providerId: string;
    modelId: string;
  }): ModelTransportSelection;
  next(input: {
    current: ModelTransportSelection;
    attemptedTransportIds: readonly string[];
    errorCode: RetryErrorCode;
  }): ModelTransportSelection | null;
}
```

候选切换仅对 `NETWORK`/`TIMEOUT` 生效；RATE_LIMIT 默认遵守同一 transport 的 `Retry-After`，除非配置显式声明共享限流域之外的等价 transport。选择下一 transport 时，与 `retry.scheduled` 同一事务提交 `transport.fallback.selected` durable event；事件只含安全 transport id、from/to 和 retry ordinal，不含 endpoint/header/credential。

## 7. 重启与恢复矩阵

| 场景                                        | 行为                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daemon 在 durable `WAITING_RETRY` 期间停止  | continuation 已持久化；启动 reconciliation 自动恢复定时等待或立即调度过期重试                                                                                                                                |
| 受控关闭时正在等待 Provider，尚无可提交结果 | Supervisor 进入 draining，拒绝新执行；向活动模型请求发出 `MANAGED_RESTART` 取消；Core 将其原子转为可恢复 `WAITING_RETRY`，计入一次失败尝试；关闭等待受 5 秒 transport teardown 与全局 shutdown deadline 限制 |
| 受控关闭时 Tool 正在运行                    | 保持既有 side-effect 安全策略；不得为了重启自动重放 Tool                                                                                                                                                     |
| 进程硬崩溃，启动时发现 in-flight model Step | 默认 fail closed，因为请求是否已被 Provider 接收未知；只在对应 transport 提供并验证幂等请求键时才可自动转入 retry                                                                                            |
| 进程硬崩溃，启动时发现 in-flight Tool       | 永远沿用现有 fail-closed，不自动重放                                                                                                                                                                         |
| 用户显式继续 fail-closed Run                | 走既有/新增明确的恢复入口，并创建新的可审计尝试；不得伪装成原进程连续运行                                                                                                                                    |

受控重启恢复需要区分用户取消与宿主关闭。不得把 `MANAGED_RESTART` 映射为最终 `run.cancelled`。实现上由 Core execution scope 接收结构化停止原因；只有受控关闭原因可以创建 retry checkpoint。

Daemon `close()` 固定顺序：

1. 标记 Supervisor draining，拒绝新 start/recover。
2. 关闭 HTTP 接入或拒绝新 mutation；SSE 可保持到 checkpoint commit。
3. 请求所有活动 Run 在安全边界 checkpoint。
4. 等待 bounded drain；超过 deadline 的活动模型流被 transport teardown fence 隔离。
5. dispose RunController registries、EventHub、Runtime。
6. 最后关闭 Storage。

## 8. 公共事件与 Client 状态

### 8.1 新事件

1. `model.status`：ephemeral、`COALESCIBLE`、USER_VISIBLE，stream key 为 `model:status:<runId>:<stepId>`；payload 对应第 4.2 节，公开前做严格 schema parse。
2. `retry.exhausted`：durable，必须与失败真相同一事务提交。
3. `transport.fallback.selected`：durable，必须与 continuation/Run truth 同一事务提交。

所有新事件加入 Protocol static catalog、schema registry、public union 与 daemon public projector。不得建立第二条 event side channel。

### 8.2 Client read model

Client 新增独立状态：

```ts
interface ModelWaitStatus {
  phase:
    | "WAITING_PROVIDER"
    | "RECEIVING_PROVIDER_DATA"
    | "NO_RECENT_ACTIVITY"
    | "CANCELLING_IDLE_STREAM"
    | "WAITING_RETRY"
    | "RECONNECTING_TRANSPORT"
    | "FAILED";
  lastProviderActivityAt: number;
  idleForMs: number;
  idleTimeoutMs: number;
  retryOrdinal?: number; // 1..5
  maxRetries: 5;
}
```

浏览器 SSE 状态继续由现有 reconnect/session manager 权威管理，不塞进 `ModelWaitStatus`。UI 将两者分别标为“与本地服务的连接”和“模型服务状态”。

## 9. Web 体验

### 9.1 文案与加载动效

- `思考中` 和 `正在等待模型响应` 的文字本身使用轻量 shimmer/opacity pulse；不添加脉冲圆点。
- `正在重新连接 1/5`、`正在终止静默请求` 等恢复文字使用同一 text-loading class。
- `prefers-reduced-motion: reduce` 时关闭位移/闪烁动画，但保留静态文字与 aria live/status。

### 9.2 状态文案

- 初始：`思考中` / `正在等待模型响应`
- 30 秒无 Provider 事件：`模型近期没有返回新数据，仍在等待`；显示“上次活动 HH:mm:ss”与“已等待 00:30”
- 重试排队：`将在 1.8 秒后重新连接 1/5`
- 重试开始：`正在重新连接 1/5`
- fallback：`主传输暂时不可用，正在切换备用传输 2/5`
- 5 分钟静默：`Provider 连续 5 分钟没有返回数据，正在终止本次请求`
- 耗尽：`模型连接在 5 次重试后仍未恢复，本次任务已明确失败`
- 浏览器 SSE 断开：使用现有 reconnect banner，明确为“正在重新连接本地服务”，不得显示为 Provider 故障。

等待时长由客户端基于服务端 `lastActivityAt` 每秒本地刷新；不为了计时每秒发 SSE。切到后台/恢复后用当前时间重新计算，避免 timer drift。

### 9.3 安全过程说明

过程区可以展示：正在做什么、刚确认什么、下一步、正在等待的对象和恢复动作。只接受 durable commentary 或 provider-produced reasoning summary。不得展示原始 hidden chain-of-thought，也不得根据长时间无 token 编造“模型仍在思考”的事实；准确措辞是“正在等待模型响应”或“近期无新数据”。

## 10. 失败和竞争条件

- 用户取消与 idle timeout 同时发生：AbortScope first-cause-wins；用户取消不重试。
- delta 与 idle timer 同时触发：通过单线程 generation 检查决定唯一顺序；一旦 terminal/closed，晚到 delta 被丢弃。
- retry timer 与取消/重启同时触发：依赖 durable continuation compare-and-transition；只能有一个新 Step。
- 多个 Daemon 观察同一数据库不在当前支持范围；不得以本功能暗示分布式 lease。
- SSE 断开不取消 Run；重连从 durable high watermark replay，再接 live bridge。
- transient `model.status` 丢失可接受；durable retry/failure 与当前 Run 状态足以恢复真相。

## 11. 验收标准

1. fake adapter 的 `next()` 永不 resolve 时，30 秒产生 `NO_RECENT_ACTIVITY`，300 秒产生 `AI_TIMEOUT`，底层 signal 被 abort，Gateway 在最多 5 秒 teardown 后 settle。
2. 每个合法 event 都重置 idle timeout；总 timeout 仍独立生效。
3. 失败尝试的部分输出不进入 durable transcript，部分 tool call 不执行。
4. 默认总尝试恰好 6 次，重试展示恰好 `1/5...5/5`，第 6 次失败产生 `retry.exhausted` 和明确 Run terminal failure。
5. 本地延迟按指数退避并有可测试的 ±10% jitter；Provider `Retry-After` 支持秒数与 HTTP-date，且不加 jitter、不提前重试。
6. 超过 5 分钟的 Retry-After 不被缩短，Run 明确停止为政策原因。
7. 有等价备用 transport 时可在下一 durable attempt 使用；没有候选时保持原 transport；任何时候都不跨 provider/model。
8. `WAITING_RETRY` 在进程重启后自动恢复；受控重启把活动 model attempt 转成 checkpoint；硬崩溃未知 in-flight 默认 fail closed。
9. UI 同时正确区分本地 SSE 状态、Provider transport 状态和 Provider activity；静默不显示“连接不健康”。
10. 所有加载效果作用于文字本身，并遵守 reduced motion。
11. 架构检查确认无 adapter retry、无 UI-owned execution state、无第二 Event writer、无跨包私有导入。

## 12. 参考实现依据

- OpenAI Codex（参考提交 `b741e480e203f037ca726bc2a76d99a8e8668e66`）：默认流 idle timeout 300 秒、有限 stream retry、逐次读取超时、重试状态通知，以及 daemon snapshot/continuation 分离旧连接与新 continuation。
- DeepSeek harness（参考提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`）：默认 5 次重试、指数退避与 10% jitter、retry 状态持久化；timeout 实现明确要求底层 transport 观察 abort，避免只用 `Promise.race()` 造成泄漏。

这些实现用于校验机制，不复制其内部状态模型。Caelush 必须遵守自己的 durable Run、Event V2、Message V2 和 Tool side-effect 边界。
