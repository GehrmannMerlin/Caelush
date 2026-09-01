# Caelush V1 Phase 12C：Live Agent Timeline & Process Visualization 设计规格

## 1. 范围、授权与结论

本规格把用户上传的 `Caelush V1 — Phase 12C.md` 视为本轮实现规格；仓库的
`AGENTS.md`、既有 Phase 1–12B 契约和用户直接请求仍是更高优先级约束。上传文档
明确 Phase 12C 的架构已经批准，因此本规格不重新进行产品方案选择，而是把已批准
的边界落成可执行设计和测试清单。

本轮只实现：

- CLI 的纯 AgentEvent Timeline projection；
- settled history 与 active work 的分离渲染；
- Tool、Shell、File、Process、Reasoning、Plan、Retry、Approval、Verification 的
  安全可读展示；
- Security → Tools 的展示安全桥；
- EventBus/SSE replay 下的确定性、去重、游标和 bounded state；
- Ink 组件、Controller 接线、专项测试、生产 E2E 和架构文档。

本轮明确不实现 12D/12E、Approval UI resolution、Browser、MCP、Computer Use、远程
Runtime、sandbox、新的事件存储模型、Tool 并行、Provider 真流式输出、隐藏思维链、
以及任何 `COMPLETED` authority 变更。

核心结论：Timeline 是 CLI 内的只读 projection，不是真相源，也不回写 Run、State、
Tool、Verification 或 Runtime。输入始终是经过 Protocol schema 的 AgentEvent；同一份
durable event 序列在重放和 live watch 下必须得到同一份 CLI view state。

## 2. 基线与前置审计

### 2.1 Git 基线

Phase 12B 远端分支已重新 fetch 并核验为：

```text
origin/codex/phase-12b-cli-shell-conversation-lifecycle
81b524bd0b5011e44548108fc5f0c57c31015563
```

该提交不是 `origin/master` 的祖先，因此 Phase 12C 从上述 Phase 12B 远端分支创建，
没有把 master 作为越级基线。当前隔离 worktree 为：

```text
D:\Develop\Caelush\.worktrees\phase-12c-live-agent-timeline-visualization
```

分支为 `codex/phase-12c-live-agent-timeline-visualization`。

Phase 12B 的 changed-file Prettier 审计以 Phase 12A SHA
`1f5fde1bfe71ce26e69c4dbb4d7831bd0b05a562` 为起点，共 51 个文件。两份 CLI manifest
曾在 12B worktree 中被 Prettier 写回，但 Git 规范化 blob 没有产生可提交内容；重新
推送后远端仍保持上述 12B SHA。`apps/cli/package.json` 与 `apps/cli/tsconfig.json`
在 Phase 12A 基线中已经是 Prettier clean，当前 checkout 也复核为 clean；其余 6 个
warning 与 12A 基线相同，故没有可证明的 Phase 12B 新增格式债务。

12C worktree 的基线门禁记录：

| Gate                             | 结果                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 通过，17 个 workspace project                                                          |
| `pnpm lint`                      | 通过                                                                                   |
| `pnpm typecheck`                 | 通过                                                                                   |
| `pnpm test`                      | 通过，278 files / 1004 passed / 5 skipped                                              |
| `pnpm build`                     | 通过                                                                                   |
| `pnpm format:check`              | 基线失败；当前安装的 Prettier 报告 754 个既有 warning，未将全仓格式化作为 12C 功能改动 |

测试运行期间没有新增测试失败。Windows 上的 `node-pty` `AttachConsole failed` 文本是
测试子进程输出，但 Vitest 仍以 278/278 files、1004 passed、5 skipped、exit 0 结束。

### 2.2 事件覆盖矩阵

以下矩阵基于当前 Phase 12B 生产代码和协议 schema 的逐项审计。`生产发射器` 只在
Core/Tools/Storage/Verification 的 production `src` 中确认；测试 fixture、schema 和
架构文档不算 producer。当前生产 event factory 都使用 `DURABLE`、schema version 1 和
`USER_VISIBLE`，没有发现真实 production `EPHEMERAL` emitter。SSE 仍由 EventBus watch
统一 replay，durable sequence 是游标和显示排序依据。

| Event                               | Schema | 生产发射器 | Package / 位置                       | Durable / visibility | Correlation 与 CLI policy                                                |
| ----------------------------------- | ------ | ---------- | ------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| `run.started`                       | 有     | 有         | Core `run-controller-events.ts`      | durable / user       | runId/sessionId；建立 RUNNING，不写历史                                  |
| `status.changed`                    | 有     | 有         | Core `run-controller-events.ts`      | durable / user       | runId/sessionId；更新生命周期，不单独刷永久行                            |
| `run.completed`                     | 有     | 有         | Core completion authority            | durable / user       | runId；终端 flush 后追加 verified assistant                              |
| `run.failed`                        | 有     | 有         | Core termination authority           | durable / user       | runId；追加安全 terminal 行                                              |
| `run.cancelled`                     | 有     | 有         | Core cancellation boundary           | durable / user       | runId；追加取消 terminal 行                                              |
| `run.timed_out`                     | 有     | 有         | Core deadline boundary               | durable / user       | runId；追加 timeout terminal 行                                          |
| `reasoning.summary`                 | 有     | 有         | Core event factory                   | durable / user       | stepId；只显示 payload.summary，限长、连续去重                           |
| `plan.updated`                      | 有     | 无         | schema only                          | —                    | 不伪造；当前 Plan 只能由真实 producer 或终端 snapshot 提供               |
| `llm.started`                       | 有     | 有         | Core event factory/controller        | durable / user       | stepId；active Thinking，不生成永久 provider 行                          |
| `llm.completed`                     | 有     | 有         | Core event factory/controller        | durable / user       | stepId；结束 Thinking，使用量只作安全摘要                                |
| `llm.failed`                        | 有     | 有         | Core event factory/controller        | durable / user       | stepId + AgentError；错误/重试关系保持安全                               |
| `retry.scheduled`                   | 有     | 有         | Core retry controller                | durable / user       | stepId；按 attempt/max/delay/error code 建一个 retry entry               |
| `retry.started`                     | 有     | 有         | Core retry controller                | durable / user       | stepId；更新同一 retry entry，不重复                                     |
| `tool.requested`                    | 有     | 有         | Tools Dispatcher                     | durable / user       | invocationId 精确关联；只显示 label/risk/safe summary                    |
| `tool.started`                      | 有     | 有         | Tools Dispatcher                     | durable / user       | invocationId 精确更新 REQUESTED→RUNNING                                  |
| `tool.output`                       | 有     | 有         | Tools Dispatcher settlement bridge   | durable / user       | 结算点最多一条安全 bounded preview；不是实时 chunk side channel          |
| `tool.completed`                    | 有     | 有         | Tools Dispatcher                     | durable / user       | invocationId；同一 entry settled                                         |
| `tool.failed`                       | 有     | 有         | Tools Dispatcher                     | durable / user       | invocationId；同一 entry failed，错误只取 code/phase/message             |
| `file.read`                         | 有     | 有         | Tools effect bridge                  | durable / user       | stepId + path；只显示 workspace-relative path                            |
| `file.created`                      | 有     | 有         | Tools effect bridge                  | durable / user       | stepId + summary.path；显示 A/added/deletions                            |
| `file.modified`                     | 有     | 有         | Tools effect bridge                  | durable / user       | stepId + summary.path；显示 M/additions/deletions                        |
| `file.moved`                        | 有     | 有         | Tools effect bridge                  | durable / user       | stepId + fromPath/toPath；不依赖颜色                                     |
| `file.deleted`                      | 有     | 有         | Tools effect bridge                  | durable / user       | stepId + summary.path；显示 D                                            |
| `shell.started`                     | 有     | 有         | Tools effect bridge                  | durable / user       | invocationId；命令通过 Security 展示桥，失败则 generic                   |
| `shell.output`                      | 有     | 无         | schema only                          | —                    | 不把 runtime raw stream 伪装成 live output；结算 preview 需 sanitizer    |
| `shell.completed`                   | 有     | 有         | Tools effect bridge                  | durable / user       | invocationId；exitCode/signal 安全摘要                                   |
| `process.started`                   | 有     | 有         | Tools effect bridge                  | durable / user       | process.id；active process panel，command generic/safe                   |
| `process.output`                    | 有     | 无         | schema only                          | —                    | 当前没有 producer；不显示假 output                                       |
| `process.stopped`                   | 有     | 有         | Tools effect bridge                  | durable / user       | processId + status；终端时不假造 EXITED                                  |
| `verification.started`              | 有     | 无         | legacy schema only                   | —                    | 当前 11B/11D 路径不用；由 planned/check/finalized 驱动                   |
| `verification.completed`            | 有     | 无         | legacy schema only                   | —                    | 当前无 producer；不用旧 result 推断                                      |
| `verification.planned`              | 有     | 有         | Core + Storage execution commit      | durable / user       | planId；建立 Verification group/counts                                   |
| `verification.check.started`        | 有     | 有         | Storage verification execution store | durable / user       | planId+checkId；更新唯一 check active                                    |
| `verification.check.completed`      | 有     | 有         | Storage verification execution store | durable / user       | planId+checkId；PASSED/FAILED/ERROR/SKIPPED                              |
| `verification.repair.started`       | 有     | 有         | Core repair boundary                 | durable / user       | failedPlanId + cycle；显示 repair notice                                 |
| `verification.repair.limit_reached` | 有     | 有         | Core repair boundary                 | durable / user       | planId；显示 limit notice，不能继续循环                                  |
| `verification.finalized`            | 有     | 有         | Core completion authority            | durable / user       | planId；显示 final outcome，sealHash 永不显示                            |
| `approval.requested`                | 有     | 有         | Tools Dispatcher                     | durable / user       | approval.id/tool invocation；只显示 title/reason/risk/action safe subset |
| `approval.resolved`                 | 有     | 有         | Storage approval repository          | durable / user       | approvalId；显示 status，不提供 12C UI action                            |
| `error`                             | 有     | 有         | Core error boundary                  | durable / user       | runId/stepId；仅 AgentError code/phase/message                           |
| `budget.exceeded`                   | 有     | 有         | Core budget boundary                 | durable / user       | runId；只显示 dimension/limit/accounted                                  |

矩阵中最重要的负结论是：Protocol schema、Durable Event Store、SSE mapper 和 UI 都不
能把不存在的 producer 变出来。12C 对 `tool.output` 只增加了安全的结算摘要 bridge；
对于仍缺失的 `plan.updated`、`shell.output`、`process.output` 和 legacy verification
producer，不伪造实时事件，使用已有 terminal/check/finalized 事实或保持不可见，并在
文档中标为后续能力。

## 3. 目标架构

```text
AgentEvent SSE / EventBus replay
        │ schema-validated, sequence-ordered
        ▼
Lifecycle Projector ──────── basic status / terminal boundary
        │
        ▼
Timeline Projector (pure reducer)
        │ bounded serializable view model
        ▼
CliTimelineState
   ┌────┴───────────────┐
   ▼                    ▼
Settled displayHistory  Active work projections
   │                    │
   └──────────┬─────────┘
              ▼
        Ink History / ActiveTimeline / Plan / Verification / Processes / Composer
```

### 3.1 State ownership

- Protocol `AgentEvent`、Run、State、Step、Observation 和 Verification entity 是事实；
  CLI 不保存它们的可变副本作为业务真相。
- `CliTimelineState` 只保存可序列化、安全、bounded 的 presentation projection。
- 现有 `transcript[]` 升级为单一有序 `displayHistory[]`，元素至少包含 USER、ASSISTANT、
  TERMINAL、TIMELINE 四类；不再由不同组件各自创建平行 scrollback。
- `settledHistory` 是 append-only presentation list；活动 Tool、Plan、Verification、
  Process 和当前 status 留在 dynamic projection，结算时才进入 history。
- `lastDurableSequence` 只由 durable event 推进；ephemeral event 永不推进游标。
- `seenEventIds` 为 bounded 去重缓存。相同 sequence + 相同 eventId 是幂等重复；相同
  sequence + 不同 eventId 触发 fail-closed projection error，并显示安全错误边界。

### 3.2 Tool correlation

Tool entry 的主键是 `invocationId`，不能用 latest-tool heuristic。`tool.requested` 创建
entry，`tool.started` 更新为 RUNNING，`tool.completed`/`tool.failed` 终结同一 entry。
未知的 terminal 事件成为安全 standalone entry，identity conflict 不覆盖既有 entry。

File event 没有 invocationId。只有在同一 `stepId` 下存在且仅存在一个兼容 active Tool
并且 path/effect 能证明属于它时才附着；有两个或更多候选时必须 standalone。这样保留
“一条 invocation 一行”的 invariant，不把并行未来能力提前实现。

### 3.3 Verification 与 Process

- Verification entry 以 `planId` 为组主键，check 以 `(planId, checkId)` 为键；没有
  `planId` 的旧事件只能安全显示为 standalone，不能加入任意计划。
- Process entry 以 `processId` 为键。`process.started` 进入 active process panel，
  `process.stopped` 才 settled；Run terminal 时若仍为 RUNNING，显示
  “Process remains active in daemon.”，移出当前 active panel，但不伪造 stopped。
- Verification finalized 和 Run terminal 永远不能被 entry count/truncation marker 淘汰。

## 4. Safe Presentation Boundary

### 4.1 Port placement

`packages/tools` 只定义 provider-independent、data-only 的展示 port，例如 Tool
invocation/result/shell command 的安全 presentation DTO。它不依赖 `packages/security`。
`packages/security` 实现该 port，并复用已有 `redactText`、`redactJson`、
`redactToolArgumentsForPresentation`、`classifySensitivePath`、
`CaelushToolResultSanitizer` 和 runtime 的 terminal sanitizer；不引入第二套 secret detector。
Security 不直接依赖 Runtime；Daemon Composition Root 以纯函数端口注入既有 Runtime
terminal sanitizer。

Dispatcher 在构造和 event factory 中调用该 port；presentation 失败时捕获并返回
generic label/summary，绝不能阻止 Tool 执行、改变 invocation settlement 或把 exception
文本送到事件/CLI。

### 4.2 Tool presentation

固定 human label：

| Tool name        | label                 |
| ---------------- | --------------------- |
| `read_file`      | Read file             |
| `list_directory` | List directory        |
| `find_files`     | Find files            |
| `search_text`    | Search text           |
| `apply_patch`    | Edit files            |
| `exec_command`   | Run command           |
| `write_stdin`    | Interact with process |
| `git_status`     | Check Git status      |
| `git_diff`       | Inspect Git diff      |

未知 tool 使用原始 `toolName` 作为 label，但必须 bounded、不会 crash。requested 只带
`title`/`summary` 等安全字段，不带 raw args；result 只展示 ToolResultSanitizer 后的
政策摘要，不把 observation details、credentials、raw arguments 或 exception 作为 CLI 文本。

### 4.3 Shell / terminal safety

```text
raw cmd
  → Security redact command / sensitive args
  → terminal control sanitizer (OSC, CSI, cursor/title/hyperlink/C0)
  → UTF-8 byte bound (head + marker + tail)
  → safe displayCommand
  → USER_VISIBLE event title/summary/output
```

命令展示上限 4 KiB；无法安全呈现时只显示 `Run command`。不显示 write_stdin chars、
password、stdin、env、auth header。至少覆盖 `API_KEY`、Bearer Authorization、URL credential、
query token、`sk-` provider token、private key、password assignment，并统一使用
`[REDACTED]`。terminal sanitization 必须删除 OSC/CSI/cursor/title/hyperlink/C0，不只删颜色，
同时保留 newline、tab 和合法 Unicode。

### 4.4 File/result safety

- read file 只显示 workspace-relative path；绝对路径、`..` 或 workspace 外观路径安全省略。
- file mutation 显示 A/M/D/R、路径和 additions/deletions；不打印 raw apply_patch。
- line diff 只有在 run-attributed、bounded、已 sanitizer 处理的来源存在时才可显示；否则
  fallback 为 per-file summary。`git_diff` 只能消费已 sanitised bounded result，敏感 diff
  显示 `[SENSITIVE DIFF CONTENT REDACTED]`。
- exec/write_stdin output 只能进入 bounded dynamic preview 或结算 event；不得把 runtime
  原始 stream 直接送 UI。

## 5. Bounds、确定性与终端 flush

所有 timeline text 使用 UTF-8 byte bound，截断 marker 为用户可见的
`… output truncated …`。对 output 使用 head+marker+tail；对大量相同 reasoning 使用连续
去重；对 file read 使用 compact summary；达到 entry 上限时只插入一次
`… additional activity omitted …`，仍继续消费后续 events。

建议默认值（集中在 CLI presentation limits）：

- 每个 timeline text 8 KiB；Tool output preview 8 KiB；Reasoning 4 KiB；
- active timeline entries 32；settled timeline entries per run 256；
- process preview 4 KiB；seen event IDs 1024；
- history terminal/assistant 不受普通 timeline omission marker 淘汰。

终端 event 到达时，Reducer 先冻结 active timeline，按 durable sequence 把当前活动项
转为 presentation-only interrupted/settled state，再由 Controller 通过 canonical
`getRun` 追加最终 Assistant 或 terminal entry。不能用终端 event 的 payload 伪造 verified
result；不能把 interrupted Tool invocation 持久化为新状态。

## 6. Ink 组件边界

组件按 domain 拆分而非按 event 拆分：

- `History`：唯一主要 Ink `<Static>`，渲染 USER/ASSISTANT/TERMINAL/settled TIMELINE；
- `ActiveTimeline` / `ActiveTool`：当前 Tool、命令、输出预览；
- `CurrentPlan`：当前 plan snapshot，更新替换而非完整 plan append；
- `VerificationActivity`：planned/count、当前 check、repair、finalized；
- `ActiveProcesses`：process id、safe command、running/stopped status；
- `Composer`：仅在无 active Run 且非错误时可输入。

保持 inline scrollback，不引入 alternate screen/fullscreen/pager，也不在 12C 添加
approval resolution button 或其他交互。Ink 组件只接受 plain serializable props，不能
import Core/Storage/Runtime/Security/Tools/Verification/LLM。

## 7. 研究结论与采用点

本轮重新检查了 OpenAI Codex TUI 和 Claude Code 的当前公开实现/文档：

- OpenAI Codex 将 command lifecycle 单独处理 start/output/completion，并维护 active
  exec cell 与统一等待状态；其 non-command tool lifecycle 也把 start/completion 对应
  到 transcript cells。Caelush 采用“同一 identity 更新 active → settled”的原则，但
  受自身 durable AgentEvent 契约约束，不复制 Codex 的 provider-specific item 类型。
  参考：[Codex command lifecycle](https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget/command_lifecycle.rs)、
  [Codex tool lifecycle](https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget/tool_lifecycle.rs)。
- OpenAI Codex 的 transcript hydration 将 user、agent、plan、reasoning 和 fallback
  tool cells 归一到一个 transcript cell 序列，说明“单一历史流 + domain cell”适合
  replay；Caelush 采用同样的 history/display separation，但严格禁止 raw hidden reasoning。
  参考：[Codex thread transcript](https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/thread_transcript.rs)。
- Claude Code 的 interactive-mode 文档明确区分持续 transcript 与 status/task area，
  提供 transcript viewer，并以 `Ctrl+T` 展示 task checklist；其文档也说明 `Esc` 可中断
  当前 response/tool。Caelush 只借鉴“持久历史与当前活动区分离”和 bounded summary，不
  提前实现 12D 的输入交互或中断语义。
  参考：[Claude interactive mode](https://code.claude.com/docs/en/interactive-mode)、
  [Claude common workflows](https://code.claude.com/docs/en/common-workflows)。

## 8. 测试与验收设计

必须先写失败测试再实现最小行为。专项测试覆盖：

1. pure reducer/lifecycle 与 durable cursor；
2. invocation/process/plan/check correlation 和 identity conflict；
3. file read/mutation summaries；
4. shell command redaction、terminal escape、secret categories；
5. reasoning summary、plan replacement、retry aggregation；
6. verification planned/check/repair/finalized；
7. process running/stopped/terminal-live behavior；
8. approval requested/resolved/error/budget；
9. duplicate/replay/order/bounds/omission marker；
10. Ink static history、dynamic active sections、composer lifecycle；
11. real Fastify daemon → real client/SSE/EventBus/SQLite/RunController/AgentLoop/Tools/Runtime/Security/Verification → Ink E2E，外部 Provider 仅使用 fake；
12. actual WAITING_APPROVAL stop E2E，不加入 UI resolve；
13. security E2E 确认 secret 不出现在 terminal frame；
14. architecture tests 确认 CLI package boundary、single Static、无 fake event/timer、
    presentation port direction 和 no deep imports。

Phase 12C 完成条件是上述行为和文档均已提交、全量回归通过、`pnpm check` 的非格式门禁
通过、changed files 没有新增 Prettier warning，且分支 push 后远端 SHA 与本地 HEAD 一致。
