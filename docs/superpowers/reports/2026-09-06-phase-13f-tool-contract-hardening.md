# Caelush Phase 13F Completion Report

## 结论摘要

Phase 13F 的代码审计与本轮实现已经完成，目标分支为
`codex/phase-13f-tool-contract-hardening`。本轮强化了 OpenAI-compatible Tool
Call 解析、统一参数校验/安全归一化、ToolPreflight、模型可见 guidance、受限的
ToolFailureMemory、脱敏 Tool-calling debug，以及 daemon 层的 Tool selection policy。

本轮没有扩展 Phase 14，没有引入 MCP、RAG 或 Skill，没有改变 Security Authority
或 Runtime Authority，也没有把具体 Tool 引入 Core AgentLoop。

验收状态需要区分两部分：

- 本地实现、类型、架构和全量测试验收通过。
- 真实 DeepSeek 验收脚本已执行，但当前工作区没有
  `CAELUSH_PROVIDER_API_KEY` 或 `DEEPSEEK_API_KEY`，因此该部分严格记录为
  `SKIPPED`，不能宣称 credentials-backed DeepSeek 成功。

## 范围和边界

本轮检查了下列实际目录：

- `packages/tools`
- `packages/core`
- `packages/runtime`
- `packages/protocol`
- `apps/daemon`（仓库中实际的 daemon composition root；不存在独立的
  `packages/daemon`）
- `packages/llm` 的 OpenAI-compatible adapter 路径

保留的边界如下：

- Protocol 仍是底层 JSON-safe contract source of truth。
- Core 仍拥有 AgentLoop/RunController，但不认识具体 Tool、不直接执行 Tool。
- Tool 仍只能通过 Dispatcher 执行。
- Security Gate 仍负责 permission/capability/risk/approval 决策。
- Runtime 仍负责 workspace containment、realpath、shell/process/session、Git 和
  patch 执行语义。
- Daemon 仍是本地 service composition root。
- Tool invocation 的 durable lifecycle、approval boundary、uncertainty barrier、
  Tool batch 顺序和 existing process manager 均保持不变。

## 第一阶段：Tool Inventory Report

### 当前 active default catalog

默认注册顺序和 active registry 中的 Tool 是：

1. `read_file`
2. `list_directory`
3. `find_files`
4. `search_text`
5. `apply_patch`
6. `exec_command`
7. `write_stdin`
8. `git_status`
9. `git_diff`

Git capability 不可用时，既有 `filterToolRegistryForEnvironment()` 会从 active
registry 中隐藏 Git tools；因此上面是完整 default catalog，实际模型 catalog
仍可能是其环境过滤后的子集。

### Registry 一致性审计

当前 registry graph 为：

```text
createDefaultBuiltinToolRegistrations(runtimeResolver)
  -> ToolRegistryBuilder.register({
       definition,
       modelGuidance,
       handler,
       effectProjector?,
       securityFactsProjector?
     })
  -> ToolRegistryBuilder.build()
  -> one immutable ToolRegistry
       ├─ modelDefinitions()
       ├─ modelGuidance()
       ├─ names()
       └─ resolve(name)
            ├─ definition
            ├─ precompiled input/output validators
            ├─ handler
            ├─ effect projector
            └─ security-facts projector

active registry
  -> daemon environment exposure filter
  -> Security V1 secure Dispatcher
  -> ToolBatchCoordinator
  -> Agent-facing model catalog and runtime resolution
```

结论：`ToolDefinition`、`ToolModelGuidance`、Handler、Resolver 所依赖的注册信息、
Dispatcher 和模型 catalog 来自同一条 immutable registry 构建链，不存在一个独立的
model-tool map 再配一个 runtime-tool map 的漂移风险。

`ToolRegistryBuilder` 在注册边界复制并冻结 definition/guidance，拒绝重复 Tool name；
在 build 时编译 schema 一次；`ImmutableToolRegistry` 冻结 ordered names、definitions、
guidance 和 resolved registration。调用方后续修改原始对象不能改变 active catalog。

### Tool 明细

下表的 `handler` 是实际 registration handler，`resolver/runtime path` 是 handler
使用的 Runtime port；安全 facts projector 会把受限的结构化事实交给既有 Security
Gate，但不替代 Security Authority。

| Tool             | Description / Model guidance                                                                                                                                                   | Input schema 与字段                                                                                                                                                                    | Required     | Risk     | Capability                                    | Handler / Resolver / Runtime execution path                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`      | 读取 bounded UTF-8 文本；已知文本文件内容时使用；不要读取目录、binary 或 workspace 外路径；只读，按行分页，结果含 truncation                                                   | `path:string,minLength=1`; `offset:integer,min=1,default=1`; `limit:integer,min=1,max=2000,default=400`; `additionalProperties:false`                                                  | `path`       | LOW      | `FS_READ`                                     | `createReadFileRegistration` → injected `RuntimeResolver` → `scope.pathResolver.resolveExisting()` → `scope.filesystem.readTextFile()`             |
| `list_directory` | 列出目录直接子项；需要目录结构时使用；不要用来递归发现或读取内容；只读，使用 `.` 表示 workspace root                                                                           | `path:string,minLength=1`; `offset:integer,min=1,default=1`; `limit:integer,min=1,max=500,default=200`; `additionalProperties:false`                                                   | `path`       | LOW      | `FS_READ`                                     | `createListDirectoryRegistration` → `scope.pathResolver.resolveExisting()` → `scope.filesystem.getMetadata/readDirectory()`                        |
| `find_files`     | 按 glob 查找文件；未知路径或递归发现时使用；不要用来读取内容或访问 workspace 外路径；只读，结果可能 bounded/truncated                                                          | `pattern:string,minLength=1`; `path:string,minLength=1,default="."`; `limit:integer,min=1,max=500,default=100`; `additionalProperties:false`                                           | `pattern`    | LOW      | `FS_READ`                                     | `createFindFilesRegistration` → `scope.pathResolver.resolveExisting()` → `scope.discovery.find()`，并逐项复核 workspace containment                |
| `search_text`    | 搜索 workspace 文本、symbol 或精确字符串；不要用于目录 listing 或无目标的大扫描；只读，固定 ripgrep backend，坏 pattern 是可恢复错误                                           | `pattern:string,minLength=1`; `path:string,minLength=1,default="."`; `include:string,minLength=1` optional; `limit:integer,min=1,max=200,default=100`; `additionalProperties:false`    | `pattern`    | LOW      | `FS_READ`                                     | `createSearchTextRegistration` → `scope.pathResolver.resolveExisting()` → `scope.textSearch.search()`，runtime requirement 为 `rg`                 |
| `apply_patch`    | 应用经过解析、规划、guard、顺序 commit 和 verify 的 patch；仅在已有证据支持 requested change 时使用；不要用来猜测文件内容或做读取；会修改文件，Security Gate/approval 仍可介入 | `patch:string,minLength=1`; `additionalProperties:false`                                                                                                                               | `patch`      | HIGH     | `FS_WRITE`, `FS_DELETE`                       | `createApplyPatchRegistration` → `scope.patch.apply()` → Runtime verified patch engine；Security facts/approval 仍在 Dispatcher 前后按既有路径执行 |
| `exec_command`   | 执行测试、构建、依赖安装和服务命令；不要在 native read/list/search 足够时用来读文件或搜代码；可能启动 process、修改状态或访问网络，风险由既有 Gate 判断                        | `cmd:string,minLength=1`; `workdir:string,minLength=1,default="."`; `tty:boolean,default=false`; `yield_time_ms:integer,min=250,max=30000,default=10000`; `additionalProperties:false` | `cmd`        | CRITICAL | `SHELL_EXEC`, `PROCESS_START`                 | `createExecCommandRegistration` → `scope.exec.execute()` → fixed platform shell resolver → `LocalProcessManager` / pipe or PTY adapter             |
| `write_stdin`    | 继续或轮询一个由 `exec_command` 返回的 process session；不要用来启动命令或猜 session id；可能写入 stdin，session 必须属于当前 Run                                              | `session_id:string,minLength=1`; `chars:string,default=""`; `yield_time_ms:integer,min=250,max=30000,default=10000`; `additionalProperties:false`                                      | `session_id` | CRITICAL | `SHELL_EXEC`, `PROCESS_START`, `PROCESS_KILL` | `createWriteStdinRegistration` → `scope.exec.interact()` → owner-Run checked `LocalProcessManager` session                                         |
| `git_status`     | 获取 Git working-tree 状态；需要 repo evidence 时使用；不要把非 Git 目录说成 clean，也不执行 mutation；只读且结果 bounded                                                      | `path:string,minLength=1` optional; `limit:integer,min=1,max=1000,default=200`; `additionalProperties:false`                                                                           | 无           | LOW      | `GIT_READ`                                    | `createGitStatusRegistration` → `scope.git.status()` → Runtime Git service；无 Git capability 时由 exposure filter 隐藏                            |
| `git_diff`       | 获取 bounded diff；review changes 时使用；不要应用 patch，也不要把截断 diff 当作完整证据；只读                                                                                 | `scope:string,enum=[WORKTREE,STAGED,ALL],default="ALL"` optional; `path:string,minLength=1` optional; `additionalProperties:false`                                                     | 无           | LOW      | `GIT_READ`                                    | `createGitDiffRegistration` → `scope.git.diff()` → Runtime Git service；无 Git capability 时由 exposure filter 隐藏                                |

### 参数 contract 结论

所有内置 input schema 都是 object-root、顶层
`additionalProperties: false`，并在 registry build 时做一次 compile。schema 中的
`default` 是模型 contract metadata，不是 validator 的隐式写入动作；现有 handler
仍负责使用自身的运行时 default。这样既让模型知道省略参数的默认行为，也避免
validation 改写 caller-owned arguments。

## 第二阶段：Schema Quality Report

评分标准为：Tool name 稳定性（1）、description purpose/when/when-not/side-effect
完整性（2）、字段 type/required/constraints/default 清晰度（3）、严格 object schema
与额外字段拒绝（2）、runtime/approval/recovery guidance（2）。

| Tool             | 分数（10） | 主要判断                                                                                                   |
| ---------------- | ---------: | ---------------------------------------------------------------------------------------------------------- |
| `read_file`      |          9 | 字段、行范围、分页和 UTF-8/containment guidance 完整；执行边界由 Runtime 保持                              |
| `list_directory` |          9 | 目录语义、offset/limit/default 和只读限制清楚                                                              |
| `find_files`     |          9 | glob/path/limit 约束和未知路径场景清楚                                                                     |
| `search_text`    |          9 | pattern/include/limit 约束、固定搜索 backend 和坏 pattern recovery 清楚                                    |
| `apply_patch`    |          9 | mutation side effect、证据要求、patch-only 语义和 approval 提示清楚                                        |
| `exec_command`   |          8 | coding-agent 场景和 process 风险清楚；刻意不暴露 Phase 8C 禁止的 model-controlled timeout/background/shell |
| `write_stdin`    |          9 | session ownership、poll/write 语义和 observation wait 清楚                                                 |
| `git_status`     |          9 | Git availability、clean evidence 和 bounded output guidance 清楚                                           |
| `git_diff`       |          9 | scope enum、truncation/review guidance 和只读限制清楚                                                      |

description 经过现有 OpenAI-compatible wire byte budget 检查，保持在模型工具
description 上限内；更长的安全/选择信息没有复制进全局 prompt，而是按 Tool 放入同一
registration 的 guidance 并压缩到 wire contract 可接受长度。

## 第三阶段：Tool Calling execution semantics

### 解析与校验流水线

实际执行路径现在是：

```text
LLM response
  -> OpenAI-compatible adapter Tool Call Parser
       -> provider-facing JSON decode
       -> only trailing-comma repair outside JSON strings
       -> existing public LLMToolCall schema
  -> Agent/Core receives provider-independent Tool call
  -> ToolBatchCoordinator / ToolDispatcher
  -> ToolPreflight
       -> active immutable registry resolve
       -> clone caller args
       -> schema-directed numeric string normalization
       -> strict compiled schema validation
       -> max invocation argument byte check
  -> durable REQUESTED
  -> existing Security Gate / Approval check
  -> durable RUNNING and tool.started
  -> Handler through existing Runtime execution port
  -> output schema validation and result sanitization
  -> Observation and terminal durable event
  -> Tool result projection
  -> Agent loop continuation
```

`validateToolArguments()` 是所有 Dispatcher dispatch/recovery 输入的统一入口。
它返回 deep-frozen `NormalizedArguments`，不会 mutate caller input。唯一允许的自动
修正是：当 schema 明确声明目标字段为 `integer` 或 `number` 时，将严格十进制数字
字符串转换成 finite number；转换失败仍会 validation error。

允许的 parser repair 只有：字符串外、结构结束符之前的 trailing comma。例如
`{"limit": 20,}` 可以进入正常 schema validation。不会修复 unquoted key、single
quote、缺失 required field、截断结构、unknown field、command 内容、path、patch、
enum、boolean 或字符串内容。

`ToolValidationError` 只携带 bounded schema issue path/message，转换成
model-recoverable Observation，例如：

```text
Tool exec_command failed validation: timeout_ms must be a number.
Correct the tool arguments before calling it again.
```

实际当前 `exec_command` 并不接受 `timeout_ms`；该例只表示统一错误格式。真实 schema
错误会指出对应的已声明字段。invalid args 不会调用 handler，也不会让 Run 直接崩溃。

### Preflight authority 划分

新增的 `ToolPreflight` 负责 registry resolution、参数 clone/normalization、schema
validation 和 invocation byte bound。它不复制下列既有 authority：

- workspace lexical/realpath containment、symlink 检查和文件类型检查仍由 Runtime
  `WorkspacePathResolver` / Runtime file APIs 执行；
- Git repository availability 和 Git operation semantics 仍由 Runtime Git service
  及现有 Tool exposure 处理；
- dangerous command、sensitive resource、capability、permission 和 approval 仍由
  Security Gate 处理。

这是有意的边界保护：把这些检查复制进 Tools 会产生第二个 Security/Runtime authority，
与本轮“不要修改 Security Authority / Runtime Authority”的要求冲突。

### Tool failure 与恢复

普通 `ToolExecutionResult.isError === true` 仍是 model-recoverable Tool failure：

1. durable invocation/observation/terminal event 正常落库；
2. observation 的 `content` 反馈给 Agent；
3. Agent 可以修改参数或选择另一个 native Tool；
4. Batch 的后续普通 Tool 项仍遵循既有顺序语义；
5. uncertainty、Dispatcher infrastructure failure、output-contract failure 仍按
   既有 fail-closed 语义处理。

新增 `ToolFailureMemory` 是 host-only、bounded、TTL-limited 内存。每条 entry 只存：

- `runId`
- `toolName`
- canonical arguments 的 SHA-256 fingerprint
- bounded stable failure code
- first/last timestamp
- repeat count

它不存 raw args、command、patch、prompt、credentials、stdout/stderr 或 hidden
reasoning。当前 Dispatcher 对同一 Run、同一 Tool、同一 canonical args 和同一
model-recoverable handler failure code 的再次调用，会创建一个新的安全 observation，
告知 Agent 修改参数或选择另一 Tool，但不会再次执行 handler。不同参数仍可尝试；TTL
到期后 entry 被清除；每 Run entry 数有上限。

这层 memory 不会拦截 Security denial、approval wait 或 uncertain side effect，避免
把不同 authority 的失败混成可自动重试的输入错误。已有 ResourceGovernor 的
no-progress/replan 行为保持不变，ToolFailureMemory 不创建新的 Storage table 或
持久化状态模型。

## 第四阶段：Bash / Shell Tool Report

### 保留的 name 与兼容性决定

现有 canonical name 是 `exec_command`，continuation tool 是 `write_stdin`。没有把
`exec_command` 改成 `bash` 或 `shell_execute`，也没有增加 alias。

原因是 Tool name 同时参与 model catalog、ToolDefinition、Dispatcher resolution、
durable invocation identity、Security facts/approval key、Tool result continuation
和既有测试。直接改名会破坏历史调用与恢复身份，alias 也会制造 model name 与 runtime
name 的双源风险。因此本轮只升级 contract/guidance，不破坏旧 API。

### 升级前后

升级前的模型可见 `exec_command` contract 已有 `cmd`、`workdir`、`tty` 和
`yield_time_ms`，执行由固定平台解析器和 managed process manager 负责，但缺少统一
Dispatcher-level argument normalization、safe failure memory 和足够明确的 model
selection guidance。

升级后：

- `cmd` 仍为 required non-empty string；不会自动改写 command；
- `workdir` 明确为 workspace-relative，默认 `.`；最终 containment 仍由 Runtime；
- `tty` 明确为 boolean，默认 false；
- `yield_time_ms` 明确为观察等待，范围 250–30000 ms，默认 10000；它不是 timeout、
  kill 或 cancellation；
- 参数先经统一 ToolPreflight，再进入 durable REQUESTED/Gate/RUNNING；
- command execution 仍走 `RuntimeExecService → LocalProcessManager → pipe/PTY`；
- `write_stdin` 保持既有 owner-Run/session semantics，并得到同样的 schema/default/
  guidance 处理；
- non-zero exit/signal exit 仍按 Phase 8C 的正常结果语义处理；不确定 side effect
  仍进入 uncertainty barrier，不自动重跑。

用户要求示例中的 `timeout_ms`、`background`、`shell` 没有加入模型 schema。原因是
仓库现行 Phase 8C contract 明确禁止模型控制 arbitrary shell、timeout、background、
env 或 sandbox 参数；Run deadline、fixed platform shell resolution 和 process
management 分属 Core/Runtime authority。为了保持该边界，本轮采用可兼容的最小强化，
没有把未来语义伪装成当前可用字段。

### Dangerous command

`rm`、format/delete、credential modification 等危险动作仍会通过 existing Security
Gate/approval path，不由 ToolPreflight 自己决定。这样危险操作仍以 canonical
approval request、existing permission profile 和 existing Security facts 为准；本轮
没有降低或重画 approval authority。

## 第五阶段：Safe Tool-calling debug

daemon 仅在以下环境变量精确为 `1` 时注入 debug writer：

```ini
CAELUSH_DEBUG_TOOL_CALLING=1
```

debug event 只允许包括：

- Tool name
- sorted argument key names
- argument byte count
- validation PASS/FAIL
- normalization UNCHANGED/SAFE_NUMERIC_CONVERSION/NOT_APPLIED
- preflight state
- Gate category（ALLOW/DENY/REQUIRE_APPROVAL）
- execution state（STARTED/COMPLETED/MODEL_ERROR/BLOCKED）

不包括 raw argument、command、patch、prompt、provider response、stdout/stderr、API
key、credentials、secret 或 hidden reasoning。debug writer 是 best-effort；writer
异常不会改变 Tool execution semantics。

## 第六阶段：Real Agent Execution Report

新增脚本：

[scripts/phase-13f-tool-contract-hardening.mjs](D:/Develop/Caelush/scripts/phase-13f-tool-contract-hardening.mjs)

脚本支持以下配置，并且不会把 key 写入文件或输出：

```ini
CAELUSH_PROVIDER_ID=deepseek
CAELUSH_PROVIDER_BASE_URL=https://api.deepseek.com
CAELUSH_PROVIDER_API_KEY=<runtime-only>
CAELUSH_DEFAULT_PROVIDER=deepseek
CAELUSH_DEFAULT_MODEL=deepseek-v4-flash
```

其中 `CAELUSH_DEFAULT_PROVIDER` 是现有 daemon configuration 的配对配置；脚本本身
直接构造 DeepSeek model selection，保留该变量是为了 production daemon 命令行配置
一致。

脚本在临时 fixture 中准备四个隔离任务：

1. workspace structure：要求 Agent 使用 `list_directory`/`find_files`/必要的
   `read_file`，不以 shell 代替 native inspection；
2. dependency analysis：要求读取 `package.json`，期望 `read_file` 而不是
   `bash cat`/`exec_command`；
3. test execution：要求使用 `exec_command` 执行测试并报告结果；
4. dangerous delete：要求删除指定测试 fixture，并观察是否进入 approval；脚本只对
   自己创建的临时 fixture 自动 resolve pending approval，用于验证 approval path。

本次实际执行命令为：

```text
node scripts/phase-13f-tool-contract-hardening.mjs
```

脱敏结果为：

```json
{
  "status": "SKIPPED",
  "reason": "CAELUSH_PROVIDER_API_KEY_MISSING",
  "env": {
    "CAELUSH_PROVIDER_ID": "MISSING",
    "CAELUSH_PROVIDER_BASE_URL": "MISSING",
    "CAELUSH_PROVIDER_API_KEY": "MISSING",
    "CAELUSH_DEFAULT_MODEL": "MISSING"
  },
  "configuredModel": "deepseek-v4-flash"
}
```

脚本退出码为 0，因为 `SKIPPED` 是已识别的外部条件，不是实现测试成功。由此：

- native Tool selection、真实 DeepSeek tool-call stability、重复失败行为和真实
  approval round-trip 在本环境尚未取得 credentials-backed evidence；
- 本报告不把 mocked/injected provider tests 或 local full suite 当作真实 DeepSeek
  成功；
- 提供 key 后可用上述脚本重新运行，脚本只保留安全 summary，不输出 key、prompt、
  raw arguments 或 model text。

## 第七阶段：验证证据

本轮最终运行结果：

| Command                                              | Result                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm lint`                                          | PASS，eslint exit 0                                             |
| `pnpm typecheck`                                     | PASS，包含 workspace build 和所有 package typecheck，exit 0     |
| `pnpm test -- --reporter=dot`                        | PASS，385 test files；1454 passed，5 skipped，1459 total        |
| `pnpm check`（第二次完整运行）                       | lint/typecheck/test/build 通过，最终仅在 format baseline 退出 1 |
| 聚焦 Phase 13F tests                                 | PASS，10 files / 77 tests                                       |
| `pnpm exec vitest run ... -u`（wire snapshot）       | PASS，受控 inline snapshot 更新 1 项                            |
| `pnpm exec prettier --check`（changed files）        | PASS，所有变更文件格式正确                                      |
| `git diff --check`                                   | PASS，无 whitespace error                                       |
| `node scripts/phase-13f-tool-contract-hardening.mjs` | SAFE SKIPPED，缺少 provider key                                 |

`pnpm format:check` 和包含它的 `pnpm check` 还会触发仓库既有的全局格式基线问题：
当前工作区报告 `Code style issues found in 820 files`。本轮没有使用全局
`prettier --write` 改写这些无关文件；变更文件自身已经通过 targeted Prettier check。
因此最终状态应准确表述为：

- lint/typecheck/build/full test 和本轮变更文件格式检查通过；
- 第二次完整 `pnpm check` 的 full `format:check` 被既有 820-file formatting
  baseline 阻断，而非被本轮 TypeScript、测试或 lint 错误阻断。
- 第一次完整 `pnpm check` 的全量测试曾出现一次 timing-sensitive 的既有
  `packages/runtime/test/process-manager.test.ts` 快速进程断言波动；未改 Runtime，
  随后的单文件 7/7 复跑、第二次完整 385-file 测试和本轮安全整数修复后的最终
  385-file 测试均通过，因此没有将其作为本轮代码回归处理。

## 第八阶段：参考设计吸收

本轮参考了公开实现中的以下设计方向，并按 Caelush 现有 Phase boundary 做了适配：

- [OpenAI Codex tool router](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs)：集中 dispatch、工具调用状态和错误路径；
- [OpenAI Codex base instructions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)：tool selection 和安全使用 guidance 不只是功能名；
- [OpenAI Codex apply_patch instructions](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/apply_patch_tool_instructions.md)：mutation tool 需要明确输入格式和边界；
- [Pi coding-agent system prompt](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts)：区分 read/search/edit/execute 场景并给出模型选择语义；
- [Pi bash tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)：把执行输出、session 和 process continuation 作为明确的 Tool contract；
- [OpenCode bash tool](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/bash.ts)：shell tool 的调用条件、输出和错误应对模型可恢复；
- [OpenCode session design](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md)：执行 session 和 agent loop continuation 需要独立、可恢复的语义；
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)：高风险动作需沿 permission/approval policy 处理；
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)：工具说明应覆盖适用场景和行为，而不是只有一句功能介绍。

吸收后的实现没有复制这些项目的 provider、runtime 或 permission architecture，避免
越过 Caelush 既有 authority boundaries。

## 变更文件摘要

主要变更集中在：

- `packages/llm/src/providers/openai-compatible/tool-call-parser.ts`
- `packages/llm/src/providers/openai-compatible/stream.ts`
- `packages/tools/src/argument-validation.ts`
- `packages/tools/src/preflight.ts`
- `packages/tools/src/tool-failure-memory.ts`
- `packages/tools/src/debug.ts`
- `packages/tools/src/dispatcher.ts`
- `packages/tools/src/model-guidance.ts`
- `packages/tools/src/registry-builder.ts`
- 九个 built-in Tool definition/guidance schema
- `apps/daemon/src/daemon-composition.ts`
- `apps/daemon/src/daemon.ts`
- Phase 13F focused tests、wire snapshot 和 real-provider runner
- 本报告及对应 implementation plan

没有修改 `packages/security` 或 `packages/runtime` 的 authority implementation，也
没有修改 `packages/core` / `packages/protocol` contract。

## Known Limitations

1. 当前环境没有 DeepSeek API key，四类 credentials-backed real-agent acceptance
   尚未完成；需要在运行环境中临时注入 key 后重跑脚本。
2. 当前 ToolFailureMemory 是 host-only ephemeral memory，不是跨进程、跨 daemon
   restart 的 durable memory；这是有意避免新 Storage model，也符合当前 recovery/
   uncertainty boundary。
3. failure memory 记录的是稳定的通用 failure code，而不是 raw handler error；这会
   换取安全性和稳定性，模型要获得下一步建议依赖 model-facing observation，而不是
   内部异常文本。
4. 本轮只做 trailing-comma parser repair 和 schema-directed numeric string
   conversion；unquoted keys、single quotes、缺失字段、截断 JSON、未知字段删除和
   command 内容猜测仍会 fail closed。
5. `timeout_ms`、`background`、`shell` 没有加入 `exec_command` model schema，因
   Phase 8C 明确禁止模型控制这些 Runtime/process 选项；`yield_time_ms` 不是 timeout。
6. `pnpm check` 的全局 `format:check` 仍受 820 个既有文件格式基线问题影响。本轮
   没有扩大范围格式化，也没有把该 baseline failure 隐瞒为完全绿色。
7. 本轮没有实现 retry/backoff、Run timeout、cancellation、parallel execution、
   Verification execution、COMPLETED transition、MCP、RAG 或 Phase 14 能力；这些
   均超出本轮边界。

## 最终判定

实现层面的 Phase 13F Tool Contract Reliability & Execution Semantics Hardening 已
完成并通过本地代码验收；真实 DeepSeek 这一项因为外部凭证缺失而保持未验收状态。
提交时应保留上述分层结论：本轮没有伪造 provider 证据，也没有为了满足 schema 示例
而突破 Phase 8C、Security Authority 或 Runtime Authority。
