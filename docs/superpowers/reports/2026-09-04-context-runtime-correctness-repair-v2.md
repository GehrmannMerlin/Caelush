# Caelush V1.00 Context Runtime Correctness Repair V2

## 交付结论

当前分支已达到 `READY FOR USER MANUAL CONTEXT ACCEPTANCE`：生产 Context Runtime 的关键正确性缺口已修复，独立只读审查结论为 `VERDICT=PASS`，P0/P1 均为零。

本轮没有合并、切换或修改 `master`，没有创建 worktree，也没有声称已经完成真实 DeepSeek 长任务、50+ Tool soak、100+ Tool coding task 或小时级运行。这些仍属于用户手工验收范围。

## Git seal

- 基线 SHA：`c5489f75a243193c9832a9f15875d9e41d8b6810`
- 工作分支：`codex/v1-context-runtime-correctness-repair-v2`
- 基线时 `master`：`c5489f75a243193c9832a9f15875d9e41d8b6810`
- 基线时 `origin/master`：`c5489f75a243193c9832a9f15875d9e41d8b6810`
- 分支策略：只提交并推送当前 task branch；不向 `master` 合并
- 最终 commit / remote SHA：在提交并推送后由交付命令写入最终回复，并以 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/codex/v1-context-runtime-correctness-repair-v2` 复核一致
- 工作树要求：交付前必须由 `git status --short` 确认 clean

## 根因矩阵 A–I

| 候选项                        | 修复结论 | 实际处理                                                                                                                                                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Model profile wiring       | `FIXED`  | 明确配置 profile → known profile → explicit override → legacy limits → fallback 的 precedence；daemon 将配置 profile 注入 coordinator，保留 profile source 与 raw window。                             |
| B. Safety reserve twice       | `FIXED`  | `rawContextWindowTokens - outputReserveTokens - safetyReserveTokens = effectiveInputLimitTokens`；policy path 将 effective limit 传给 Builder 并把 Builder legacy safety margin 设为 0，避免二次扣除。 |
| C. Observation hardcode       | `FIXED`  | single/batch observation budget 随 effective input limit 计算；`read_file`、`exec_command`、`write_stdin` 使用 head + marker + tail；模型只看到 bounded projection。                                   |
| D. Fake/shallow compaction    | `FIXED`  | 只压缩 CLOSED 且结果完整的 ExecutionUnit；不再用旧的“清空普通历史”回退；open turn 保留并单独收紧。                                                                                                     |
| E. Proactive threshold        | `FIXED`  | pressure state machine 增加 post-compaction target hysteresis，并在每次 rebuild 后重新观察；普通 pressure 在 Context Runtime 内消费。                                                                  |
| F. Foundation wiring          | `FIXED`  | coordinator 使用真实 Builder report、authority snapshot、typed source range 和 durable conversation sequence；checkpoint authority 不覆盖更新鲜状态。                                                  |
| G. Provider overflow          | `FIXED`  | provider overflow 只触发一次 force recovery；USER_TURN 有 CLOSED 单元时先 compact，无安全材料时 fail closed；TOOL_CONTINUATION 从 raw artifact 重新投影；第二次请求重新构建且不重派 Tool。             |
| H. Checkpoint token telemetry | `FIXED`  | `tokensBefore` 使用真实 full-input estimate；`tokensAfter` 使用最终 rebuild 的 Builder report，并在 compaction checkpoint 上回写；duplicate source range 刷新 authority。                              |
| I. Restart usage hardcode     | `FIXED`  | context runtime telemetry 持久化 raw/effective identity、build/recovery 信息和 numeric breakdown；旧数据 decode 严格 fail closed，异常统一为 `StorageDecodeError`。                                    |

## 关键实现

### Profile 与 arithmetic

Context Runtime 现在是唯一生产 context authority。profile resolution 不查询网络，使用确定性来源优先级；policy 不再把 `maxInputTokens`、output reserve、safety reserve 拆成互相重叠的预算。

有效输入预算为：

```text
raw context window
  - output reserve
  - safety reserve
  = effective input limit
```

所有动态 observation、recent tail、memory、relevant-file 和 conversation cap 都从这一 authority 派生。legacy direct Builder 仍保留兼容语义，但生产 daemon 使用 coordinator policy。

### Observation 与 open turn

Tool Dispatcher 在验证 handler 原始结果后，将完整的 Tool 输出持久化到 `context_artifacts`，Observation、continuation 和 model-facing Tool Result 只携带 bounded content 与 opaque `rawArtifactRef`。provider adapter 不会把 artifact ref 当作模型输入字段。

恢复 projection 通过带 `runId` 的 loader 加载 raw artifact，并校验 artifact 归属当前 Run；有 ref 但 artifact 不可读时 fail closed，不会对旧的 bounded projection 重复截断。没有 ref 的历史数据才使用已有 content。

### ExecutionUnit、compaction 与 checkpoint

ExecutionUnit 只以 CLOSED 且 Tool Call/Result 完整为 compaction candidate。open protocol unit、当前用户 turn 和未闭合 Tool turn 不会被历史 cut 删除。生产 RunController 将 durable message sequence 与 history 一起传入，checkpoint 的 `sourceRange.kind` 区分 `DURABLE_MESSAGE_SEQUENCE` 与 `LOCAL_HISTORY_INDEX`。

compaction 先用真实 Builder estimate full input，选择安全的旧 CLOSED units，传给 compactor 的 source range 与实际候选范围一致；然后 provisional build、rehydrate、最终 build，checkpoint 的 before/after 值对应真实构建测量。相同 source range 的 checkpoint dedupe 会刷新 authority，而不是返回过时记录。

### Pressure 与 overflow

pressure 状态包括 `NORMAL`、`PROACTIVE`、`EMERGENCY`、`RECOVERING_OVERFLOW` 和 `EXHAUSTED`。post-compaction target 是独立 hysteresis threshold；状态不会在刚降到 proactive 以下时过早回到 normal。

provider overflow 只允许一次恢复尝试。普通 USER_TURN 在存在 closed history 时可以 compact；只有没有任何安全压缩材料时才转为 `CONTEXT_EXHAUSTED`。TOOL_CONTINUATION 在 recovery 中从 durable raw artifact 重新生成 emergency projection。recovery 不执行 Tool、不重复 Tool invocation、不将 raw provider payload 或 hidden reasoning 写入公共 contract。

### Durable telemetry 与 Web

`context_runtime_states` 通过 committed migration 扩展，保存 provider/model/profile source、raw/effective limits、estimated input、remaining、pressure、compaction count、last build time/status、recovery stages 与 numeric breakdown。Storage decoder 对 JSON、枚举、safe integer、bounded list 和 checkpoint structured data 做严格校验。

Web inspector/ring 使用持久化 authority 展示 raw window、effective input、estimated usage、remaining、pressure、compaction 与 breakdown；未运行时保持 neutral，不制造 `32_000` 或零值假状态。

## Production integration evidence

新增的 `apps/daemon/test/context-runtime-recovery-production-e2e.test.ts` 覆盖同一真实生产装配链路：

```text
startDaemon
  -> RunController
  -> AgentLoop
  -> ContextRuntimeCoordinator
  -> real LLMGateway/provider fixture
  -> real built-in read_file
  -> ToolDispatcher
  -> SQLite context_artifacts
  -> bounded observation + rawArtifactRef
  -> provider overflow
  -> SQLite-backed raw loader with run ownership check
  -> emergency reprojection
  -> changed second provider request
  -> verification and COMPLETED
```

该测试同时验证：

- 第一个 model turn 请求 `read_file`；
- 真实 Dispatcher 写入 durable artifact；
- 第二个 provider turn 抛出 `LLMContextOverflowError`；
- recovery 后第三个 request 的 Tool content 与原请求不同，且仍保留相同 `rawArtifactRef`；
- usage telemetry 记录 `REPROJECT_OPEN_OBSERVATIONS_EMERGENCY`；
- daemon 关闭后重新打开 SQLite，artifact 仍存在、带正确 `runId`，源 fixture 大于 1 MB，持久化 Tool artifact 大于 10 KB 且仍是 bounded Tool output。

真实进程重启后从 durable boundary 继续执行的完整组合仍未在本轮自动化测试中覆盖，独立审查将其列为 P2 测试缺口，不是已证实的运行时 correctness defect。真实 DeepSeek 与用户真实生产 Web 操作仍需手工验收。

## Characterization 与测试

基线 characterization 文件：`docs/superpowers/characterization/2026-09-04-context-runtime-correctness-v2-baseline.md`。它记录了基线 commit、真实调用图、候选 A–I、初始 RED 证据和禁止伪造的生产声明。

本轮最后已执行或确认：

- `pnpm test`：`375` 个 Test Files passed；`1424` tests passed；`5` skipped。
- `pnpm lint`：passed。
- `pnpm typecheck`：build 与 workspace typecheck passed。
- `pnpm test:web:e2e`：passed。
- `pnpm build:release`：passed，生成 release deploy artifact。
- `pnpm test:release`：`artifact-e2e passed: 0.1.0`。
- `pnpm vitest run packages/core/test/context-runtime-production-integration.test.ts`：2 tests passed。
- `pnpm vitest run apps/daemon/test/context-runtime-recovery-production-e2e.test.ts`：1 test passed。
- `pnpm vitest run packages/context/test/compaction.test.ts`：5 tests passed。
- `git diff --check`：交付前必须为零错误。
- changed-file Prettier：交付前对所有 changed/new 文件单独运行并必须通过。

`pnpm format:check` 的全仓库结果为失败：Prettier 报告 `825` 个既有文件存在格式差异。该格式债务横跨未修改的 apps/packages/docs/scripts 文件；本轮没有为了通过全仓库格式检查而重排无关用户文件。changed/new 文件单独 Prettier 检查通过，最终报告会保留该失败的真实状态。

## Independent review seal

- Agent ID：`01a06b51-5fb8-7390-847e-f129023d515c`
- Model：`gpt-5.6-luna`
- Role：只读独立审查员
- Task：基于当前 task branch、用户规范、AGENTS.md、设计/计划/characterization 与当前 diff，审查 A–W context runtime correctness、生产装配、durable telemetry、overflow recovery 和 phase boundary
- Worktree：未创建
- Writes：未执行；审查员没有修改、提交、切换分支或恢复文件
- Final verdict：`VERDICT=PASS`
- Final P0：无
- Final P1：无
- Remaining P2：完整 A–P production matrix 仍不完整；真实 daemon 进程重启后的 Context Runtime recovery 尚未自动化覆盖
- Review focused evidence：8 个相关测试文件、30 个测试通过；新增 production recovery E2E 另有 1 个测试通过
- Subagents：仅 1 个 Luna 独立审查线程；没有启动 Sol subagent

## Screenshot / visual evidence

本任务是 context/runtime correctness 与 daemon/storage integration，不是视觉布局任务。`pnpm test:web:e2e` 的 browser smoke 以命令行断言通过，但没有生成需要交付的截图 artifact；因此本报告不伪造 screenshot 证据，也不把“无截图”解释成 UI 失败。

## Manual acceptance handoff

建议用户在真实 Production Web 与 DeepSeek 配置上至少执行：

1. 小模型/小 context profile 的普通对话、五个 Tool 结果和长 `read_file`/`exec_command` 输出，确认 UI ring 使用 effective input 而不是固定 32K。
2. 产生 open-turn pressure 与 provider context overflow，确认第二次请求内容缩短但 Tool identity、结果顺序和 run state 不丢失。
3. 在有 closed history、混合 open/closed history、无可压缩 history 三种情况下分别验证 compaction、emergency reprojection 与 `CONTEXT_EXHAUSTED` fail-closed。
4. 关闭并重新启动 daemon，确认 durable context usage、checkpoint、Tool artifact 和 run recovery 不产生重复 Tool side effect。
5. 验证 approval、cancellation、verification、resource governance 与现有 Phase 8/10/11 约束没有被 context recovery 绕过。

手工验收完成前，不应把真实 DeepSeek 或长时运行标记为本轮自动化已验证。
