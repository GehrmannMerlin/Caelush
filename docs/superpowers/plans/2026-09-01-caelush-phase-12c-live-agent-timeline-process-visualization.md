# Phase 12C 实施计划：Live Agent Timeline & Process Visualization

> 执行目录：`D:\Develop\Caelush\.worktrees\phase-12c-live-agent-timeline-visualization`
>
> 基线：`origin/codex/phase-12b-cli-shell-conversation-lifecycle`，
> `81b524bd0b5011e44548108fc5f0c57c31015563`

## 全局约束

- 只做 Phase 12C；不实现 12D/12E、12C-1/12C-2、MCP、Browser、Computer Use、远程 Runtime、sandbox、Tool 并行、Provider 真流式输出或新的 Completion Authority。
- CLI 只能依赖 `@caelush/client`、`@caelush/protocol`、React、Ink 和本地 CLI domain code；不得 import Core、Storage、Runtime、Security、Tools、Verification、LLM。
- Timeline 是纯 projection，不回写任何 durable entity；Protocol AgentEvent 才是唯一输入事实。
- Tool presentation port 的 contract 仅在 `packages/tools`；Security 实现并注入，不反向让 Tools 依赖 Security。
- 所有新增行为必须走 TDD：先新增最小 failing test，运行并确认因能力缺失而失败，再写最小 production code，运行 focused test 变绿，最后 refactor。
- 不修改 Protocol schema，优先使用既有 event base 的 `title`/`summary` 和既有 output event schema；任何缺少 producer 的事件不伪造。
- 每个任务完成后运行该任务列出的 focused test，并在进入下一个任务前保持绿灯。

## Task 1：建立 bounded CLI timeline domain model 与纯 reducer

**目标文件**

- 新建 `apps/cli/src/application/timeline-model.ts`
- 新建 `apps/cli/src/application/timeline-reducer.ts`
- 新建 `apps/cli/test/timeline-reducer.test.ts`
- 更新 `apps/cli/src/application/cli-state.ts` 的 presentation state 类型

**步骤**

1. 先写 failing tests：
   - 同一 `tool.requested`/`tool.started`/`tool.completed` 只生成一个 invocation entry；
   - terminal 事件只冻结 active entry，不把 payload 原样写入 state；
   - `USER_VISIBLE` 才能进入 timeline，DEBUG/SYSTEM 被忽略；
   - durable sequence 推进 cursor，ephemeral 不推进；相同 sequence+eventId 幂等，冲突 sequence fail closed；
   - invocation/process/plan/check correlation 使用精确 ID，未知 terminal standalone，禁止 latest-tool heuristic；
   - bounded text、bounded entries、head/tail marker、连续 reasoning 去重和 omission marker；
   - Run terminal flush 后保留终端结果和 verification finalized。
2. 运行 `pnpm exec vitest run apps/cli/test/timeline-reducer.test.ts`，观察正确的 RED 失败。
3. 实现 plain serializable `CliTimelineEntry`、`CliTimelineState`、`reduceTimelineEvent` 和 `flushTimelineForTerminal`。状态至少包括 settled entries、active tools、active processes、current plan、verification groups、retry entries、cursor、seen IDs 和 fail-closed error。
4. 只从 event payload 的安全字段生成 presentation：reasoning 仅 summary；error 仅 code/phase/message；verification 隐藏 evidence、sealHash、prompt、full diff；approval 仅 title/reason/risk/safe action。
5. 运行 focused test，完成后 refactor 保持纯函数、无 clock、无 ID factory、无副作用。

## Task 2：实现 centralized presentation bounds、labels 与 file/tool/verification projection

**目标文件**

- 新建 `apps/cli/src/application/timeline-presentation.ts`
- 新建/更新 `apps/cli/test/timeline-presentation.test.ts`
- 必要时拆分 `timeline-reducer.ts` 内的纯 helper

**步骤**

1. 先写 failing tests：
   - 9 个 known built-in tool label 和未知 tool fallback；
   - workspace-relative file path、A/M/D/R 变更和 additions/deletions；
   - verification planned/check/repair/finalized 分组；
   - retry scheduled/started 聚合；
   - process running/stopped 和 terminal 时不伪造 EXITED；
   - output Unicode-safe truncation、newline/tab 保留、ANSI/OSC/CSI/C0 删除；
   - hidden payload、raw apply_patch、raw command、secret 字符串不会出现在 presentation。
2. 运行 focused test 确认 RED。
3. 实现集中 bounds 和格式化函数。Tool entry 使用 `invocationId` 主键；File event 仅在唯一兼容同 step active tool 时附着，否则 standalone；Plan update 是 replace，不 append full snapshot。
4. 运行 focused test；不要在 CLI 增加第二套 secret detector，CLI 只处理已经安全的 event 字段。

## Task 3：建立 Tools presentation port 和 Security 实现

**目标文件**

- 新建 `packages/tools/src/presentation.ts`
- 更新 `packages/tools/src/index.ts`、`dispatcher.ts`、`event-factory.ts`、`tool-effects.ts`、`dispatcher-types.ts`
- 新建 `packages/security/src/presentation.ts`
- 更新 `packages/security/src/index.ts`、`default-composition.ts`、`package.json`（若复用 Runtime sanitizer 需要 workspace dependency）
- 新建 `packages/tools/test/presentation-boundary.test.ts`
- 新建 `packages/security/test/presentation.test.ts`

**步骤**

1. 先写 failing Tools tests：
   - presentation port 是 data-only contract；
   - Dispatcher 可以注入 port，未注入时仍使用 generic fallback；
   - presentation throw 不阻止 handler、settlement 或 durable lifecycle；
   - requested/completed/failed 只携带安全 `title`/`summary`，不携带 args。
2. 先写 failing Security tests：
   - known labels；
   - API_KEY、Bearer、URL credential、query token、`sk-`、private key、password assignment 均为 `[REDACTED]`；
   - `write_stdin` chars 不被展示；
   - command/output 经已有 `redactText`/`redactJson`/`CaelushToolResultSanitizer` 和 terminal sanitizer；
   - 4 KiB/8 KiB UTF-8 bounds；presentation failure generic。
3. 分别运行两个 focused test，确认 RED。
4. 写最小 port：invocation presentation、result presentation、shell command presentation；Tools 不 import Security。
5. 在 Security 实现 port，复用已有 redaction/sensitive-path/result sanitizer 和 Runtime terminal sanitizer；不要复制 detector。
6. Dispatcher 在 `tool.requested`、`tool.completed`、`tool.failed` 事件上使用安全 title/summary；在结算边界最多增加一条安全 bounded `tool.output` preview。不要新增 raw streaming side channel，不改变 invocation/observation 生命周期。
7. `toolEffectsToEvents` 的 shell/process command 始终使用安全 presentation 或 generic `shell command`；File effect path 仍只使用 runtime 已验证的 workspace-relative path。
8. 运行 Tools/Security focused tests；再运行相关已有 `packages/tools/test/dispatcher*.test.ts`、`packages/security/test/dispatcher-integration.test.ts`。

## Task 4：接入 CLI state 与 Controller 的 replay/terminal flow

**目标文件**

- 更新 `apps/cli/src/application/cli-state.ts`
- 更新 `apps/cli/src/application/event-projector.ts`
- 更新 `apps/cli/src/application/cli-controller.ts`
- 更新 `apps/cli/test/event-projector.test.ts`、`apps/cli/test/cli-controller-terminal.test.ts`
- 新建 `apps/cli/test/timeline-controller.test.ts`

**步骤**

1. 先写 failing integration tests：
   - `projectAgentEvent` 同时更新 basic lifecycle 和 timeline；
   - 另一 Run、DEBUG/SYSTEM、duplicate event 不改变 state；
   - live ordered events 与 replay ordered events 给出同样的 timeline projection；
   - terminal event 先 flush active timeline，再由 canonical `getRun` 追加 verified assistant/terminal；
   - terminal while process RUNNING 显示 daemon-active notice 而非 fake stop；
   - stream error 不解锁 active Run、不调用 cancellation。
2. 运行 focused tests 确认 RED。
3. 将 `transcript` 升级为兼容性保留的单一 `displayHistory`（或等价方案），包括 USER、settled TIMELINE、ASSISTANT、RUN_TERMINAL，保持既有 public tests 的行为或提供最小兼容 alias。
4. Controller 消费每个 AgentEvent：schema 已在 client 验证；先 lifecycle reducer，再 timeline reducer；只在 terminal 时通过 canonical `getRun` 完成最终 history settlement。
5. 恢复/重连始终从 `afterSequence`/durable cursor 继续，ephemeral 不进入 cursor；冲突进入安全 fatal/presentation boundary。
6. 运行 focused tests 与已有 CLI controller tests。

## Task 5：按 domain 拆分 Ink 静态历史与动态活动区

**目标文件**

- 新建 `apps/cli/src/components/History.tsx`
- 新建 `apps/cli/src/components/ActiveTimeline.tsx`
- 新建 `apps/cli/src/components/CurrentPlan.tsx`
- 新建 `apps/cli/src/components/VerificationActivity.tsx`
- 新建 `apps/cli/src/components/ActiveProcesses.tsx`
- 更新 `apps/cli/src/components/App.tsx`、`Transcript.tsx`、`ActivityStatus.tsx`
- 更新 `apps/cli/test/components.test.tsx`，必要时新建 `apps/cli/test/timeline-components.test.tsx`

**步骤**

1. 先写 failing Ink tests：
   - 只有一个主要 `<Static>` 承载 settled history；
   - USER/ASSISTANT/TERMINAL/TIMELINE 按 chronological order 显示；
   - active tool/current plan/verification/process/status 在 dynamic area 更新，不重复 settled 行；
   - safe label/summary/output 可见，raw invocationId/args/secret/hidden payload 不可见；
   - composer 仍受 Controller state 控制；无 approval resolve button；
   - unknown tool/empty sections 不 crash。
2. 运行 focused tests 确认 RED。
3. 实现 domain components；props 只接受 CLI plain view models；不直接读 AgentEvent，不引入 Core/Storage/Runtime/Security/Tools/Verification/LLM。
4. 保留 inline scrollback，不引入 alternate screen/fullscreen/pager，不加非交互模式。
5. 运行 Ink focused tests 与全 CLI component tests。

## Task 6：补齐真实 daemon composition 与 output event bridge 测试

**目标文件**

- 更新 `apps/daemon/src/daemon-composition.ts` 以注入 Security presentation
- 必要时更新 `apps/daemon/src/transport/sse-event-mapper.ts` 或新增最小安全审计 helper
- 新建/更新 `apps/daemon/test/timeline-e2e.test.ts`
- 新建/更新 `apps/daemon/test/events-sse-security.test.ts`
- 必要时更新 `packages/storage`/`packages/events` 测试 fixture

**步骤**

1. 先写 failing E2E：使用真实 Fastify daemon、真实 client、controller、Ink app、EventBus、SQLite、RunController、AgentLoop、Tool、Runtime、Security、Verification；仅外部 Provider fake。
2. 场景包含实际 `reasoning.summary`、read/search/apply_patch、安全 exec command、Git、verification/completion；禁止 controller 直接 fake event。
3. 写 approval-wait 场景：真实 `WAITING_APPROVAL` 后 CLI 停止等待，不加入 UI resolution。
4. 写 security 场景：Tool → Security → committed Event → SSE → Client → Timeline → Ink，确认 command/output terminal frame 无 raw secret。
5. 运行 targeted E2E，确认 RED。
6. 在 daemon composition 注入 `createDefaultV1ToolPresentation()`（名称按实现确定），只允许已 sanitised event 出 SSE；不在 route 中重新实现 replay 或业务 projection。
7. 运行 targeted E2E 和已有 daemon SSE/reconnect/multiclient/production E2E。

## Task 7：补充架构测试、文档与状态

**目标文件**

- 新建 `tests/architecture/phase-12c-timeline-boundaries.test.ts`
- 新建 `docs/architecture/cli-agent-timeline.md`
- 新建 `docs/architecture/cli-presentation-security.md`
- 更新 `docs/architecture/cli-application-shell.md`
- 更新 `README.md`
- 更新 `AGENTS.md`

**步骤**

1. 先写 failing architecture tests：CLI deep import/package boundary、single Static、projection purity、event visibility、presentation port direction、no raw output/fake timer/event、no new Phase 12 round。
2. 运行 targeted architecture test 确认 RED。
3. 写文档：覆盖矩阵、缺失 producer、replay/cursor、correlation、bounds、terminal flush、Tool presentation boundary、secret/terminal safety、12D deferred boundary、研究来源。
4. README/AGENTS 状态明确：12A COMPLETED、12B COMPLETED、12C COMPLETED（完成后）、12D/12E NOT STARTED、Phase 12 IN PROGRESS。
5. 运行 architecture tests 和 Markdown/changed-file Prettier check。

## Task 8：专项门禁与回归

依次运行，任何失败都按 systematic debugging 先定位再修复，并为 bug 补 RED test：

```text
pnpm exec vitest run apps/cli/test/timeline-reducer.test.ts apps/cli/test/timeline-presentation.test.ts apps/cli/test/timeline-controller.test.ts apps/cli/test/timeline-components.test.tsx
pnpm exec vitest run packages/tools/test/presentation-boundary.test.ts packages/security/test/presentation.test.ts
pnpm exec vitest run apps/daemon/test/timeline-e2e.test.ts apps/daemon/test/events-sse-security.test.ts
pnpm exec vitest run tests/architecture/phase-12c-timeline-boundaries.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm check
```

对全仓 `format:check`，记录 Phase 12C 开始时的 754 个基线 warning；验收条件是 changed
files 不新增 warning，非格式门禁全部 exit 0。所有已有 Phase 8–12B 回归必须保留通过。

## Task 9：最终验证、diff review、push 与远端核验

1. 重新读取本计划和设计规格，逐项核对没有实现未来 Phase。
2. 运行完整 verification：lint/typecheck/test/build/check、changed-file Prettier、`git diff --check`。
3. 检查 `git status --short` 和 `git diff`，确认只含 Phase 12C 文件，禁止 secrets、generated dist、临时文件。
4. 提交 Phase 12C commit，使用清晰 commit message；不得 squash/重写 Phase 12B、不得 force push。
5. `git push -u origin codex/phase-12c-live-agent-timeline-visualization`，重新 `git fetch origin --prune` 和 `git ls-remote`，确认 remote SHA == local HEAD。
6. 保留 worktree 与 branch，不自动 merge master，不自动创建 PR。
7. 最终报告用中文，包含 89 项验收清单、覆盖矩阵、基线与最终 gate 结果、研究链接、缺失 producer、文件列表、commit/remote SHA 和明确停止在 12C 的声明。
