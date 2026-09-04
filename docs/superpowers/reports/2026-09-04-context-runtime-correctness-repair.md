# Caelush V1.00 — Context Runtime Correctness Repair Report

日期：2026-09-04
任务分支：`codex/v1-context-runtime-correctness-repair`
基线：`3be40eaf6d012216b30b29cfc38b43b8be5d7762`
状态：`READY FOR USER MANUAL CONTEXT ACCEPTANCE`

## 1. 范围与边界

本轮只修复 Context Runtime Correctness 任务中批准的生产接线问题：模型上下文 profile 权威来源、预算算术、Tool Observation 投影、压缩与压力治理、Provider context overflow 恢复、durable checkpoint/usage telemetry，以及真实 daemon、SQLite、AgentLoop 和 release artifact 的接入验证。

本轮没有合并到 `master`，没有推送 `master`，没有引入新的 Phase 8/10/11 轮次，也没有声称 Context Engine 已完成长期 soak、全量生产流量证明或 release seal。

## 2. Git 基线与工作树纪律

开始前已执行任务要求的基线检查：

- `git status --short`：clean。
- `git branch --show-current`：基线检查时为 `master`。
- `git fetch origin --prune`：完成。
- `git rev-parse master`：`3be40eaf6d012216b30b29cfc38b43b8be5d7762`。
- `git rev-parse origin/master`：`3be40eaf6d012216b30b29cfc38b43b8be5d7762`。
- `git rev-parse HEAD`：`3be40eaf6d012216b30b29cfc38b43b8be5d7762`。

随后创建并一直在任务分支上工作：

`codex/v1-context-runtime-correctness-repair`

本轮未使用 worktree，未执行 `reset --hard`、`clean -fd`、强制 checkout、删除分支或 force push。

## 3. 生产路径与根因结论

真实调用链已记录在 [baseline characterization](../characterization/2026-09-04-context-runtime-correctness-baseline.md)：

```text
Web/CLI prompt
  -> daemon RunExecutionSupervisor
  -> RunController
  -> AgentLoop.prepareTurn()
  -> ContextRuntimeCoordinator.prepareModelContext()
  -> ContextBuilder.build()
  -> ContextBudget / model profile
  -> LLMGateway / provider

LLM tool decision
  -> RunController
  -> ToolBatchCoordinator / Dispatcher
  -> raw Tool result
  -> bounded Observation projector
  -> AgentLoop.resumeWithToolResults()
  -> next ContextRuntimeCoordinator preparation
```

已确认的根因：

| 编号 | 根因                                                                              | 结论                                        |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| A    | daemon production composition 没有把 provider model profile 注入 Context Runtime  | 已修复                                      |
| B    | `ContextPolicy.effectiveInputLimit` 已扣 safety margin，ContextBuilder 又扣了一次 | 已修复为只扣一次                            |
| C    | Core 使用固定单结果 8192 token 上限，没有 batch/open-turn 预算策略                | 已修复为 policy 驱动的单结果与 batch 上限   |
| D    | compaction 清空 history，且没有基于 closed ExecutionUnit 保留可恢复工作上下文     | 已修复                                      |
| E    | proactive pressure threshold 没有接入 prepare path                                | 已修复                                      |
| F    | ExecutionUnit、PressureController、Rehydrator 没有进入 daemon/AgentLoop 生产链    | 已接入 coordinator                          |
| G    | Provider context overflow recovery helper 没有连接到 AgentLoop provider turn      | 已接入并限制一次重建重试                    |
| H    | checkpoint 的 token 前后字段是 placeholder，无法支撑 usage/恢复诊断               | 已修复并持久化真实估算值                    |
| I    | daemon restart 恢复路径硬编码 32K，而不是恢复同一 profile/limit authority         | 已移除硬编码，使用 profile/legacy authority |

截图中的“扫描一下当前工作区”失败属于这条链的可见结果：此前 daemon 没有可用的默认模型配置时，旧运行时进入错误的 profile/预算路径；同时大 Tool/当前开放 turn 会放大预算压力，最终可能在 provider 前得到 `BUDGET_EXCEEDED (RUNTIME)`。本轮修复了默认 profile authority、动态 Observation 投影、closed-unit compaction、压力门控、overflow recovery 和 durable usage，但截图本身没有被当作唯一证据，最终结论以自动化测试和 release artifact E2E 为准。

## 4. Profile 与预算修复

已新增显式模型 profile 接入：

- `CAELUSH_PROVIDER_MODEL_PROFILES` 使用严格 JSON/schema 解析；非法 JSON、非法数字和非法 profile 在 daemon 启动时失败，不静默回退。
- profile precedence 为配置 profile、known metadata、legacy limits、override、最后才是明确标记的 fallback。
- 没有完整 model metadata 但存在既有 `maxInputTokens` 时，使用 `LEGACY_LIMITS` profile；不会把旧的 input limit 静默解释成 16K context window。
- 兼容 legacy limits 时，`contextWindowTokens = maxInputTokens + outputReserveTokens + safetyReserveTokens`，其中 safety reserve 可显式为 0。
- `ModelContextProfileSource`、Protocol usage API 和 Web Context Inspector 都能显示 profile source。

预算不变量：

```text
effectiveInputLimit = contextWindowTokens
                      - outputReserveTokens
                      - safetyReserveTokens
```

Policy 已计算过 safety 后，ContextBuilder 将构建输入的 safety margin 设为 0，避免重复扣除。safe-integer、正值、非负 reserve 和溢出边界均在 profile/policy 路径校验。

## 5. Observation、开放 turn 与 compaction

- Tool Observation 不再由 Core 硬编码单个 8192 token cap；单结果上限和 batch 上限均来自 Context Policy。
- batch projector 按 assistant source order 做确定性 weighted allocation；保留每个 tool result 的最小可见内容，拒绝无法为 batch 中每项保留结果的非法 cap。
- Observation `content` 仍是 model-facing bounded text；内部 invocation ID、observation ID、structured details、原始参数和凭据不会进入 LLM tool-result message。
- Context Runtime 会区分 closed ExecutionUnit 与当前 open unit；压缩只选择可压缩的 closed units，当前开放 user/tool turn 会保留并按压力等级重新投影。
- checkpoint 先持久化，再通过现有 Rehydrator 重建 history/context；压缩后保留未选中的历史与新 checkpoint 语义，不再无条件将 history 置空。
- 正常路径会在 proactive pressure threshold 触发压缩；预算超限路径按 TIGHT、compaction、EMERGENCY/MINIMAL 顺序收缩，最终仍无法容纳时抛出 `ContextExhaustedError`。

## 6. Provider overflow、恢复与 durable telemetry

- OpenAI-compatible structured `context_length_exceeded` / `LLM_CONTEXT_OVERFLOW` 被规范化为 `LLMContextOverflowError`；普通 400 不会被泛化误判为 overflow。
- AgentLoop 捕获一次 provider context overflow 后，重新执行 Context Runtime prepare，使用新的 bounded request 重试一次；不会复用旧 request，也不会自动无限重试。
- 第二次 overflow 转为 sanitized `ContextExhaustedError`，不泄露 prompt、工具参数、SSE 原文或 credentials。
- SQLite 增加 committed `context_runtime_states` migration/repository，保存 provider/model、profile source、raw/effective limit、estimate/remaining、pressure、compaction count、build status 和 bounded breakdown。
- checkpoint 通过 `updateTokensAfter()` 写回真实的 `tokensAfter`；usage projection 不再把过大的估算值静默截断为有效值，便于 Inspector 发现 estimate 超过 effective limit。
- daemon context usage endpoint 在内存 miss 时读取 durable `contextRuntimeStates`，重启后仍能恢复诊断视图。

## 7. 测试与证据

TDD 顺序已执行：先加入真实生产路径 characterization 并观察预算算术 RED，再实现最小修复，之后执行 focused、integration、full 和 release 回归。

通过的验证：

- focused Context/Core/Storage suite：4 个文件，13 个测试通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过，所有 workspace typecheck 通过。
- `pnpm build`：通过，所有 workspace build 通过。
- `pnpm test`：370 个测试文件通过；1404 个测试通过，5 个跳过，共 1409 个测试。
- `pnpm test:web:e2e`：通过。
- `pnpm build:release`：通过，release artifact 构建和依赖/lockfile 校验通过。
- `pnpm test:release`：通过，输出 `artifact-e2e passed: 0.1.0`。
- `git diff --check`：通过。
- changed-file Prettier check：通过，所有本轮修改/新增的可格式化文件均符合 Prettier。

`pnpm check` 的 lint、typecheck、build、test 阶段通过；全仓 `format:check` 因仓库既有 834 个历史文件不符合当前 Prettier 规则而退出失败，未执行全仓格式化。这属于 `BASELINE FORMAT DEBT`，不属于本轮 changed-file 格式错误。

release 回归第一次运行时复用了机器上已有的 `D:\Develop\Caelush\apps\daemon\dist\main.js`，该开发 daemon 占用 `127.0.0.1:43120`，导致 fake provider 零请求并返回旧 daemon 的 `FAILED`。在确认进程和端口归属后停止该 Caelush 开发 daemon，再次以隔离 release artifact 运行，`pnpm test:release` 通过；本轮未修改 artifact harness 来掩盖该环境问题。

## 8. 独立 reviewer 结果

已创建只读独立 reviewer task，并指定 `gpt-5.6-luna`。两次服务调用均返回服务端 403，没有得到可引用的 assistant review verdict；因此不伪造 PASS，也没有据此修改代码。

| Agent ID                               | Model          | Role                                 | Task                                                                                                                    | Verdict                                         |
| -------------------------------------- | -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `01a06aa2-69da-7d12-85ca-0933358e371e` | `gpt-5.6-luna` | Independent Context Runtime Reviewer | Read-only review of profile, budget, observation, compaction, pressure, overflow, telemetry, tests and release boundary | `NOT REVIEWED` — two service-level 403 failures |

`New gpt-5.6-sol Sub-Agent Count = 0`。

## 9. 人工验收边界

自动化检查已经覆盖本轮实现的 deterministic contract、真实 AgentLoop provider overflow recovery、SQLite migration/repository、daemon composition、Web E2E 和 release artifact smoke，但仍需要用户进行人工验收：

1. 使用实际 provider 配置启动 daemon，确认 `caelush doctor` 显示预期 default provider/model。
2. 在 Web 中重新执行“扫描当前工作区”，确认不再出现“当前 daemon 未配置默认模型”或预算失败。
3. 在 Context Inspector 中确认 profile source、effective limit、remaining、pressure、compaction 和 build status 随任务变化。
4. 如需长期生产结论，还应另行执行长时间、多轮、大 Tool 输出、真实 provider 限制和 daemon 重启 soak；本轮没有把这些未执行项目宣称为完成。

因此，本轮最终状态严格为：

`READY FOR USER MANUAL CONTEXT ACCEPTANCE`

不是 `CONTEXT ENGINE FULLY PROVEN`，也不是长期生产稳定性或 release seal 的声明。
