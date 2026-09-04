# Caelush V1.00

# Context & Memory Engine

# Production Integration Pre-Acceptance Report

日期：2026-09-04  
工作分支：`codex/v1-context-memory-engine-refactor`  
预期基线：`1976ec06f4c06de56d28f92954e8dd789ba0b109`  
Foundation checkpoint：`96adebcc467ff378c9adc965a8187b40ba790e04` (`feat(context): establish context and memory foundations`)

## 1. 结论

本轮按固定 Task 1–8 边界完成了 Context/Memory 生产接线、Context Usage API 与 Web Ring、受控 Memory extraction job、Tool observation model projection、release 验证以及本报告。没有引入 Task 8-1、Task 9、MCP、RAG、Phase 14 或真实长任务 soak。

最终状态：**READY FOR MANUAL LONG-TASK ACCEPTANCE**

该状态表示自动化生产集成门槛已准备好交给人工长任务验收；不表示本轮已经执行或通过真实 50+/100+ Tool、长 DeepSeek 或数小时长任务验收。下一轮人工验收应从 `codex/v1-context-memory-refactor` 开始，使用仓库已经存在的 launcher/daemon 命令，不得另造启动方式。

## 2. 任务结果矩阵

| 范围                 | 状态                              | 证据与边界                                                                                                                                                                                                        |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AgentLoop            | PASS                              | 增加注入式 `ContextRuntimeCoordinatorPort` seam；生产 AgentLoop 优先走 Context Runtime，旧 `ContextBuilder` 仅保留兼容适配；Core 未引入具体 Tool/Provider。                                                       |
| RunController        | PARTIAL / 接线完成                | Context Runtime 从生产 composition root 注入；Verified completion 增加 durable memory extraction job enqueue hook。未把 Context Usage 作为新的 durable Run projection，也未扩展完成状态机。                       |
| Daemon               | PASS（生产 composition）          | 唯一 daemon composition root 创建 Context Runtime、checkpoint repository、project-scoped memory loader、Context Usage projection route 与 extraction job enqueue。                                                |
| Durable Checkpoint   | PASS（受控范围）                  | SQLite repository、migration、latest/reopen 测试通过；压力触发 checkpoint 持久化后重建上下文。当前 compaction 实现为 bounded deterministic checkpoint，不扩展既有历史状态模型。                                   |
| Artifact             | PASS                              | 原始 ToolObservation 仍在 durable Storage；model-facing projection 有 bounded head/tail 与 `rawArtifactRef` 语义，metadata/content 读取边界分离，safe projection 受 UTF-8 byte bound 约束。                       |
| Memory               | PARTIAL / production closure seam | 项目 scope 检索、token bound、Memory extraction job schema/repository/worker、verified completion enqueue 均已接通；本轮没有启动真实 Memory LLM extractor 或 100 条并发 extraction。                              |
| Client/API           | PASS                              | Protocol safe `ContextUsageProjection`、daemon `GET /api/v1/runs/:runId/context-usage`、client `getRunContextUsage()`；响应不携带 prompt、raw memory、secret、provider SDK 类型。                                 |
| CLI                  | PASS                              | 精确 `/context` 命令走 safe usage projection，不创建 Run；显示 model/capacity/remaining/pressure/compactions，数据不可用时明确提示。                                                                              |
| Web                  | PASS（自动化）                    | Ring 位于 composer footer、发送/取消控件之前；使用真实 projection、used ratio、accessible button/tooltip/Escape/reduced-motion；组件测试与 browser-safe production build 通过。实际人工浏览器视觉验收仍待下一轮。 |
| Independent reviewer | DEFERRED                          | 本轮没有启动独立 Luna reviewer，因此没有伪造 reviewer verdict。人工长任务验收前仍需独立复核。                                                                                                                     |

## 3. Production runtime flow

当前生产路径为：

`daemon composition root → ContextRuntimeCoordinator → checkpoint repository + project memory loader → ContextBuilder → AgentLoop → LLMGateway`

Context Runtime 在 provider turn 前加载同一 Run 的 latest checkpoint 与 project-scoped Memory，并在 context pressure 或 `ContextBudgetExceededError` 下执行受控 compaction：先持久化 checkpoint，再以 checkpoint boundary 重建 model context。AbortSignal 只存在运行时调用边界，不进入 Protocol entity、checkpoint payload、memory record、Tool args 或 public event。

Project ID 的当前保守映射是 `AgentRun.workspace.id`，因为现有 `AgentRun` contract 没有单独的 project ID。该选择已限制在 daemon loader 内并在后续真实 project identity contract 出现时可替换；没有把 workspace path 或 provider credential 写入 Memory。

Tool result 在进入下一 provider turn 前经 `projectToolObservation()` 做 model-facing projection。raw output 留在 durable observation/artifact boundary，不进入 LLM history；projection 只提供 bounded summary、error state 与安全引用，避免把 stdout/stderr、raw args、credentials 或异常文本泄漏给模型。

## 4. Checkpoint / Artifact / Memory / Approval 证据

### Checkpoint

- 增加 `context_checkpoints` SQLite adapter 与 committed migration。
- checkpoint 以 Run/source range 幂等，支持 latest/get/list，reopen 后仍可恢复。
- pressure test 覆盖：首次 build 产生高 pressure → persist checkpoint → history boundary rebuild。
- 未实现新的状态机、event-sourcing projection、retry、timeout、cancellation 或 Verification executor。

### Artifact

- raw observation 仍通过既有 Tool durable settlement 保存。
- model projection 有固定 token/byte 上界，并保留 head/tail 信息；大输出测试覆盖 marker 与 tail identity。
- metadata API 不返回 raw content；internal read 与 safe projection 是不同边界。

### Memory

- MemoryRetriever 仅检索 project scope，过滤 SENSITIVE，并按 max items/max tokens 做确定性裁剪。
- `memory_extraction_jobs` migration 使用 `source_run_id` 唯一约束，job claim/complete/fail 为显式状态迁移。
- `MemoryExtractionWorker` 单次、串行、注入 extractor；无证据或 secret candidate 不落库。
- Verified completion 仅 enqueue job，不在 RunController 内执行 Memory LLM，不阻塞 Run settle。

### Approval

Approval 仍沿用既有 Phase 9/Phase 7C 边界；本轮没有实现 approval resolution endpoint、权限策略重构或以 Context Usage 绕过 Gate 的路径。

## 5. Context Usage Ring evidence

- Protocol projection 字段包括 `contextWindowTokens`、`effectiveInputLimitTokens`、`estimatedInputTokens`、`usedRatio`、`remainingTokens`、pressure state、compaction count、safe breakdown 与更新时间。
- Ring 表示 used ratio：`dashoffset = 1 - usedRatio`；不会把 remaining ratio 当作使用率。
- 视觉实现是 restrained pale-blue hollow SVG circle：约 28×30 hit area、14×14 SVG、约 2px stroke；track 使用 `#EEF4FE`，progress 使用浅色蓝/绿色状态色。
- Ring 位于 composer footer 的 hint/send controls 前；无 fake timer、fake random 或本地递增 metric state。
- Button 带 accessible label/title，支持 keyboard/Escape，pressure inspector 不显示 raw prompt/memory，`prefers-reduced-motion` 下关闭动画。
- 新增 `context-usage-ring.test.tsx` 覆盖 aria 百分比、viewBox、dashoffset、inspector safe fields；Web production bundle 的 Node-only marker 检查通过。

## 6. Verification commands and results

通过：

- `pnpm.cmd check`：lockfile、ESLint、全部 workspace build、全部 typecheck、Vitest 均通过；Vitest 为 **370 files passed, 1400 tests passed, 5 skipped**。
- 本轮修改文件的 Prettier check：通过。
- `tsc --noEmit -p tsconfig.json`：通过。
- `tsc --noEmit -p apps/web/tsconfig.json`：通过。
- Web Vite production build：通过，190 modules transformed。
- `pnpm.cmd build:release`：通过，生成 `release-artifacts/caelush-v0.1.0-windows-x64.tgz`。
- `pnpm.cmd test:release`：通过，输出 `artifact-e2e passed: 0.1.0`。
- `node scripts/web-session-browser-smoke.mjs`：退出码 0。
- 新增/相关 focused tests：10 files、27 tests passed。
- package boundary test：通过；Storage 不依赖 Context feature package。
- `git diff --check`：无 whitespace error；仅报告 Windows CRLF 转换提示。

`pnpm check` 的最终退出码仍为 1，唯一失败阶段是仓库原有的 `prettier --check .`：全局报告约 766 个历史格式问题，涉及既有 `.github`、AGENTS、旧 docs、既有 app/package/test 文件。本轮修改文件单独检查已通过；没有运行全局 `prettier --write`，以免扩大非本轮改动。

## 7. Manual long-task acceptance gate

下一轮人工验收必须由用户在真实环境执行，并记录：

1. 从 `codex/v1-context-memory-refactor` checkout。
2. 按仓库真实 scripts 启动 daemon：`pnpm --filter @caelush/daemon start`；Web 资产由 daemon 的生产 static host 提供。CLI 兼容入口为 `pnpm --filter @caelush/cli start`。这些命令来自各自 `package.json` 的现有 `start` script，不是本轮猜测的命令。
3. 使用真实 provider/config，观察至少一次 Context Usage Ring 从低使用率向高使用率变化，确认显示的是 used ratio。
4. 运行一个真实长任务，覆盖 checkpoint、Tool observation projection、artifact 引用、project Memory retrieval、approval boundary 与 recovery。
5. 手工确认重启后 Context Usage 可恢复为 safe projection，Ring 不显示 raw prompt/memory，Tool output 不泄漏 secrets。
6. 在真实 provider 环境下独立执行长任务验收；本报告不把 fixture smoke、短测试或 release E2E 当成真实长任务通过。

本轮明确未执行：真实 50+/100+ Tool soak、长 DeepSeek run、数小时持续任务、全栈从零启动、人工视觉 sign-off。若其中任何一步失败，状态应退回 `NOT READY` 并记录可复现证据。

## 8. Reviewer and agent accounting

| 项目                              | 结果                                       |
| --------------------------------- | ------------------------------------------ |
| Independent reviewer ID           | N/A（本轮未启动）                          |
| Independent reviewer model        | N/A                                        |
| Independent reviewer role/verdict | N/A；final review pending                  |
| New gpt-5.6-sol Sub-Agent Count   | 0                                          |
| Branch                            | `codex/v1-context-memory-engine-refactor`  |
| Foundation checkpoint             | `96adebcc467ff378c9adc965a8187b40ba790e04` |

## 9. Deferred work

以下内容不属于本轮完成范围，继续保持后续边界：真实 Memory LLM extractor/provider integration、long-task acceptance、MCP/RAG、Task 8-1/Task 9、retry/backoff、new timeout/cancellation behavior、parallel Tool execution、Approval resolution endpoint、secret-redaction redesign、sandbox/remote runtime、Phase 14。
