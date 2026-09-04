# Caelush V1 Agent Loop / Native Tool Calling Contract Audit

审计日期：2026-09-04
分支：`codex/v1-agent-loop-tool-contract-audit`
范围：Agent Loop、OpenAI-compatible Native Tool Calling、Tool Registry/Dispatcher、模型指导、Git/工作区语义、Web 决策摘要与安全诊断。
首个远端交付检查：`LOCAL_TASK_SHA=REMOTE_TASK_SHA=0190dcb2c8d6258644fd21e5960a49c47fc020f1`
明确不在本轮范围：Verification 重构、Phase 14、MCP、RAG、Skill、Sub-agent。

## A. Executive Verdict

结论：`PARTIALLY CONFIRMED`。

已确认的本轮契约：

- OpenAI-compatible Provider 通过真实 AI SDK / fetch SSE 路径能够解析 Native Tool Call。
- Provider 生成的 Tool Call 经过现有 Agent Loop、Tool Batch Coordinator、Tool Dispatcher 和 durable Observation 后，会以同一个 provider `toolCallId` 进入下一次 Provider request。
- ToolDefinition 与模型指导分离；九个内置 Tool 的定义、指导、解析器和 handler 来自同一 immutable registry。
- list-directory 使用显式 `.` 表示 workspace root；绝对路径保持 containment 拒绝。
- 非 Git workspace 的 Git Tool 返回安全的 `NOT_A_GIT_REPOSITORY` model-recoverable error；已知非 Git 或未知 Git capability 会从 active registry 中同时移除 Git definitions、guidance 和 executable resolution。
- Wire diagnostic 默认关闭，开启后只记录允许的结构化安全字段。
- Web 的确定性公开摘要名称为“决策摘要”，不再把它展示为隐藏推理。

未能确认的生产证据：本机没有 `DEEPSEEK_API_KEY`，所以真实 DeepSeek A/B 网络运行被安全标记为 `REAL_PROVIDER_TEST_BLOCKED`，没有用 fake Provider 冒充 live pass。最终全量 `pnpm check` 的唯一失败是既有仓库的 Prettier 全局基线（837 files），不是本轮新增功能测试失败。

## B. Actual Wire Contract

结论：`CONFIRMED`。

证据：

- `tests/integration/openai-compatible-wire-contract.test.ts`
- `packages/storage/test/agent-tool-round-trip-wire.test.ts`
- `packages/llm/test/openai-compatible-stream.test.ts`
- `packages/llm/test/wire-diagnostic.test.ts`

第一轮真实 OpenAI-shaped SSE 返回一个 `list_directory` Tool Call，调用 ID 为测试用的 `call-list-root`，参数是 `{"path":"."}`。请求经过：

`LLMGateway → OpenAICompatibleLLMProvider → @ai-sdk/openai-compatible → injected fetch → AgentLoop → ToolBatchCoordinator → ToolDispatcher → SQLite ToolInvocation/Observation`

第二轮 Provider request 同时包含：

- assistant 的 Native `tool_calls`，其中 function name 为 `list_directory`，ID 为 `call-list-root`；
- role `tool` 的结果，`tool_call_id` 仍为 `call-list-root`。

测试还确认 Tool 只执行一次，最终 Run 到达 `AWAITING_VERIFICATION`，没有由模型最终文本直接绕过 Verification/Completion Authority。

Wire characterization 只保存 Tool 名称、schema hash、message role/count 等安全投影；不保存 prompt、headers、authorization、Tool description、arguments 或 Tool output。Provider adapter 没有执行本地 Tool。

## C. Failed list_directory

结论：`CONFIRMED`（失败语义已收敛；“原先失败”由当前基线行为和新增回归测试覆盖）。

当前契约：

- `path: "."` 明确表示 workspace root。
- 返回 details 中的 `path` 为 `"."`，目录子项路径为 workspace-relative forward-slash 路径。
- absolute path 经过 `WorkspacePathResolver` containment 检查，返回 `PATH_OUTSIDE_WORKSPACE` 的安全 Tool error。
- 不依赖 `process.cwd()` 推断 workspace。

证据：`packages/tools/test/read-only-filesystem-tools.test.ts`。新增测试在临时 workspace 创建 `README.md`，验证 `.` 能列出 root，同时验证绝对路径被拒绝。模型指导位于 `packages/tools/src/model-guidance.ts`，明确要求 root 使用 `.`、分页读取并禁止将目录列表误当作文件内容。

## D. Failed git_status

结论：`CONFIRMED`。

非 Git workspace 的 `git_status` 和 `git_diff` 都返回：

```text
isError: true
details.ok: false
details.error: NOT_A_GIT_REPOSITORY
```

该错误经 Runtime Git repository discovery 的 typed `RuntimeGitError` 进入 `withRuntimeScope` 的 model-facing error mapping；没有把 stderr、绝对路径、环境变量或 Git 内部命令文本暴露给模型。

证据：

- `packages/runtime/test/git-runtime.test.ts`
- `packages/tools/test/git-tools.test.ts`
- `packages/tools/src/builtins/result.ts`
- `packages/runtime/src/git/repository.ts`
- `packages/runtime/src/git/errors.ts`

正常 Git 命令的 non-zero exit 与“不是 Git 仓库”保持不同：前者仍按 Git command failure 处理，后者稳定映射为 `NOT_A_GIT_REPOSITORY`。模型指导要求在该错误下停止 Git-specific probing，而不是重复相同调用。

## E. Tool Schema Matrix

结论：`CONFIRMED`。

最终默认 active catalog 的顺序为：

| Tool | Model definition | Model guidance | Runtime handler / resolver | Root / error note |
|---|---:|---:|---:|---|
| `read_file` | yes | yes | same registry | bounded UTF-8, relative file path |
| `list_directory` | yes | yes | same registry | `.` is workspace root |
| `find_files` | yes | yes | same registry | bounded relative glob |
| `search_text` | yes | yes | same registry | bounded regex; recoverable invalid pattern |
| `apply_patch` | yes | yes | same registry | mutation only for requested changes |
| `exec_command` | yes | yes | same registry | explicit local command only |
| `write_stdin` | yes | yes | same registry | owned process session only |
| `git_status` | yes when Git available | yes when active | same registry | hide on unavailable/unknown Git capability |
| `git_diff` | yes when Git available | yes when active | same registry | bounded read-only diff |

`ToolModelGuidance` 是独立的数据合同，不进入 Provider ToolDefinition schema，也不泄漏 risk/capability/runtime metadata。Registry build boundary 会复制、校验并冻结 guidance；`modelGuidance()`、`modelDefinitions()` 与 `resolve()` 的 active projection 保持同一顺序和集合。

非 Git/unknown exposure 证据：`packages/tools/test/tool-exposure.test.ts` 和 `apps/daemon/test/daemon-composition.test.ts`。安全组合层按 active registry 校验 security-facts coverage，避免过滤 Git Tool 后把“已隐藏 Tool”错误地当成缺少安全覆盖。

## F. System Prompt

结论：`CONFIRMED`。

`apps/daemon/src/daemon-composition.ts` 的 `DEFAULT_CORE_AGENT_POLICY` 覆盖：

- active workspace 是唯一路径根；workspace root 使用 `.`；
- 先检查文件并收集 evidence，再做 claims 或 mutation；
- read-only 工作不调用 mutation Tool；
- Tool errors 是 observations；可恢复输入应修正；不重复相同失败；不调用不适用 Tool；
- mutation 后重新读取受影响文件和 diff；
- evidence 足够时停止，阻塞和不确定性要明确报告；
- 不请求、不泄漏 hidden chain-of-thought，也不伪造 evidence。

证据：`apps/daemon/test/agent-policy.test.ts`。该 policy 是短的默认 daemon system prompt；项目指令、相关文件上下文和 durable conversation 仍遵守现有 synthetic-vs-durable boundary。

## G. Real DeepSeek Run

结论：`PARTIALLY CONFIRMED`，live 部分为 `REAL_PROVIDER_TEST_BLOCKED`。

入口脚本：`scripts/agent-loop-tool-contract-audit.mjs`。它创建两个 bounded fixture：

- Git workspace：包含要求的 `package.json`、`pnpm-workspace.yaml`、`README.md`、`apps/web/src/main.ts`、`apps/api/src/server.ts`、`packages/shared/src/index.ts`，并执行真实 `git init/add/commit`；
- Non-Git workspace：同一 fixture 内容但无 Git repository。

两种情况均使用 daemon composition / RunController product entry，Run 的 `maxSteps` 为 12；只读取 safe status、active tool names、LLM turn count、Tool name/status 和 public error code。脚本不会打印 API key、URL 内容、prompt、arguments、stdout/stderr 或 hidden reasoning。

本次预检实际输出为：

```json
{"status":"SKIPPED","reason":"DEEPSEEK_API_KEY_MISSING","env":{"DEEPSEEK_API_KEY":"MISSING","DEEPSEEK_BASE_URL":"MISSING","DEEPSEEK_MODEL":"MISSING"}}
```

对应测试：`apps/daemon/test/agent-loop-tool-contract-real-provider.test.ts`。它确认环境变量输出只能是 `PRESENT`/`MISSING`，没有用 fallback fixture Provider 替代真实 DeepSeek。凭据存在时，该测试会在 180 秒上限内运行脚本，并断言每个 fixture 的 Provider turns 不超过 12；本机没有凭据，故该 live branch 未执行。

因此：真实 provider wire path 已由 Task 2/3 的 injected-fetch SSE characterization 确认；真实 DeepSeek credentials-backed product run 必须在配置凭据的环境重新执行。

## H. Reasoning UI

结论：`CONFIRMED`。

`reasoning.summary` 的内容仍来自现有 deterministic public summary 事件，Web `Timeline` 现在将 `REASONING` 显示为“决策摘要”，而不是“推理摘要”。没有新增 raw model answer、Tool arguments、Tool output 或 hidden reasoning 的客户端字段。

对于 Tool failure，客户端只展示安全的 public error code/reason；原始 Tool text/detail 仍由既有 presentation filtering 拦截。现有测试继续验证 raw stdout 和 raw Tool output 不渲染；本轮 `apps/web/test/timeline.test.tsx` 更新并确认“决策摘要”标签。

Provider timing 与 deterministic summary 是两个边界：`LLMGateway` 的 opt-in wire diagnostic 记录 Provider request/response duration；它不把 UI summary 的生成时间冒充模型耗时。

## I. Security

结论：`CONFIRMED`，live secret-dependent branch 除外。

安全诊断：

- 环境变量 `CAELUSH_DEBUG_MODEL_WIRE` 不为 `1` 时不创建 diagnostic。
- 开启时只允许 provider、model、call ID、message roles、Tool names、finish reason 和 duration 等结构化字段。
- 不包含 authorization/API key、system/user prompt、Tool description、Tool args、Tool output、raw SSE、stderr 或 hidden reasoning。
- Diagnostic sink 是显式注入的 writer；daemon 默认不把 raw provider payload 写入日志。

Registry 与 Tool boundary：

- model catalog 与 executable handler 来自同一个 immutable registry；
- Tool Dispatcher 仍是唯一执行边界；Provider 不执行本地 Tool；
- filtered registry 不会留下“模型不可见但 resolver 可执行”的 Git Tool；
- non-Git 错误是 model-recoverable safe code，而非未经清洗的 Runtime/Git exception text。

证据：`packages/llm/test/wire-diagnostic.test.ts`、`tests/integration/openai-compatible-wire-contract.test.ts`、`packages/tools/test/tool-exposure.test.ts`、`packages/security/test/secure-composition.test.ts`、`tests/architecture/phase-12a-boundaries.test.ts`。

## J. Tests

结论：`PARTIALLY CONFIRMED`。

聚焦验证通过：

- OpenAI-compatible wire contract：`2 passed`；
- Provider round trip：`1 passed`；
- model guidance / exposure / daemon policy / composition：`11 passed` 及相关聚焦集合；
- Git/root semantics：`6 passed`；
- safe wire diagnostic / Web timeline：`5 passed`；
- real-provider preflight：`2 passed`（live branch 因凭据缺失安全跳过）。

完整 `pnpm check` 结果：

- ESLint：通过；
- build：通过；
- root 与所有 workspace typecheck：通过；
- full Vitest：`382` test files passed，`1438` tests passed，`5` skipped；
- Prettier：失败，仓库现有全局格式基线报告 `837 files` 有 style issues，覆盖大量本轮未触及的 app/package/docs 文件，也包含新增文件。

额外执行：`git diff --check` 通过；architecture boundary targeted run 通过；当前代码无深层跨 package import 回归（Task 2 集成测试已改用 `@caelush/runtime`、`@caelush/tools`、`@caelush/llm` 公共入口）。

## K. Known Separate Blocker

结论：`CONFIRMED`。

存在两个与本轮 Agent Loop / Tool contract 结论分离的门禁阻断：

1. Prettier 全局检查：`pnpm check` 的最后一步对整个仓库执行 `prettier --check .`，当前基线有 837 个文件未符合其格式化输出。若要清除它，需要另一个专门的全仓格式化变更，不应在本轮无关地重写用户文件。
2. DeepSeek live A/B：本机 `DEEPSEEK_API_KEY` 缺失，因此无法声称真实 credentials-backed DeepSeek product run 通过。脚本、fixture、12-turn guard 和安全输出测试已就绪；需要在提供真实凭据的环境运行 `node scripts/agent-loop-tool-contract-audit.mjs` 或对应 Vitest test。

本轮没有修改 Verification、没有引入 Phase 14、MCP、RAG、Skill 或 Sub-agent 能力，也没有合并 `master`。

READY FOR AGENT LOOP / TOOL CALLING MANUAL REVIEW
