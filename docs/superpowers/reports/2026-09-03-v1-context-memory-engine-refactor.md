# Caelush V1.00

# Context & Memory Engine Refactor

# Completion Report

## Delivery status

本轮已完成 Context & Memory Engine 的第一批可复用基础能力，并完成了代码级构建、类型检查、Lint、单元测试、Web smoke、release artifact 测试和差异检查。当前结论是：

> Implementation Foundation Complete; V1.00 release seals NOT COMPLETE.

这不是“任务 1–12 全部完成”的发布声明。任务文本要求的完整 Core/Daemon 驱动、UI/CLI inspector、P0 A–H 长运行集成场景、独立 `gpt-5.6-luna` 审核、远端 push 和 master 集成，在本轮没有全部落地，因此没有进行远端发布、master 合并或分支删除。

## Git and baseline evidence

- `BASE_SHA`: `1976ec06f4c06de56d28f92954e8dd789ba0b109`
- BASE_SHA 已从 `origin/master` 获取，并验证为当前 `master` 与 `origin/master` 的共同基线。
- 任务分支：`codex/v1-context-memory-engine-refactor`
- 当前本地 HEAD：`1976ec06f4c06de56d28f92954e8dd789ba0b109`
- Task final SHA：未提交；当前实现仍以工作区差异形式保留，便于审阅。
- Task remote SHA：N/A；本轮没有执行远端 push。
- `master` SHA：`1976ec06f4c06de56d28f92954e8dd789ba0b109`
- `origin/master` SHA：`1976ec06f4c06de56d28f92954e8dd789ba0b109`
- 没有创建 worktree；这是按任务文本中的显式约束执行的。
- 没有创建独立审查 subagent，因此不存在可填写的实际 `gpt-5.6-luna` 审核记录，也没有伪造审查封印。

计划和基线特征记录分别见 [实现计划](D:/Develop/Caelush/docs/superpowers/plans/2026-09-03-v1-context-memory-engine-refactor.md) 和 [基线特征报告](D:/Develop/Caelush/docs/superpowers/characterization/2026-09-03-context-runtime-baseline.md)。

## Root cause addressed

原有路径把 durable conversation history、当前未闭合 tool turn、project/file context 和 tool 的原始大输出共同送入 ContextBuilder。长运行任务中，历史不断增长；`exec_command`、`write_stdin`、search/read 等输出又可能达到约 1 MB。旧路径最终依赖固定输入预算，并在超限时直接产生 `ContextBudgetExceededError`，没有一个独立的、可观测的 bounded model-context 控制平面。

本轮首先收紧了 `prepareResumeHistory()`：已闭合的历史周期留在 durable history plane，当前 turn 只保留必要的 user + pending assistant/tool calls + normalized tool results。这消除了“每次 resume 都把整个开放 turn 复制进当前上下文”的结构性增长路径。

## Implemented architecture

当前新增能力按四个平面组织：

1. Durable Record Plane：现有 conversation/run/tool records 仍是事实来源；新增 memory repository 和 context/memory SQLite 表结构。
2. Context Control Plane：model profile、context policy、execution unit、安全 compaction candidate、checkpoint、rehydration 和 overflow recovery。
3. Model Projection Plane：`ModelObservation`、bounded context item、model context projection，以及将原始 tool output 与模型可见投影分离。
4. Observability Plane：`ContextBuildTrace` 只记录安全的计数、预算、pressure ratio、截断/丢弃数量和 compaction 次数，不暴露 prompt、tool arguments、raw output、credential 或 hidden reasoning。

这几个平面通过 `packages/context/src/index.ts` 的公共出口暴露，未引入跨 package 深层 import。

## Context profile and policy

新增 [model-context-profile.ts](D:/Develop/Caelush/packages/context/src/model-context-profile.ts) 和 [context-policy.ts](D:/Develop/Caelush/packages/context/src/context-policy.ts)：

- profile 具备 `contextWindowTokens`、`maxOutputTokens`、`safetyReserveTokens`、provider/model identity 和来源标记。
- 解析优先级是本地 configuration、known metadata、显式 override、deterministic fallback。
- 未知模型不会通过网络猜测；例如未知 DeepSeek profile 会明确落到本地 fallback，并携带 `FALLBACK` 来源。
- profile/policy 不再以一个全局固定 32K 假设为唯一预算来源；effective input budget 会扣除输出和 safety reserve。
- policy 提供 proactive 与 emergency 阈值、recent tail、minimum tail、observation budget 和 elastic pool，并对 unsafe/invalid limits 做校验。

ContextBuilder 保留旧调用兼容性，同时在收到 profile/policy 时使用真实 effective limits，并在 report 中附加 `ContextBuildTrace`。

## Execution units and model projection

新增 [execution-unit.ts](D:/Develop/Caelush/packages/context/src/execution-unit.ts)、[context-item.ts](D:/Develop/Caelush/packages/context/src/context-item.ts) 和 [model-context-projection.ts](D:/Develop/Caelush/packages/context/src/model-context-projection.ts)：

- assistant tool calls 与 matching tool results 被分组为一个 `ExecutionUnit`。
- `OPEN` unit 保留在当前执行边界中；只有 CLOSED unit 才能成为 compaction candidate。
- selection 保持 source order、source range 和必要的完整性校验。
- model projection 以 bounded goal、checkpoint、最近完整 execution units、可选 open protocol unit 和 memory ContextItems 组成模型输入。
- durable message count、dropped count、estimated token count 等信息在 projection 中保留为安全元数据。

这为后续将 compaction 从“按消息切割”升级为“按完整执行单元切割”提供了稳定边界；本轮尚未把它完全接入 RunController 的生产驱动循环。

## Tool observations and artifacts

新增 [observation-projector.ts](D:/Develop/Caelush/packages/context/src/observation-projector.ts)：

- raw output 通过 `ArtifactStore` 保存，模型只得到 bounded `ModelObservation`。
- read/list/find/search/git 类结果采用确定性的 prefix 截断。
- exec/write_stdin 类结果采用 head + omitted bytes + tail 的 bounded 视图。
- UTF-8 边界、hash、omitted bytes 和 artifact reference 被保留；模型投影不会复制完整 raw output。
- 这不是 secret redaction，也没有把 Phase 9 的敏感信息授权策略提前实现。

当前 artifact store 仍是注入端口和 in-memory 基础实现；migration 已加入 `context_artifacts` 表，但 raw observation 的完整生产写入路径尚未接入现有 Tool settlement。

## Checkpoint, compaction, rehydration, overflow

新增 [checkpoint.ts](D:/Develop/Caelush/packages/context/src/checkpoint.ts)、[compaction.ts](D:/Develop/Caelush/packages/context/src/compaction.ts)、[context-rehydrator.ts](D:/Develop/Caelush/packages/context/src/context-rehydrator.ts) 和 [context-overflow.ts](D:/Develop/Caelush/packages/context/src/context-overflow.ts)：

- versioned `StructuredCheckpoint` 覆盖 goal、constraints、completed/in-progress/blocked work、discoveries、decisions、changed/read files、errors、verification state、processes、approvals、resource governance、critical references、next intent 和 source range。
- checkpoint 有 bounded validation，并提供 deterministic minimal fallback。
- compaction 只选择 CLOSED execution units；存在 OPEN unit 时不会将其切碎。
- compaction 会按 policy 计算 proactive/emergency pressure，执行一次 compactor retry，并在 compactor 失败时退到最小 checkpoint。
- rehydration 遵循 authority snapshot 优先、checkpoint fallback 的规则；Run/AgentState/active processes/pending approvals 等运行时权威不会被旧 checkpoint 无条件覆盖。
- provider context overflow 只允许一次 compact/rehydrate/retry；再次 overflow 映射为新的 `CONTEXT_EXHAUSTED`，没有无限 retry。
- `@caelush/llm` 新增 provider-independent 的 `LLMContextOverflowError`；`@caelush/protocol` 和 Core mapper 提供 sanitized `CONTEXT_EXHAUSTED` 错误。

需要特别说明：compaction/rehydration 当前仍是 context package 的可测试服务和端口，尚未由 RunController/Daemon 统一编排，也没有新增独立的 checkpoint/compaction durable repository API。

## WorldState and trace

新增 [world-state.ts](D:/Develop/Caelush/packages/context/src/world-state.ts)：

- 支持 bounded `WorldStateProjection`、delta、diff 和 apply。
- generated tree（如 `.git`、`node_modules`、`dist`、`build`、`coverage` 等）默认被排除在普通 workspace projection 外。
- 不把整棵 workspace 复制进 prompt；只提供结构化、增量式的投影基础。

新增 [context-build-trace.ts](D:/Develop/Caelush/packages/context/src/context-build-trace.ts)：

- trace 记录模型/预算身份、各区段估算 token、dropped/truncated、pressure、compaction count 和 item counts。
- 测试覆盖了输入带有敏感字段时输出不泄漏的情况。
- 当前没有实现任务文本要求的 CLI `/context` 命令、Web developer inspector 或完整 request-to-inspector UI 链路；因此 Inspector 只能算 safe trace API foundation。

## Memory

新增独立 `@caelush/memory` package：

- 支持 PROJECT/GLOBAL scope、ACTIVE/STALE/SUPERSEDED/INVALID/EXPIRED status 和 PUBLIC/INTERNAL/SENSITIVE sensitivity。
- candidate 必须有 evidence references；PROJECT memory 必须绑定 project；confidence 有界；检测到 API key/secret/token/password/credential/authorization/bearer 等敏感模式时拒绝写入。
- record 带 schema version、source run IDs、created/updated timestamps、supersedes 和 evidence refs。
- retriever 使用确定性的 scope/project/active filter、关键词相关性和 tie-breaker 排序。
- SQLite migration `20260903150000_context_memory` 新增 `context_checkpoints`、`context_artifacts`、`memory_records` 及索引。
- [memory-repository.ts](D:/Develop/Caelush/packages/storage/src/memory-repository.ts) 提供 Storage 对 memory store 的持久化实现，并以 reopen 测试验证数据可恢复。

尚未实现的部分包括：从 completed run/verification evidence 异步提取 memory candidate、人工确认队列、完整 supersession/forget UI，以及把 memory retrieval 完整接入生产 ContextBuilder/Daemon 请求链。

## Verification evidence

已执行并得到成功结果的检查包括：

- `pnpm test`：`360` 个 test files passed；`1386` tests passed，`5` skipped，共 `1391`。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过；包含 build、root TypeScript 检查和 workspace recursive typecheck。
- `pnpm build`：通过。
- `pnpm test:web:e2e`：通过。
- `pnpm build:release`：通过，并包含新增 package/migration 的 release staging。
- `pnpm test:release`：通过，输出 `artifact-e2e passed: 0.1.0`。
- `git diff --check`：通过；仅有 Windows 换行转换提示。
- 本轮新增/修改的可格式化 TypeScript、JSON、Markdown、YAML 文件已逐文件通过 Prettier 检查/写回。

完整 `pnpm check` 已执行到仓库级 `prettier --check .`；其 lint、typecheck、test、build 阶段通过，但最终受到仓库既有的大量全局格式债务影响而失败。该命令报告约 814 个 repo-wide formatting issues，包含大量本轮未改动的 baseline 文件；本轮没有运行 `pnpm format`，也没有借格式化全仓来覆盖用户已有文件。

Windows 测试期间曾输出 `node-pty` 的 `AttachConsole failed` 栈信息，但测试进程最终通过，且没有把该环境提示误判为测试失败。

## Remaining release blockers

要满足任务文本定义的 V1.00 完整发布封印，仍需继续完成以下范围内工作：

- 把 checkpoint、compaction、rehydration、overflow recovery 接入 Core/RunController/Daemon 的真实生命周期和 durable event atomic commit。
- 接入 artifact persistence 与现有 Tool settlement，确保 raw Tool result 与 ModelObservation 在生产路径中真正分离。
- 完成 P0 A–H 长运行/恢复/overflow/uncertain side-effect/approval-boundary 等集成场景，而不只验证 context package 的孤立服务。
- 完成 CLI `/context` 与 Web developer inspector，并验证不泄漏 prompt、原始输出、参数或 secrets。
- 完成 memory candidate 的异步抽取、证据绑定、review/forget/supersession 生产链路。
- 由独立的 `gpt-5.6-luna` reviewer 按任务规定执行代码、架构、契约、安全和回归审核，并记录真实结果。
- 在所有发布门禁通过后再提交任务 commit、push remote、核对 remote SHA，最后 fast-forward 合并 master 并删除任务分支。

因此本报告只确认当前基础实现和验证结果，不授予“V1.00 已完成”或“可远端发布”的结论。
