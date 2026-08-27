# Caelush V1 技术架构设计文档

**文档版本：** V1.0  
**对应产品版本：** Caelush V1  
**文档类型：** Technical Architecture Design / TAD  
**产品形态：** CLI + Web  
**核心定位：** 通用、模型无关、Runtime 可插拔、Tool 可扩展、过程可观察的基础 Agent Kernel  
**架构原则：** CLI/Web 共核、自研 Agent Loop、统一 Tool System、统一 Runtime、Event Driven、真实 Verification、安全边界明确

---

# 1. 文档目的

本文档用于冻结 Caelush V1 的第一版技术架构。

它主要解决以下问题：

1. Caelush 的核心模块应该如何拆分；
2. CLI 与 Web 如何真正共用一个 Agent Core；
3. Agent Loop 应该如何运行；
4. Agent State 如何存储；
5. Tool 如何注册、校验、审批和执行；
6. Runtime 如何抽象；
7. Workspace 与权限边界如何实现；
8. Shell 与长期 Process 如何运行；
9. Context 如何构建并限制膨胀；
10. Verification 如何判断任务是否真正完成；
11. Cancellation 如何真正终止正在进行的操作；
12. Event Stream 如何同时驱动 CLI、Web 和 Trace；
13. 数据库需要保存哪些核心实体；
14. API 如何设计；
15. 后续 Docker Runtime、SSH Runtime、Skill、MCP、Browser、Multi-Agent 如何在不重写 Kernel 的情况下扩展。

本文档一旦进入开发阶段，应作为 Caelush V1 的架构基线。

除非出现明确的架构缺陷，不建议在开发过程中随意改变核心协议。

---

# 2. Caelush V1 一句话技术定义

Caelush V1 是一个运行于本地设备上的 Agent Runtime。

用户通过 CLI 或 Web 向 Caelush 提交目标。

Caelush 将目标转换为一个 Agent Run，并通过：

```text
Context
↓
LLM
↓
Tool Call
↓
Permission
↓
Runtime
↓
Observation
↓
Verification
```

持续循环执行，直到：

```text
任务完成
任务失败
达到限制
用户取消
发生不可恢复错误
```

整个运行过程统一生成 AgentEvent。

CLI、Web、日志和 Trace 均基于同一条 Event Stream 工作。

---

# 3. V1 核心架构决策

Caelush V1 冻结以下关键技术决策。

| 架构项 | V1 决策 |
|---|---|
| 主语言 | TypeScript |
| Runtime | Node.js 24 LTS |
| Package Manager | pnpm |
| Monorepo | pnpm workspace |
| Agent Loop | Caelush 自研 |
| LLM 适配 | Caelush LLMProvider + AI SDK |
| Schema | Zod |
| API Server | Fastify |
| Web | React + Vite |
| CLI | Ink |
| 数据库 | SQLite |
| ORM | Drizzle |
| Event Streaming | SSE |
| 普通 Shell | child_process.spawn |
| 长期进程 | node-pty |
| 文本搜索 | ripgrep |
| 文件 Glob | fast-glob |
| Git | git CLI |
| Web Search | Provider Adapter |
| Web Fetch | fetch + Readability |
| 日志 | Pino |
| Trace | Caelush 自研 RunTrace |
| Test | Vitest |
| Cancellation | AbortController / AbortSignal |
| V1 Sandbox | Local Logical Guard |
| 强隔离 Sandbox | 后续 DockerRuntime |

---

# 4. 最重要的总体架构

Caelush 不采用：

```text
CLI
↓
一个 Agent

Web
↓
另一个 Agent
```

而采用：

```text
                 Caelush CLI
                      │
                      │
                      ▼
                HTTP / SSE
                      │
                      │
┌─────────────────────┴─────────────────────┐
│                                           │
│         Caelush Local Agent Service       │
│                                           │
│ Session API                               │
│ Run API                                   │
│ Approval API                              │
│ Event Stream                              │
│ Workspace API                             │
│ Model Config API                          │
│                                           │
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌───────────────────────────────────────────┐
│              Caelush Kernel               │
│                                           │
│ RunController                             │
│ SessionManager                            │
│ AgentLoop                                 │
│ AgentState                                │
│ ContextBuilder                            │
│ VerificationManager                       │
│ RetryController                           │
│ BudgetManager                             │
│                                           │
└───────────────┬───────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
┌───────────────┐  ┌──────────────────────┐
│  LLM Gateway  │  │     Tool System      │
│               │  │                      │
│ LLMProvider   │  │ ToolRegistry         │
│ Providers     │  │ ToolDispatcher       │
│ Streaming     │  │ Permission           │
└───────────────┘  │ Approval             │
                   └──────────┬───────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │       Runtime        │
                   │                      │
                   │ Runtime Interface    │
                   │ LocalRuntime         │
                   │ ProcessManager       │
                   └──────────┬───────────┘
                              │
               ┌──────────────┼───────────────┐
               ▼              ▼               ▼
          Filesystem         Shell            Git
               │              │               │
               └──────────────┼───────────────┘
                              ▼
                             OS


所有模块
   │
   ▼

EventBus
   │
   ├── CLI
   ├── Web SSE
   ├── RunTrace
   ├── Storage
   └── Debug Log
```

---

# 5. 为什么增加 Caelush Local Agent Service

这是 V1 最重要的架构调整之一。

CLI 和 Web 都不直接拥有独立的 Agent Runtime。

真正执行任务的是：

```text
Caelush Local Agent Service
```

它可以理解为：

> Caelush 在用户电脑上运行的本地 Agent 后台服务。

例如：

```text
127.0.0.1:43120
```

CLI：

```text
caelush
```

实际上连接：

```text
localhost:43120
```

Web：

```text
http://localhost:43120
```

或者由 Local Service 提供静态 Web 页面。

这样一个 Run：

```text
run_01JXYZ
```

可以同时被：

```text
CLI
Web
```

观察。

两者看到完全一致的：

```text
Run State
Agent Event
Shell Output
File Diff
Approval
Verification
```

---

# 6. V1 推荐 Monorepo 结构

```text
caelush/
│
├── apps/
│   │
│   ├── daemon/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── cli/
│   │   ├── src/
│   │   └── package.json
│   │
│   └── web/
│       ├── src/
│       └── package.json
│
├── packages/
│   │
│   ├── protocol/
│   │
│   ├── core/
│   │
│   ├── llm/
│   │
│   ├── context/
│   │
│   ├── tools/
│   │
│   ├── runtime/
│   │
│   ├── security/
│   │
│   ├── verification/
│   │
│   ├── events/
│   │
│   ├── storage/
│   │
│   ├── observability/
│   │
│   └── shared/
│
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
│
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── README.md
```

---

# 7. Package 职责边界

## 7.1 packages/protocol

这是整个项目中最应该保持稳定的 Package。

负责定义：

```text
AgentSession
AgentRun
AgentStep

AgentEvent

ToolDefinition
ToolInvocation
Observation

ApprovalRequest

VerificationResult

API DTO

SSE Event Protocol
```

原则：

> CLI、Web、Daemon、Core 必须依赖同一套 Protocol。

禁止：

```text
Web 自己定义一套 RunStatus
CLI 自己定义一套 AgentEvent
Core 又定义第三套
```

---

# 8. packages/core

负责 Agent Kernel。

主要包含：

```text
RunController
SessionManager
AgentLoop
AgentStateManager
RunExecutionContext
RetryController
BudgetManager
```

Core 不应该：

```text
直接访问 React

直接执行 child_process

直接访问 SQLite SQL

直接调用 OpenAI SDK

直接解析 Web 页面
```

Core 只面向抽象接口。

---

# 9. packages/llm

负责模型层。

```text
LLMProvider
LLMGateway
ModelRegistry
ProviderConfig
TokenUsage
ToolCall Parser
Streaming
```

未来：

```text
OpenAI
Anthropic
Gemini
DeepSeek
Qwen
OpenAI Compatible
Local Model
```

全部通过该模块接入。

---

# 10. packages/context

负责：

```text
ContextBuilder
EnvironmentDetector
ProjectDetector
ContextBudget
ObservationCompactor
FileContextManager
```

这个模块决定：

> 每一轮 LLM 到底看到什么。

---

# 11. packages/tools

负责：

```text
ToolDefinition
ToolRegistry
ToolDispatcher
Built-in Tools
```

内置工具：

```text
filesystem/
shell/
process/
git/
web/
system/
```

---

# 12. packages/runtime

负责：

```text
Runtime Interface
LocalRuntime
ProcessManager
ShellExecutor
```

未来增加：

```text
DockerRuntime
SSHRuntime
RemoteRuntime
```

AgentLoop 不需要改变。

---

# 13. packages/security

负责：

```text
PermissionManager
CapabilityManager
ApprovalManager
PathGuard
CommandGuard
SecretDetector
SecretRedactor
```

---

# 14. packages/verification

负责：

```text
VerificationManager
VerificationPlanner
VerificationRunner
Project Verification Profiles
```

---

# 15. packages/events

负责：

```text
EventBus
EventStore
EventSubscription
EventReplay
```

---

# 16. packages/storage

负责所有持久化。

提供 Repository：

```text
SessionRepository
RunRepository
StepRepository
EventRepository
ToolInvocationRepository
ApprovalRepository
FileChangeRepository
VerificationRepository
LLMCallRepository
```

Core 不直接写 SQL。

---

# 17. packages/observability

负责：

```text
RunTrace
Structured Log
Metrics Hook
Debug Trace
```

未来：

```text
OpenTelemetryAdapter
```

可以从这里扩展。

---

# 18. Kernel 依赖方向

必须严格遵循：

```text
protocol
   ↑
   │
core
   ↑
   │
context
tools
security
verification

runtime
storage
llm

apps/daemon

apps/cli
apps/web
```

更准确地说：

```text
Core
```

可以依赖接口：

```text
LLMProvider
Runtime
Storage
EventBus
```

但不能依赖具体实现：

```text
OpenAIProvider
SQLiteStorage
LocalRuntime
```

这些具体实现由 Daemon 启动时注入。

---

# 19. Dependency Injection

V1 不需要大型 DI 框架。

可以使用显式 Constructor Injection。

例如：

```ts
new RunController({
  llmGateway,
  toolDispatcher,
  contextBuilder,
  verificationManager,
  storage,
  eventBus,
  runtime,
});
```

这样依赖关系非常直观。

不建议第一版引入：

```text
复杂 IoC Container
Decorator DI
Reflection
```

---

# 20. 核心实体模型

Caelush V1 至少包含：

```text
AgentSession
AgentRun
AgentStep
AgentState
AgentEvent

ToolDefinition
ToolInvocation
Observation

Workspace
Runtime

PermissionProfile
ApprovalPolicy
ApprovalRequest

ProcessSession
FileChange

VerificationResult

LLMCall

RunTrace
```

---

# 21. AgentSession

Session 表示一次持续对话。

建议字段：

```ts
interface AgentSession {
  id: string;

  title?: string;

  createdAt: Date;
  updatedAt: Date;

  activeWorkspaceId?: string;

  modelConfigId?: string;

  metadata: Record<string, unknown>;
}
```

一个 Session：

```text
Session
 ├── Message
 ├── Run
 ├── Message
 ├── Run
 └── Run
```

---

# 22. AgentRun

一次用户目标对应一个 Run。

例如：

```text
修复当前项目 build 错误
```

建议：

```ts
interface AgentRun {
  id: string;
  sessionId: string;

  goal: string;

  status: RunStatus;

  workspace: WorkspaceSnapshot;

  model: ModelSnapshot;

  runtime: RuntimeSnapshot;

  permissionProfile: PermissionProfile;
  approvalPolicy: ApprovalPolicy;

  currentStep?: number;

  maxSteps: number;
  maxToolCalls: number;

  startedAt?: Date;
  finishedAt?: Date;

  finalResult?: string;
}
```

---

# 23. RunStatus

冻结：

```ts
type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "MAX_STEPS_REACHED"
  | "BUDGET_EXCEEDED";
```

---

# 24. Run 状态机

```text
PENDING
   │
   ▼
RUNNING
   │
   ├──────────────→ WAITING_APPROVAL
   │                       │
   │                       ├── approve ──→ RUNNING
   │                       │
   │                       └── reject ───→ RUNNING / FAILED
   │
   ├──────────────→ VERIFYING
   │                       │
   │                       ├── pass ──→ COMPLETED
   │                       │
   │                       └── fail ──→ RUNNING
   │
   ├──────────────→ CANCELLED
   │
   ├──────────────→ TIMEOUT
   │
   ├──────────────→ MAX_STEPS_REACHED
   │
   ├──────────────→ BUDGET_EXCEEDED
   │
   └──────────────→ FAILED
```

---

# 25. AgentStep

Step 是 AgentLoop 的逻辑循环单位。

建议：

```ts
interface AgentStep {
  id: string;

  runId: string;

  sequence: number;

  status:
    | "RUNNING"
    | "COMPLETED"
    | "FAILED";

  reasoningSummary?: string;

  startedAt: Date;
  finishedAt?: Date;
}
```

注意：

> Step 不等于 Tool Call。

一次 Step 可以：

```text
LLM
↓
并行请求多个 Tool
```

因此：

```text
Step
 ├── ToolInvocation
 └── ToolInvocation
```

---

# 26. AgentState

AgentState 是当前 Run 的工作状态。

推荐：

```ts
interface AgentState {
  runId: string;
  sessionId: string;

  goal: string;

  status: RunStatus;

  workspace: WorkspaceSnapshot;

  environment: EnvironmentSnapshot;

  project?: ProjectProfile;

  plan: PlanItem[];

  currentStep: number;

  recentObservations: Observation[];

  changedFiles: FileChangeSummary[];

  activeProcesses: ProcessSummary[];

  verification: VerificationState;

  constraints: UserConstraint[];

  errors: AgentError[];

  usage: UsageState;

  updatedAt: Date;
}
```

注意：

AgentState 不应保存无限量原始 Tool 输出。

历史详细内容进入：

```text
EventStore
RunTrace
```

State 中只保存 Agent 当前工作真正需要的信息。

---

# 27. AgentLoop

AgentLoop 是整个 Caelush Kernel 的核心。

核心职责只有：

```text
获取当前状态
↓
构建 Context
↓
调用 LLM
↓
处理 LLM Decision
↓
调用 Tool
↓
形成 Observation
↓
更新 State
↓
决定继续或进入 Verification
```

AgentLoop 不直接：

```text
读文件
执行 Shell
访问数据库
判断权限
操作 Git
```

---

# 28. AgentLoop 伪代码

```ts
while (!run.isTerminal()) {
  executionContext.throwIfAborted();

  budgetManager.assertWithinLimits();

  const context = await contextBuilder.build(state);

  const response = await llmGateway.stream(
    context,
    executionContext.signal
  );

  if (response.type === "tool_calls") {
    const observations =
      await toolDispatcher.dispatch(
        response.toolCalls,
        executionContext
      );

    state.applyObservations(observations);

    continue;
  }

  if (response.type === "final") {
    const verification =
      await verificationManager.verify(
        state,
        executionContext
      );

    if (verification.passed) {
      completeRun();
      break;
    }

    state.applyVerificationFailure(
      verification
    );

    continue;
  }
}
```

---

# 29. AgentLoop 不允许出现的代码

禁止：

```ts
if (tool.name === "read_file") {
  ...
}

if (provider === "openai") {
  ...
}

if (runtime === "docker") {
  ...
}
```

这些都说明抽象层被破坏。

---

# 30. RunController

AgentLoop 负责“怎么循环”。

RunController 负责“怎么管理 Run”。

职责：

```text
创建 Run
启动 Run
暂停等待 Approval
恢复 Run
取消 Run
结束 Run
处理 Fatal Error
维护 RunExecutionContext
```

---

# 31. RunExecutionContext

所有 Run 创建：

```ts
interface RunExecutionContext {
  runId: string;

  abortController: AbortController;

  signal: AbortSignal;

  deadlineAt?: number;

  permissionProfile: PermissionProfile;

  approvalPolicy: ApprovalPolicy;

  workspace: Workspace;

  runtime: Runtime;

  budget: RunBudget;
}
```

所有耗时操作必须接受：

```text
AbortSignal
```

---

# 32. Cancellation Tree

Caelush Stop 的正确结构：

```text
                 Run AbortController
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       LLM Call       Tool Call      Verification
                         │
                ┌────────┼─────────┐
                ▼        ▼         ▼
              Shell    Fetch     Process
```

用户：

```text
Stop
```

执行：

```text
RunController.cancel()
↓
abortController.abort()
↓
LLM abort
↓
Tool abort
↓
Shell kill
↓
Fetch abort
↓
Process cleanup
↓
确认资源释放
↓
status = CANCELLED
```

禁止只：

```text
run.status = CANCELLED
```

但后台进程仍在运行。

---

# 33. Agent Loop 运行限制

V1 至少：

```ts
interface RunBudget {
  maxSteps: number;
  maxToolCalls: number;

  maxTokens?: number;
  maxCost?: number;

  timeoutMs: number;
}
```

例如默认：

```text
maxSteps = 40

maxToolCalls = 100

timeout = 30 min
```

具体默认值后续根据真实测试调整。

---

# 34. LLM Gateway

Caelush Core 不直接调用模型 SDK。

统一：

```text
AgentLoop
↓
LLMGateway
↓
LLMProvider
↓
Provider Adapter
↓
AI SDK
↓
真实模型 API
```

---

# 35. LLMProvider Interface

建议：

```ts
interface LLMProvider {
  readonly id: string;

  getCapabilities(): LLMCapabilities;

  stream(
    request: LLMRequest,
    signal: AbortSignal
  ): AsyncIterable<LLMStreamEvent>;
}
```

Capabilities：

```text
tool_calling
parallel_tool_calls
streaming
reasoning_summary
max_context
vision
```

即使 V1 不使用 Vision，也提前作为 Capability。

---

# 36. 模型无关原则

AgentLoop 永远不知道：

```text
GPT
Claude
Gemini
DeepSeek
Qwen
```

它只知道：

```text
LLMRequest
LLMStreamEvent
ToolCall
FinalMessage
```

---

# 37. LLM 配置

建议统一：

```ts
interface ModelConfig {
  provider: string;

  model: string;

  baseUrl?: string;

  apiKeyRef: string;

  temperature?: number;

  maxOutputTokens?: number;
}
```

注意：

数据库不建议直接保存明文 API Key。

推荐：

```text
ModelConfig
↓
apiKeyRef
↓
SecretStore
```

---

# 38. SecretStore

V1 可以采用：

```text
OS Environment
+
Local Encrypted Config
```

接口：

```ts
interface SecretStore {
  get(key: string): Promise<string | undefined>;

  set(key: string, value: string): Promise<void>;

  delete(key: string): Promise<void>;
}
```

未来可换：

```text
Windows Credential Manager
macOS Keychain
Linux Secret Service
```

---

# 39. ContextBuilder

ContextBuilder 是 Caelush 第二个非常重要的 Kernel 模块。

它不能简单：

```text
所有历史消息
+
所有 Tool 输出
```

全部发给模型。

---

# 40. Context 组成

每次请求模型：

```text
System Policy

Caelush Tool Rules

User Goal

Latest User Constraints

Workspace Summary

Environment

Project Profile

Current Plan

Current Run State

Recent Reasoning Summary

Recent Observations

Relevant File Context

Changed Files

Verification Failure

Budget Status
```

---

# 41. Context Priority

建议分：

```text
CRITICAL

HIGH

MEDIUM

LOW
```

例如：

| 内容 | Priority |
|---|---|
| System Rules | CRITICAL |
| User Goal | CRITICAL |
| 用户最新约束 | CRITICAL |
| Permission | CRITICAL |
| Verification Failure | HIGH |
| 当前错误 | HIGH |
| Relevant File | HIGH |
| Recent Observation | HIGH |
| Environment | MEDIUM |
| Project Profile | MEDIUM |
| 旧 Shell 输出 | LOW |
| 很早以前的 Tool Result | LOW |

---

# 42. Context Budget

每个模型得到：

```text
modelContextWindow
```

然后保留：

```text
Output Reserve
Tool Reserve
System Reserve
```

剩余作为 Dynamic Context。

示意：

```text
128K Context

System                  8K

Reserved Output        16K

Tool Definitions       10K

Dynamic Context        94K
```

V1 不需要做到最完美，但必须从第一版避免无限堆积。

---

# 43. Observation Compact

Shell：

```text
pnpm build
```

输出可能几万行。

不能全部进入下一轮。

因此 Tool Result 保存：

```text
Raw Result
```

但 Observation 给 LLM 的版本是：

```text
Compacted Result
```

例如：

```text
Command:
pnpm build

Exit:
2

Important stderr:
src/App.tsx(42,10): TS2322 ...

Last lines:
...

Output truncated:
true
```

完整输出保存在 RunTrace。

---

# 44. Environment Awareness

Run 启动时获取：

```text
OS
Architecture
Hostname
Shell
Workspace
Node
Python
Git
Environment
```

但是不要扫描整台电脑。

---

# 45. EnvironmentSnapshot

```ts
interface EnvironmentSnapshot {
  os: string;

  architecture: string;

  shell: string;

  cwd: string;

  runtimes: {
    node?: string;
    python?: string;
    rust?: string;
  };

  gitAvailable: boolean;
}
```

---

# 46. ProjectDetector

检测 Workspace 顶层和少量关键文件。

例如：

```text
package.json
pnpm-lock.yaml
vite.config.ts
tsconfig.json
```

判断：

```text
language:
TypeScript

runtime:
Node

framework:
React

buildTool:
Vite

packageManager:
pnpm
```

---

# 47. ProjectProfile

```ts
interface ProjectProfile {
  languages: string[];

  frameworks: string[];

  packageManager?: string;

  buildTool?: string;

  testFramework?: string;

  scripts: Record<string, string>;

  importantFiles: string[];
}
```

ProjectDetector 结果提供给：

```text
ContextBuilder
VerificationManager
Tool Strategy
```

---

# 48. ToolDefinition

V1 Tool 必须使用统一定义。

```ts
interface ToolDefinition<I, O> {
  name: string;

  description: string;

  inputSchema: ZodSchema<I>;

  outputSchema: ZodSchema<O>;

  riskLevel: RiskLevel;

  requiredCapabilities: Capability[];

  runtimeRequirements: RuntimeCapability[];

  execute(
    input: I,
    context: ToolExecutionContext
  ): Promise<O>;
}
```

---

# 49. RiskLevel

冻结：

```text
LOW

MEDIUM

HIGH

CRITICAL
```

示例：

```text
read_file
LOW

git_status
LOW

create_file
MEDIUM

apply_patch
MEDIUM

delete_file
HIGH

shell_exec
动态判断

危险 Shell
CRITICAL
```

---

# 50. ToolRegistry

ToolRegistry 负责：

```text
注册
注销
查找
列举
生成 Tool Schema
检查冲突
```

新增 Tool：

```text
register(tool)
```

即可。

AgentLoop 不需要改变。

---

# 51. ToolDispatcher Pipeline

所有 Tool Call 强制经过：

```text
LLM Tool Call
     │
     ▼
ToolRegistry
     │
     ▼
Schema Validation
     │
     ▼
Capability Check
     │
     ▼
Permission Check
     │
     ▼
Risk Evaluation
     │
     ▼
Approval Policy
     │
     ▼
Runtime Selection
     │
     ▼
Tool Execution
     │
     ▼
Output Validation
     │
     ▼
Secret Redaction
     │
     ▼
Observation
     │
     ▼
AgentLoop
```

禁止 Tool Call 绕过 Dispatcher。

---

# 52. ToolInvocation

每次调用保存：

```ts
interface ToolInvocation {
  id: string;

  runId: string;
  stepId: string;

  toolName: string;

  args: unknown;

  riskLevel: RiskLevel;

  status:
    | "REQUESTED"
    | "WAITING_APPROVAL"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";

  startedAt?: Date;
  finishedAt?: Date;

  error?: AgentError;
}
```

---

# 53. Filesystem Tools

V1：

```text
list_directory

glob_files

search_files

search_text

read_file

create_file

apply_patch

replace_text

move_file

delete_file
```

---

# 54. Filesystem 安全模型

所有 Path：

```text
Input Path
↓
Resolve
↓
Normalize
↓
realpath
↓
Symlink Check
↓
Workspace Boundary Check
↓
Permission Check
```

禁止简单判断：

```ts
path.startsWith(workspace)
```

因为可能受到：

```text
../
symbolic link
case sensitivity
Windows drive
UNC path
```

等问题影响。

---

# 55. read_file

至少支持：

```text
path

startLine

endLine

maxBytes
```

大文件保护。

例如：

```text
read_file(
  path="src/index.ts",
  startLine=1,
  endLine=200
)
```

---

# 56. search_text

推荐底层：

```text
ripgrep
```

支持：

```text
query
path
glob
caseSensitive
maxResults
```

Tool 返回结构化结果：

```text
path
line
column
preview
```

---

# 57. apply_patch

这是 Coding Agent 类能力中非常核心的 Tool。

流程：

```text
读取文件
↓
beforeHash
↓
Agent 生成 Patch
↓
再次读取当前文件 Hash
↓
Hash 一致
↓
应用 Patch
↓
写入
↓
afterHash
↓
生成 Diff
↓
FileChange
↓
file.modified Event
```

如果：

```text
beforeHash != currentHash
```

返回：

```text
FILE_CONFLICT
```

禁止覆盖。

---

# 58. FileChange

```ts
interface FileChange {
  id: string;

  runId: string;

  path: string;

  type:
    | "CREATED"
    | "MODIFIED"
    | "MOVED"
    | "DELETED";

  beforeHash?: string;
  afterHash?: string;

  diff?: string;

  timestamp: Date;
}
```

---

# 59. Shell Architecture

普通命令：

```text
shell_exec
↓
LocalRuntime
↓
child_process.spawn
```

长期进程：

```text
process_start
↓
ProcessManager
↓
node-pty
```

不要混为一个工具。

---

# 60. shell_exec

Input：

```ts
interface ShellExecInput {
  command: string;

  cwd?: string;

  env?: Record<string, string>;

  timeoutMs?: number;
}
```

Output：

```ts
interface ShellExecOutput {
  exitCode: number | null;

  stdout: string;

  stderr: string;

  durationMs: number;

  timedOut: boolean;
}
```

---

# 61. Shell Streaming

运行：

```text
pnpm build
```

立即：

```text
shell.started
```

之后不断：

```text
shell.output
shell.output
shell.output
```

最后：

```text
shell.completed
```

CLI/Web 都消费这些 Event。

---

# 62. ProcessManager

长期 Process：

```text
npm run dev
vite
python server.py
```

启动之后立即返回：

```text
process_id
```

AgentLoop 可以继续工作。

---

# 63. ProcessSession

```ts
interface ProcessSession {
  id: string;

  runId: string;

  command: string;

  cwd: string;

  status:
    | "STARTING"
    | "RUNNING"
    | "EXITED"
    | "FAILED"
    | "KILLED";

  pid?: number;

  startedAt: Date;

  exitedAt?: Date;

  exitCode?: number;
}
```

---

# 64. Process Tools

V1：

```text
process_start

process_output

process_stdin

process_kill

process_list
```

---

# 65. Git Tools

V1：

```text
git_status

git_diff

git_log
```

推荐直接调用：

```text
git CLI
```

而不是重新实现 Git。

默认不允许自动：

```text
git push

git reset --hard

git clean -fd

force push
```

---

# 66. Runtime Interface

Runtime 是 Caelush 未来扩展能力的关键。

建议：

```ts
interface Runtime {
  readonly id: string;

  getCapabilities(): RuntimeCapability[];

  getEnvironment(): Promise<EnvironmentSnapshot>;

  executeShell(
    request: ShellExecRequest,
    signal: AbortSignal
  ): Promise<ShellExecResult>;

  startProcess(
    request: ProcessStartRequest,
    signal: AbortSignal
  ): Promise<ProcessHandle>;

  readFile(...): Promise<...>;

  writeFile(...): Promise<...>;
}
```

---

# 67. V1 LocalRuntime

V1：

```text
LocalRuntime
```

实际操作当前电脑。

以后：

```text
Runtime
├── LocalRuntime
├── DockerRuntime
├── SSHRuntime
└── RemoteRuntime
```

Agent Core 完全不知道区别。

---

# 68. Permission 与 Sandbox 必须分开

Permission：

> Caelush 逻辑上是否允许这个行为。

Sandbox：

> 操作系统层面这个行为究竟能不能发生。

例如：

```text
Project Access
```

Permission 可以规定：

```text
只能访问 Workspace
```

但如果 Shell 可以执行：

```text
rm /xxx
```

单纯 cwd 并不能构成强 Sandbox。

因此 V1 必须明确：

> V1 LocalRuntime 提供的是逻辑安全边界，不是恶意代码级 OS Sandbox。

---

# 69. PermissionProfile

```ts
type PermissionProfile =
  | "READ_ONLY"
  | "PROJECT_ACCESS"
  | "FULL_ACCESS";
```

---

# 70. Capability

建议内部不要只看三档权限。

进一步拆成 Capability：

```text
FS_READ

FS_WRITE

FS_DELETE

SHELL_EXEC

PROCESS_START

PROCESS_KILL

GIT_READ

WEB_SEARCH

WEB_FETCH

OUTSIDE_WORKSPACE
```

PermissionProfile 本质上是：

```text
Capability Bundle
```

例如：

```text
READ_ONLY

FS_READ
GIT_READ
WEB_SEARCH
WEB_FETCH
```

---

# 71. ApprovalPolicy

```text
ALWAYS_ASK

DANGEROUS_ONLY

NEVER_ASK
```

注意：

```text
NEVER_ASK
```

并不意味着：

```text
所有操作都允许
```

仍然必须首先通过 Permission。

---

# 72. ApprovalRequest

```ts
interface ApprovalRequest {
  id: string;

  runId: string;

  toolInvocationId: string;

  riskLevel: RiskLevel;

  title: string;

  reason: string;

  requestedAction: unknown;

  status:
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED";

  scope:
    | "ONCE"
    | "RUN";

  createdAt: Date;

  resolvedAt?: Date;
}
```

---

# 73. Approval 工作流

```text
Tool Call
↓
Risk = HIGH
↓
ApprovalPolicy = DangerousOnly
↓
approval.requested
↓
Run = WAITING_APPROVAL
↓
CLI/Web 显示
↓
用户：
Allow Once
Allow Run
Reject
↓
approval.resolved
↓
Run = RUNNING
```

---

# 74. Secret Protection

默认敏感文件模式：

```text
.env
.env.*
*.pem
*.key
id_rsa
credentials*
token*
secret*
```

并不是完全禁止读取。

而是默认：

```text
不主动读取
不主动注入 Context
```

如果任务明确需要：

```text
用户授权
↓
再读取
```

---

# 75. Secret Redaction

所有：

```text
Shell Output
Tool Result
Web Result
Event Payload
LLM Context
```

进入下一层之前经过：

```text
SecretRedactor
```

例如：

```text
sk-proj-123456789
```

变成：

```text
sk-****6789
```

---

# 76. Verification Architecture

Agent 不可以自己说：

```text
“任务完成。”
```

RunController 必须询问：

```text
VerificationManager
```

---

# 77. VerificationManager

职责：

```text
判断任务类型

生成 Verification Plan

执行 Verification

收集 Evidence

判断 Pass/Fail

失败反馈给 AgentLoop
```

---

# 78. Coding Verification

例如：

```text
ProjectDetector
↓
package.json
↓
scripts
```

发现：

```text
lint

typecheck

test

build
```

可以形成：

```text
VerificationPlan

1. pnpm typecheck
2. pnpm test
3. pnpm build
```

具体执行策略根据任务决定。

---

# 79. VerificationResult

```ts
interface VerificationResult {
  id: string;

  runId: string;

  type: string;

  command?: string;

  status:
    | "PASSED"
    | "FAILED"
    | "SKIPPED";

  stdout?: string;

  stderr?: string;

  evidence?: unknown;

  startedAt: Date;

  finishedAt: Date;
}
```

---

# 80. Verification Failure

如果：

```text
pnpm build
↓
exit 2
```

不是立即：

```text
Run FAILED
```

而是：

```text
VerificationFailedObservation
↓
ContextBuilder
↓
AgentLoop
↓
继续修复
```

---

# 81. Error Taxonomy

统一错误：

```text
NETWORK_ERROR

RATE_LIMIT

MODEL_ERROR

MODEL_TIMEOUT

TOOL_ARGUMENT_ERROR

TOOL_EXECUTION_ERROR

TOOL_OUTPUT_ERROR

PERMISSION_DENIED

APPROVAL_REJECTED

FILE_CONFLICT

COMMAND_FAILED

PROCESS_FAILED

VERIFICATION_FAILED

RUNTIME_ERROR

CANCELLED

TIMEOUT

BUDGET_EXCEEDED

INTERNAL_ERROR
```

---

# 82. Retry 策略

不同错误不能一律 Retry。

例如：

```text
NETWORK_ERROR
→ exponential backoff

RATE_LIMIT
→ Retry-After / backoff

TOOL_ARGUMENT_ERROR
→ 返回 LLM 修参数

COMMAND_FAILED
→ Observation

FILE_CONFLICT
→ 重新读取

VERIFICATION_FAILED
→ 返回 AgentLoop

PERMISSION_DENIED
→ 告知 LLM 不允许

INTERNAL_ERROR
→ Fatal
```

---

# 83. AgentEvent

AgentEvent 是 CLI/Web/Trace 的统一基础。

建议：

```ts
interface BaseAgentEvent {
  eventId: string;

  sequence: number;

  runId: string;

  sessionId: string;

  stepId?: string;

  type: string;

  timestamp: string;

  title?: string;

  summary?: string;

  payload?: unknown;

  visibility:
    | "USER_VISIBLE"
    | "DEBUG"
    | "SYSTEM";
}
```

---

# 84. 为什么必须有 sequence

例如 Run：

```text
Event 141
Event 142
Event 143
```

Web SSE 断线。

重新连接：

```text
Last Event = 143
```

Server：

```text
从 144 开始 Replay
```

避免：

```text
Shell Output 丢失
Tool Card 消失
状态错乱
```

---

# 85. Event 类型

V1 冻结：

```text
run.started
run.completed
run.failed
run.cancelled

status.changed

reasoning.summary

plan.updated

tool.requested
tool.started
tool.output
tool.completed
tool.failed

file.read
file.created
file.modified
file.moved
file.deleted

shell.started
shell.output
shell.completed

process.started
process.output
process.stopped

verification.started
verification.completed

approval.requested
approval.resolved

llm.started
llm.completed

error
```

---

# 86. Reasoning Summary

Caelush 对用户展示：

```text
Reasoning Summary
```

而不是内部完整思维链。

例如：

```text
检测到这是 React + Vite 项目。

构建错误集中于 AuthResponse 类型定义。

下一步检查该类型声明及使用位置。
```

Event：

```text
reasoning.summary
```

CLI/Web 不自行猜测 Agent 当前在做什么。

---

# 87. EventBus

建议：

```ts
interface EventBus {
  emit(event: AgentEvent): Promise<void>;

  subscribe(
    runId: string,
    listener: EventListener
  ): Unsubscribe;

  replay(
    runId: string,
    afterSequence?: number
  ): Promise<AgentEvent[]>;
}
```

---

# 88. Event 流转

```text
Agent Core
↓
EventBus
├── EventStore
├── SSE
├── CLI
├── Web
├── Trace
└── Debug Logger
```

UI 不读取 Agent 内部 State。

UI 主要依赖：

```text
API Snapshot
+
Event Stream
```

---

# 89. SSE API

```text
GET /api/runs/:runId/events
```

Response：

```text
Content-Type: text/event-stream
```

Event：

```text
id: 145

event: shell.output

data: {...}
```

---

# 90. CLI 与 Web 同步

CLI：

```text
→ pnpm build
```

来源：

```text
shell.started
```

Web：

```text
Shell Card
pnpm build
```

同样来源：

```text
shell.started
```

所以不存在：

```text
CLI 展示逻辑决定 Agent 状态

Web 又实现第二套判断
```

---

# 91. Storage

V1 采用：

```text
SQLite
+
Drizzle
```

数据库用于：

```text
Session
Run
Event
Trace
Approval
ToolInvocation
Verification
FileChange
LLM Usage
```

---

# 92. 数据表建议

核心表：

```text
agent_sessions

agent_messages

agent_runs

agent_steps

agent_events

tool_invocations

approval_requests

file_changes

verification_results

process_sessions

llm_calls

run_errors
```

---

# 93. agent_runs

建议字段：

```text
id

session_id

goal

status

workspace_path

runtime_id

provider

model

permission_profile

approval_policy

max_steps

max_tool_calls

timeout_ms

current_step

created_at

started_at

finished_at

final_result
```

---

# 94. agent_events

```text
id

run_id

session_id

step_id

sequence

type

visibility

title

summary

payload_json

created_at
```

唯一索引：

```text
UNIQUE(run_id, sequence)
```

---

# 95. tool_invocations

```text
id

run_id

step_id

tool_name

args_json

risk_level

status

result_json

error_json

started_at

finished_at
```

---

# 96. file_changes

```text
id

run_id

tool_invocation_id

path

change_type

before_hash

after_hash

diff

created_at
```

---

# 97. verification_results

```text
id

run_id

type

command

status

stdout

stderr

evidence_json

started_at

finished_at
```

---

# 98. LLM Call Trace

保存：

```text
provider

model

request metadata

token usage

duration

status

error
```

默认不建议永久存完整 Secret 或未经处理的敏感 Prompt。

---

# 99. API Architecture

Daemon 使用：

```text
Fastify
```

建议 V1：

```text
/api
```

版本：

```text
/api/v1
```

---

# 100. Session API

```text
POST /api/v1/sessions

GET /api/v1/sessions

GET /api/v1/sessions/:id

DELETE /api/v1/sessions/:id
```

---

# 101. Run API

```text
POST /api/v1/runs

GET /api/v1/runs/:id

POST /api/v1/runs/:id/messages

POST /api/v1/runs/:id/cancel

GET /api/v1/runs/:id/events

GET /api/v1/runs/:id/trace
```

---

# 102. Approval API

```text
POST /api/v1/approvals/:id/approve

POST /api/v1/approvals/:id/reject
```

Approve：

```json
{
  "scope": "ONCE"
}
```

或者：

```json
{
  "scope": "RUN"
}
```

---

# 103. Workspace API

```text
GET /api/v1/workspaces

POST /api/v1/workspaces

GET /api/v1/workspaces/:id
```

V1 不允许 Web 任意浏览整块磁盘作为默认行为。

Workspace 最好由用户：

```text
显式添加
```

然后 Web 可以选择已授权 Workspace。

---

# 104. Config API

```text
GET /api/v1/config/models

POST /api/v1/config/models

GET /api/v1/config/runtime

GET /api/v1/config/security
```

Secret 不通过普通 GET API 返回。

---

# 105. CLI 架构

CLI 使用：

```text
Ink
```

主要组件：

```text
App

Header

WorkspaceInfo

Conversation

RunStatus

ReasoningSummary

PlanView

ToolInvocationView

ShellView

FileDiffView

VerificationView

ApprovalPrompt

PromptInput
```

---

# 106. CLI 不执行 Agent

CLI 负责：

```text
提交任务

订阅 Event

发送 Approval

发送 Stop

发送追加消息

显示结果
```

真正 Run 在 Daemon。

---

# 107. CLI 启动流程

用户：

```bash
cd my-project
caelush
```

CLI：

```text
检测 Local Daemon
↓
如果未启动
↓
启动 Daemon
↓
注册当前 Workspace
↓
建立 Session
↓
显示 CLI
```

---

# 108. CLI 命令

V1：

```text
/help

/status

/stop

/clear

/model

/permission

/workspace

/history

/exit
```

---

# 109. Web Architecture

```text
React
+
Vite
+
TanStack Query
+
Zustand
```

---

# 110. Web 页面结构

```text
AppShell
│
├── Sidebar
│   ├── New Session
│   ├── Session List
│   └── History
│
├── Main
│   ├── Run Header
│   ├── Conversation
│   ├── AgentStream
│   │   ├── Reasoning
│   │   ├── ToolCard
│   │   ├── ShellCard
│   │   ├── FileDiff
│   │   ├── Verification
│   │   └── Error
│   │
│   └── Composer
│
└── ApprovalModal
```

---

# 111. Web State

TanStack Query：

```text
Session List

Run Metadata

History

Config

Workspace
```

Zustand：

```text
Active Run

Streaming Event

UI Expanded State

Shell Buffer

Pending Approval

Composer State
```

---

# 112. Web Stop

Stop 按钮：

```text
RUNNING
WAITING_APPROVAL
VERIFYING
```

期间始终可见。

点击：

```text
POST /runs/:id/cancel
```

UI：

```text
Stopping...
```

只有收到：

```text
run.cancelled
```

才显示：

```text
Cancelled
```

---

# 113. 用户中途追加约束

例如用户：

```text
不要修改 tests 目录
```

接口：

```text
POST /runs/:id/messages
```

消息进入：

```text
RunConstraintQueue
```

Agent 下一轮 ContextBuilder 加入：

```text
Latest User Constraints
```

Tool Dispatcher 也可读取明确约束。

例如：

```text
禁止修改 tests/**
```

则不仅告诉 LLM，也可以转换为安全规则。

---

# 114. Web Search Architecture

Tool：

```text
web_search
```

不绑定具体供应商。

接口：

```ts
interface WebSearchProvider {
  search(
    query: string,
    options: SearchOptions,
    signal: AbortSignal
  ): Promise<SearchResult[]>;
}
```

Provider：

```text
Bocha
Tavily
Brave
Bing
Other
```

---

# 115. web_fetch

流程：

```text
URL
↓
fetch
↓
Content-Type
↓
HTML Parser
↓
Readability
↓
正文提取
↓
Secret / Noise Cleaning
↓
长度限制
↓
Observation
```

V1 不加入：

```text
Playwright
浏览器交互
登录
点击
表单
```

---

# 116. Trace Architecture

每个 Run 都形成：

```text
RunTrace
```

包含：

```text
User Goal

Environment

Project Detection

LLM Call

Tool Invocation

Tool Result

Observation

Shell Output

Process

File Change

Approval

Retry

Error

Verification

Final Result
```

---

# 117. Trace 与 Event 的区别

Event：

> 发生了什么。

Trace：

> 整个 Run 的完整执行证据链。

Event 可以是 Trace 的重要数据来源，但 Trace 还包含：

```text
状态快照
耗时
token usage
内部 debug metadata
```

---

# 118. Logging

采用：

```text
Pino
```

日志级别：

```text
fatal
error
warn
info
debug
trace
```

同时 Caelush 自己定义：

```text
USER_VISIBLE

DEBUG

SYSTEM
```

不要把用户可见 Event 与服务端 Debug Log 混为一体。

---

# 119. Testing Strategy

V1 采用：

```text
Vitest
```

测试分：

```text
Unit

Integration

E2E

Fault Injection
```

---

# 120. Unit Test

重点：

```text
ToolDispatcher

PermissionManager

PathGuard

ContextBuilder

RunStateMachine

BudgetManager

RetryController

SecretRedactor

ProjectDetector
```

---

# 121. Integration Test

例如：

```text
AgentLoop
+
FakeLLM
+
FakeTools
```

验证：

```text
LLM
↓
Tool
↓
Observation
↓
LLM
↓
Verification
```

闭环。

---

# 122. FakeLLMProvider

测试时不要真正调用模型 API。

实现：

```text
FakeLLMProvider
```

预设：

```text
第 1 次返回 read_file

第 2 次返回 shell_exec

第 3 次返回 final
```

可以稳定测试 AgentLoop。

---

# 123. FakeRuntime

同样：

```text
FakeRuntime
```

模拟：

```text
File
Shell
Process
```

避免单元测试真正删除文件。

---

# 124. E2E Test

最终启动：

```text
真实 Daemon
+
CLI/Web API
+
Fixture Project
```

例如制造一个 Build Error Project。

任务：

```text
修复 build
```

检查：

```text
Run COMPLETED

build exit 0

FileChange 存在

Verification PASSED

Trace 完整

Event Sequence 连续
```

---

# 125. Fault Injection

V1 最后必须主动制造故障。

至少：

```text
LLM Timeout

LLM Rate Limit

Malformed Tool Args

Shell Timeout

Process Kill

Permission Denied

Approval Reject

File Conflict

SSE Disconnect

User Cancel

Verification Fail

Database temporary error
```

确认 Agent 不会崩掉。

---

# 126. V1 开发阶段重新规划

最终推荐采用 14 个阶段。

---

## Phase 0：Repository & Architecture Foundation

涉及需求：

```text
Monorepo

TypeScript

Shared Protocol

Module Boundary
```

实现：

```text
pnpm workspace

apps/

packages/

tsconfig

lint

format

Vitest

CI
```

验收：

```text
pnpm install

pnpm build

pnpm test
```

全部通过。

---

## Phase 1：Protocol & State Model

实现：

```text
AgentSession

AgentRun

AgentStep

AgentState

AgentEvent

ToolDefinition

Observation

ApprovalRequest

VerificationResult
```

以及：

```text
Run State Machine
```

验收：

所有核心协议拥有：

```text
TypeScript Type
+
Zod Schema
+
Unit Test
```

---

## Phase 2：Storage & EventBus

实现：

```text
SQLite

Drizzle

Repository

EventBus

EventStore

Event Replay
```

验收：

```text
创建 Run
↓
写入 Event
↓
重启
↓
仍能恢复 Event
```

---

## Phase 3：Local Agent Service

实现：

```text
Fastify

Session API

Run API

SSE

Cancellation API

Approval API
```

此阶段 Agent 可以是假 Agent。

主要确认：

```text
CLI/Web 可以共同观察同一个 Run。
```

---

## Phase 4：LLM Gateway

实现：

```text
LLMProvider

AI SDK Adapter

Streaming

Tool Call Normalization

Usage

Timeout

Abort
```

首先支持：

```text
OpenAI Compatible Provider
```

这样可以一次覆盖：

```text
OpenAI

DeepSeek

Qwen

大量兼容服务
```

随后再补：

```text
Anthropic
Gemini
```

---

## Phase 5：Context + Environment + Project Detector

实现：

```text
EnvironmentSnapshot

ProjectProfile

ContextBuilder

Context Budget

Observation Compact
```

验收项目：

```text
React + Vite + pnpm

Python

Rust
```

至少能够基础识别。

---

## Phase 6：AgentLoop

实现：

```text
RunController

RunExecutionContext

AgentLoop

Step

State Update

LLM → Tool → Observation → LLM
```

使用 FakeTool 先跑通。

此阶段是第一个真正意义上的 Agent Kernel。

---

## Phase 7：Tool System

实现：

```text
ToolRegistry

ToolDispatcher

Schema Validation

Risk

Capability

Permission Pipeline
```

先注册：

```text
echo

time

fake_tool
```

证明 Tool System 与 AgentLoop 解耦。

---

## Phase 8：Filesystem / Shell / Process / Git

实现：

```text
Filesystem Tools

Shell Tool

ProcessManager

Git Tools

Streaming Output

File Hash Guard

Diff
```

到这里 Caelush 开始真正拥有：

```text
操作项目的能力。
```

---

## Phase 9：Security

实现：

```text
ReadOnly

ProjectAccess

FullAccess

Capability

Approval

PathGuard

Command Risk

Secret Detection

Secret Redaction
```

验收必须专门测试：

```text
../

symlink

workspace escape

危险删除

敏感文件
```

---

## Phase 10：Cancellation / Timeout / Retry / Budget

实现：

```text
Abort Tree

Tool Timeout

Shell Timeout

LLM Timeout

Run Timeout

maxSteps

maxToolCalls

Retry
```

验收：

点击 Stop 后：

```text
LLM

Shell

Fetch

Process
```

确实停止。

---

## Phase 11：Verification

实现：

```text
VerificationManager

VerificationPlan

Project Script Detection

Verification Failure → AgentLoop
```

这是 Caelush 从：

```text
“会干活”
```

升级到：

```text
“知道自己干没干好”
```

的阶段。

---

## Phase 12：正式 CLI

实现：

```text
Chat

Status

Reasoning Summary

Tool View

Shell Streaming

Diff

Verification

Approval

Stop

History
```

CLI 此时正式成为产品端。

---

## Phase 13：正式 Web

实现：

```text
Session

Workspace

Chat

SSE

Tool Card

Shell Card

Diff

Verification

Approval

Permission

Stop

History
```

并验证：

```text
CLI + Web
```

同时观察同一个 Run。

---

## Phase 14：Web Search + V1 Hardening

实现：

```text
web_search

web_fetch

Search Provider

Fetch Parser
```

并进入：

```text
E2E

Fault Injection

Performance

Security Review

V1 Acceptance
```

---

# 127. V1 关键里程碑

建议定义四个大 Milestone。

## M1：Agent 能循环

```text
LLM
↓
Tool
↓
Observation
↓
LLM
```

成功。

---

## M2：Agent 能操作项目

```text
read

search

patch

shell

process

git
```

成功。

---

## M3：Agent 能安全自主工作

```text
Permission

Approval

Cancellation

Timeout

Verification
```

成功。

---

## M4：CLI/Web 正式产品化

```text
同一个 Run

同一 Event Stream

完整 Trace

真正 Stop

完整 Verification
```

成功。

---

# 128. V1 最终验收场景

准备一个 Caelush 从未适配过的测试项目。

人为制造：

```text
TypeScript Build Error
```

用户：

```text
修复当前项目 build 问题，并确保项目最终能够正常 build。
```

之后用户不再提供步骤。

---

# 129. Agent 预期执行

```text
run.started

↓

Environment Detection

↓

Project Detection

↓

读取 package.json

↓

识别 pnpm

↓

执行 pnpm build

↓

发现 TypeScript Error

↓

搜索错误 Symbol

↓

读取相关源码

↓

Reasoning Summary

↓

apply_patch

↓

File Diff

↓

再次 pnpm build

↓

发现第二个错误

↓

继续搜索

↓

继续修改

↓

pnpm build

↓

成功

↓

pnpm test

↓

成功

↓

git diff

↓

Verification

↓

run.completed
```

---

# 130. CLI 验收

用户必须能够实时看到：

```text
● 正在分析项目

✓ React + Vite + pnpm

→ read_file package.json

→ shell pnpm build

✕ Build failed

● 正在检查 TypeScript 错误

→ search_text AuthResponse

→ read_file src/types/auth.ts

● 发现类型不匹配

→ apply_patch src/types/auth.ts

Diff:
- old
+ new

→ pnpm build

✓ Build successful

→ pnpm test

✓ 28 tests passed

Verification

✓ Typecheck

✓ Tests

✓ Build

✓ 任务完成
```

---

# 131. Web 验收

Web 同时显示：

```text
Run Status

Project Detection

Reasoning Summary

Tool Card

Shell Card

Streaming Output

File Diff

Verification

Final Result
```

并支持：

```text
Stop

Approval

追加指令
```

---

# 132. V1 架构禁止项

为了防止开发过程中架构逐渐写歪，冻结以下禁止项。

禁止：

```text
CLI 自己拥有独立 AgentLoop

Web 自己拥有独立 AgentLoop
```

禁止：

```text
AgentLoop 直接执行 Shell
```

禁止：

```text
AgentLoop 硬编码 Tool 名称
```

禁止：

```text
AgentLoop 直接依赖 OpenAI/Anthropic SDK
```

禁止：

```text
Tool 绕过 ToolDispatcher
```

禁止：

```text
Permission 与 Sandbox 混为一个概念
```

禁止：

```text
只修改 Run Status 来实现 Stop
```

禁止：

```text
把所有 Tool Result 永久堆进 Context
```

禁止：

```text
把完整 Chain-of-Thought 作为 UI 功能
```

禁止：

```text
LLM 自己声称完成就直接 COMPLETED
```

禁止：

```text
文件修改默认整文件覆盖
```

禁止：

```text
默认把 .env、Private Key、Token 发给模型
```

禁止：

```text
V1 为了“架构完整”提前加入 Multi-Agent、Browser、MCP 等范围外功能。
```

---

# 133. V1 必须保留的未来扩展点

虽然不实现，但必须能够自然加入：

```text
DockerRuntime

SSHRuntime

RemoteRuntime

MCP Tool Adapter

Skill System

Workflow Engine

BrowserRuntime

ComputerRuntime

Long-Term Memory

Sub-Agent

Multi-Agent
```

---

# 134. Skill 未来接入方式

未来：

```text
Skill
```

不应该重写 AgentLoop。

Skill 可以提供：

```text
System Instructions

Tool Bundle

Context Provider

Verification Rule

Domain Policy
```

例如：

```text
Deployment Skill

Tools:
docker
ssh
nginx

Rules:
部署安全策略

Verification:
HTTP Health Check
```

底层仍然：

```text
Caelush Kernel
```

---

# 135. MCP 未来接入方式

未来 MCP：

```text
MCP Server
↓
MCP Tool Adapter
↓
ToolDefinition
↓
ToolRegistry
↓
ToolDispatcher
```

这样 AgentLoop 根本不需要知道：

> 这是 Built-in Tool 还是 MCP Tool。

---

# 136. Browser 未来接入方式

```text
BrowserRuntime
```

暴露：

```text
browser_open

browser_click

browser_type

browser_extract

browser_screenshot
```

依旧走：

```text
Tool Registry
↓
Dispatcher
↓
Permission
↓
Runtime
```

---

# 137. Multi-Agent 未来接入方式

未来：

```text
Parent Run
↓
SubRun
↓
Agent
```

可以增加：

```text
SubAgentRuntime
```

但父子 Agent 仍然共享：

```text
Tool System

Event

Permission

Storage

Runtime abstraction
```

所以 V1 Kernel 不需要推翻。

---

# 138. 为什么 V1 不使用 LangGraph 作为 Kernel

LangGraph 非常适合：

```text
Workflow

Durable Execution

Graph

Checkpoint

Human-in-the-loop
```

但 Caelush 当前的目标本身就是建立：

```text
Agent Kernel
Runtime
Tool System
State
Event
```

如果第一版直接：

```text
Caelush
↓
LangGraph
```

则未来 Caelush 的核心语义容易变成：

```text
LangGraph State

LangGraph Node

LangGraph Interrupt

LangGraph Checkpoint
```

这会削弱 Caelush 自己的 Kernel 边界。

因此 V1：

```text
自研 AgentLoop
```

后续可以：

```text
LangGraphWorkflowAdapter
```

让部分复杂 Workflow 使用 LangGraph。

但是：

```text
Caelush Kernel
```

不能建立在 LangGraph 之上。

---

# 139. 最终技术架构摘要

Caelush V1 可以归纳成七层。

```text
Layer 1
Presentation

CLI
Web

↓

Layer 2
Local Agent Service

HTTP
SSE
Session
Run

↓

Layer 3
Agent Kernel

RunController
AgentLoop
AgentState
ContextBuilder
Verification

↓

Layer 4
LLM + Tool

LLMProvider
ToolRegistry
ToolDispatcher

↓

Layer 5
Security + Runtime

Permission
Approval
Sandbox
Runtime

↓

Layer 6
Execution

Filesystem
Shell
Process
Git
Web

↓

Layer 7
Infrastructure

SQLite
EventBus
RunTrace
Logging
```

---

# 140. Caelush V1 最终技术定义

Caelush V1 不是一个：

```text
Chat UI + Function Calling
```

应用。

它真正应该形成：

```text
           USER
            │
       CLI / Web
            │
            ▼
    Caelush Service
            │
            ▼
      RunController
            │
            ▼
        AgentLoop
            │
     ┌──────┴──────┐
     ▼             ▼
 ContextBuilder    LLM
                     │
                     ▼
                 Decision
                     │
                     ▼
               ToolDispatcher
                     │
           ┌─────────┼─────────┐
           ▼         ▼         ▼
      Permission   Approval   Runtime
                               │
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
              File            Shell            Web
               │               │               │
               └───────────────┼───────────────┘
                               ▼
                          Observation
                               │
                               ▼
                           AgentState
                               │
                               ▼
                         Verification
                               │
                   ┌───────────┴───────────┐
                   ▼                       ▼
                 Failed                  Passed
                   │                       │
                   ▼                       ▼
               AgentLoop               Completed
```

与此同时，整个系统的每一次行为：

```text
LLM
Tool
Shell
File
Approval
Verification
Error
```

都会产生：

```text
AgentEvent
```

最终：

```text
CLI

Web

RunTrace

Logs
```

看到的是同一套事实。

---

# 141. 架构完成后的核心能力

完成本文档定义的 V1 后，Caelush 将真正具备六类基础能力。

## 感知

```text
Workspace

Environment

Project

Files

Git

Tool Results
```

## 思考与决策

```text
LLM

ContextBuilder

AgentLoop

State

Plan
```

## 行动

```text
Filesystem

Shell

Process

Git

Web

Tool System
```

## 控制

```text
Permission

Capability

Approval

Sandbox

Cancellation

Timeout

Budget
```

## 自我检查

```text
Verification

Retry

Failure Recovery
```

## 可观察

```text
AgentEvent

CLI Stream

Web Stream

Reasoning Summary

Tool Call

Shell Output

File Diff

Verification

RunTrace
```

---

# 142. 最终开发原则

Caelush V1 的整个开发过程中应始终坚持：

> **先保证 Kernel 正确，再增加能力。**

不要以：

```text
工具数量

页面数量

模型数量
```

衡量 V1 是否成熟。

真正需要优先保证的是：

```text
一个 Run 能否可靠启动

↓

是否能够正确建立 State

↓

是否能让 LLM 做出 Tool Decision

↓

Tool 是否经过统一 Dispatcher

↓

权限是否真的生效

↓

Runtime 是否真正执行

↓

结果是否形成 Observation

↓

Agent 是否能根据结果继续行动

↓

Cancellation 是否能真正停止

↓

Verification 是否能够发现失败

↓

失败后是否能够重新进入 Loop

↓

CLI/Web 是否看到同一执行事实

↓

Trace 是否能够完整复盘整个 Run
```

只有这些基础能力稳定之后：

```text
Skill

Workflow

MCP

Browser

Computer Use

Memory

Sub-Agent

Multi-Agent
```

才值得继续向上构建。

---

# 143. Caelush V1 架构基线结论

第一版正式冻结为：

```text
TypeScript
+
Node.js 24 LTS

pnpm Monorepo

Caelush Custom Agent Kernel

Caelush Local Agent Service

Caelush LLMProvider
+
AI SDK Adapter

Caelush Tool System
+
Zod

Caelush Runtime Interface
+
LocalRuntime

Fastify

SQLite
+
Drizzle

SSE Event Stream

React + Vite Web

Ink CLI

child_process.spawn

node-pty

ripgrep

fast-glob

Pino

Vitest

AbortController

Custom Verification

Custom RunTrace
```

其最重要的四条架构红线是：

```text
CLI / Web 共用一个 Runtime

AgentLoop 不感知具体 Tool

AgentLoop 不感知具体模型

Agent 完成必须经过 Verification
```

Caelush V1 一旦把这四个基础打牢，就拥有了继续构建完整 Agent 平台所需要的真正底座。