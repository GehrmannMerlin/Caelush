<div align="center">

<img src="./apps/web/src/assets/logo/caelush-logo.png" alt="Caelush" width="520" />

# Caelush

**本地优先、可恢复、可验证的编程 Agent**

让 AI 在你的项目中理解代码、修改文件、执行命令并验证结果，<br />
同时由一套共享内核统一管理 Web、CLI、权限、持久化与任务恢复。

[![GitHub stars](https://img.shields.io/github/stars/GehrmannMerlin/Caelush?style=flat-square&logo=github)](https://github.com/GehrmannMerlin/Caelush/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/GehrmannMerlin/Caelush?style=flat-square&logo=github)](https://github.com/GehrmannMerlin/Caelush/commits/main)
[![Node.js 24](https://img.shields.io/badge/Node.js-24.x-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-early%20development-f59e0b?style=flat-square)](#项目状态)

[快速开始](#快速开始) · [核心能力](#核心能力) · [Agent 内核](#agent-内核) · [系统架构](#系统架构) · [参与开发](#参与开发)

</div>

> [!IMPORTANT]
> Caelush 目前处于早期开发阶段，面向架构验证、产品迭代和本地开发使用。配置格式、运行方式和部分公开接口仍可能发生不兼容变化。

## Caelush 是什么

Caelush 是一个运行在本地的编程 Agent。你可以用自然语言描述开发任务，它会围绕当前工作区读取和搜索代码、生成补丁、执行命令、观察进程输出，并根据验证结果继续工作。

它不只是一个把大模型接到终端上的聊天界面。Caelush 更关注编程 Agent 在真实工程中长期运行时必须解决的问题：

- 一次任务由谁负责推进，状态如何变化；
- 工具调用如何校验、授权、执行和记录；
- 页面刷新或客户端断开后，任务能否继续恢复；
- 实时输出和持久事实如何分离；
- 模型声称“已经完成”时，系统如何通过证据进行验证；
- Web、CLI 和未来宿主如何共享同一套执行语义。

为此，Caelush 将 Agent 能力组织成一个可组合的本地运行时：本地 Daemon 是唯一的执行入口，Web 与 CLI 都是它的客户端；Agent Kernel 负责任务决策，Runtime 负责真正访问文件和进程，Security 负责权限判断，Storage 保存可恢复状态，Verification 判断任务是否具备完成条件。

## 你可以用它做什么

Caelush 面向现有代码仓库和本地开发流程，适合处理这类任务：

- 阅读项目结构，定位某个功能或错误的实现位置；
- 跨文件修改代码，补充测试并修复编译、类型或测试失败；
- 搜索文本、文件和 Git 差异，收集完成任务所需的上下文；
- 执行构建、测试、Lint、格式化和其他开发命令；
- 观察长时间运行的命令，并在后续步骤中继续读取输出；
- 在操作需要更高权限时请求用户确认；
- 保存会话和任务状态，在客户端重连后继续查看和恢复；
- 通过 Web 页面或终端界面使用同一个 Agent。

## 核心能力

### 共享的 Web 与 CLI 体验

Caelush 同时提供浏览器端和终端端。两者通过统一 Client/Protocol 访问本地 Daemon，共享会话、Run、工具调用、审批、事件和上下文使用情况，不会各自构造一套 Agent Loop。

### 项目级代码操作

内置 Coding Tool 覆盖文件读取、目录浏览、文件查找、文本搜索、补丁修改、命令执行、持续进程交互以及只读 Git 信息。工具定义与执行处理器来自同一个不可变目录，避免模型看到的工具和真正可执行的工具发生漂移。

### 可恢复的 Session 与 Run

对话消息、Run 状态、Step、工具调用、工具观察和持久事件写入本地 SQLite。创建任务、开始执行、等待审批、恢复运行和最终完成都有明确的状态边界。客户端断开不会被解释为任务事实消失。

### 实时进度与持久事实分离

生命周期变化以可重放的持久事件保存；模型流式文本、命令输出和进程进度则作为有界的瞬态信号实时传输。这样既能在界面中看到正在发生的工作，也不会让无限增长的终端输出污染持久历史。

### 权限、审批与安全策略

Security 在工具执行前评估权限档位、能力、路径、命令和审批要求；Runtime 负责实际的工作区约束和进程执行。两者职责分离，权限判断不会隐藏在某个具体工具或前端组件中。

### Provider 中立的模型边界

模型调用统一经过 AI Gateway。当前内置 OpenAI、DeepSeek、OpenRouter 与 Anthropic Provider 预设，也可以通过兼容配置接入其他 OpenAI-compatible 服务。Provider 凭据只由 Daemon 运行时读取，不通过 Web 或 CLI 请求传递。

### 验证驱动的完成判定

模型给出的最终回答只是“完成候选”，不是任务已经完成的证据。Verification 收集有界的工作区、Git 和命令证据，最终只有 Core/RunController 拥有把 Run 转为 `COMPLETED` 的权限。

## Agent 内核

Caelush 的核心不是某个页面或命令行入口，而是一套由多个明确边界协作组成的 Agent Kernel。

```text
用户任务
  │
  ▼
RunController ──────── 管理 Run 生命周期、恢复边界与完成权限
  │
  ▼
Agent Loop ─────────── 决定下一次模型调用或工具调用
  │
  ├── Context ──────── 组织对话、项目指令、相关文件与预算
  ├── AI Gateway ───── 连接模型并保持单一模型回合边界
  ├── Tool Dispatcher  校验、授权、执行、观察并结算工具调用
  ├── RunEvent ─────── 保存生命周期事实并投射实时进度
  └── Verification ─── 用证据判断任务是否真正满足完成条件
```

### RunController：任务状态的唯一权威

RunController 管理任务从创建、执行、等待审批、恢复到结束的状态变化。调用者不能绕过状态机自行把任务标记为完成，也不能在副作用边界未知时静默重试工具。

### Context：把有限的模型窗口留给真正重要的信息

Context 将持久对话、项目规则、相关文件、工具反馈和受控的上下文贡献统一映射到一次模型回合。选择过程记录被选中和被丢弃的消息，并在上下文压力上升时使用明确的压缩与恢复边界，而不是随意改写历史记录。

### Tool Dispatcher：所有工具共用一条执行链

每次工具调用都经过同一条生命周期：参数准备、Schema 校验、Guard、Security 判定、必要的人工审批、Runtime 执行、Observation 持久化以及模型可见反馈。工具处理器不会直接成为权限系统或持久化系统的第二入口。

### RunEvent：既能实时观察，也能可靠重放

持久 RunEvent 与其描述的 Run/Tool 真相在同一事务中提交，提交后才通知观察者。Daemon 的 RunEventHub 负责有界队列、独立观察者、重放与实时桥接；慢客户端不会阻塞 Agent 的生产者调用栈。

### Completion Authority：防止“口头完成”

Agent 最终输出需要经过验证和当前 Run 的完成守卫。只有证据与状态都满足要求，RunController 才会提交最终完成状态。这使“模型认为做完了”和“系统确认做完了”成为两个不同概念。

## 系统架构

Caelush 采用 TypeScript/Node.js Monorepo。生产环境只有一个组合根：`apps/daemon`。

```text
┌─────────────────────────────────────────────────────────────┐
│                          用户入口                           │
│                 Web / CLI / future hosts                   │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP + SSE
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Local Daemon                             │
│              唯一生产组合根与执行入口                       │
├─────────────────────────────────────────────────────────────┤
│ Agent Kernel │ Core │ Context │ Coding Agent │ AI Gateway   │
├─────────────────────────────────────────────────────────────┤
│ Security     │ Runtime       │ Verification  │ RunEventHub  │
├─────────────────────────────────────────────────────────────┤
│                SQLite Storage + Protocol                    │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                  本地工作区 / Git / 子进程
```

这套结构遵循几个核心原则：

- **单一执行权威**：Daemon 负责组合和驱动生产运行，Web/CLI 只消费安全的 Protocol 投影。
- **应用依赖包**：`apps/*` 可以组合 `packages/*`，基础包不反向依赖应用内部实现。
- **持久化优先**：先提交状态和事件，再通知实时订阅者。
- **工具执行单通道**：模型不能绕过 Dispatcher 直接调用 Runtime。
- **安全与执行分离**：Security 做判断，Runtime 做执行。
- **协议保持 JSON-safe**：跨进程数据不泄露 Provider SDK、数据库行或 Runtime 对象。
- **失败时保守处理**：恢复边界、历史投影或副作用状态不确定时，系统选择 fail closed。

更完整的包职责、依赖方向和状态模型请参阅 [架构文档](./docs/ARCHITECTURE.md)。

## 权限与安全

Web 端提供三档面向用户的权限配置：

| 权限             | 预期用途                   | 能力边界                                   |
| ---------------- | -------------------------- | ------------------------------------------ |
| **仅可查看**     | 阅读、搜索和分析项目       | 不允许修改工作区文件                       |
| **工作区内修改** | 常规开发任务               | 允许在当前工作区内修改，但限制工作区外写入 |
| **完全权限**     | 明确需要主机用户权限的任务 | 可以按当前主机用户范围访问文件、进程和网络 |

> [!WARNING]
> “完全权限”意味着 Agent 执行的命令可能对你的主机环境产生真实影响。请只在理解任务内容和模型行为时启用。

Caelush 正在完善 Windows 原生受限执行能力。当前权限模型包含 Security 策略、工作区边界、审批和 Runner 约束，但它不应被理解为适用于所有操作系统、命令和子进程的绝对安全沙箱。实际可用档位由 Daemon 探测到的主机能力决定；无法确认的受限能力会保守地标记为不可用。

## 快速开始

### 环境要求

- Node.js `24.x`
- pnpm `11.x`
- Windows 源码开发若要使用“仅可查看”或“工作区内修改”，需要可用的 Rust/Cargo 工具链
- 一个可用的模型 Provider 和 API Key

### 1. 获取并构建项目

```powershell
git clone https://github.com/GehrmannMerlin/Caelush.git
Set-Location Caelush
pnpm install --frozen-lockfile
pnpm build
```

### 2. 配置模型

下面以 OpenAI-compatible 服务为例。请根据实际 Provider 修改地址、密钥和模型名：

```powershell
$env:CAELUSH_PROVIDER_ID = "openai-compatible"
$env:CAELUSH_PROVIDER_BASE_URL = "https://your-provider.example/v1"
$env:CAELUSH_PROVIDER_API_KEY = "<your-api-key>"
$env:CAELUSH_DEFAULT_PROVIDER = "openai-compatible"
$env:CAELUSH_DEFAULT_MODEL = "<your-model>"
```

凭据由本地 Daemon 读取，不会出现在 Web/CLI 的任务请求中。请不要把真实密钥提交到仓库。

### 3. 启动 Web

从源码仓库运行：

```powershell
node apps/launcher/bin/caelush web
```

Launcher 会解析已经构建的 Web 资源，启动或复用本地 Daemon，并在浏览器中打开 Caelush。

### 4. 启动 CLI

```powershell
node apps/launcher/bin/caelush
```

常用命令：

```powershell
# 继续最近一次会话
node apps/launcher/bin/caelush --continue

# 选择并恢复历史会话
node apps/launcher/bin/caelush --resume

# 非交互执行一次任务
node apps/launcher/bin/caelush --print "分析当前项目并说明测试入口"

# 检查本地运行环境
node apps/launcher/bin/caelush doctor
```

安装正式产品包后，可以直接使用等价的 `caelush` 命令。

### 分别启动 Daemon 与 CLI

开发和调试时，也可以手动启动各个宿主：

```powershell
# 终端 1
pnpm --filter @caelush/daemon start

# 终端 2
pnpm --filter @caelush/cli start
```

在 Windows 源码开发环境中，Daemon 和 Launcher 会自动构建、校验并加载
`native/sandbox-runner`，无需手动设置 `CAELUSH_SANDBOX_RUNNER_PATH` 或
`CAELUSH_SANDBOX_RUNNER_MANIFEST`。如果本机没有 Rust/Cargo 或 Runner 构建失败，Daemon
仍会启动，但“仅可查看”和“工作区内修改”会保持不可用，并显示明确的安全组件提示；系统不会
把受限权限静默降级成完全权限。

常用环境变量：

| 变量                        | 作用                                       |
| --------------------------- | ------------------------------------------ |
| `CAELUSH_WORKSPACE_PATH`    | 指定 Daemon 操作的工作区；默认使用当前目录 |
| `CAELUSH_DAEMON_URL`        | 让客户端连接非默认 Daemon 地址             |
| `CAELUSH_WEB_BUILD_ROOT`    | 指定非标准位置的 Web 构建产物              |
| `CAELUSH_PROVIDER_ID`       | Provider 标识                              |
| `CAELUSH_PROVIDER_BASE_URL` | Provider API 地址                          |
| `CAELUSH_PROVIDER_API_KEY`  | Provider 凭据                              |
| `CAELUSH_DEFAULT_PROVIDER`  | 默认 Provider                              |
| `CAELUSH_DEFAULT_MODEL`     | 默认模型                                   |

## 内置 Coding Tools

| 工具             | 作用                       |
| ---------------- | -------------------------- |
| `read_file`      | 在大小和路径约束内读取文件 |
| `list_directory` | 浏览工作区目录             |
| `find_files`     | 按模式查找文件             |
| `search_text`    | 在工作区搜索文本           |
| `apply_patch`    | 通过可校验补丁修改文件     |
| `exec_command`   | 启动受管理的命令或进程     |
| `write_stdin`    | 与已启动的进程会话交互     |
| `git_status`     | 读取当前 Git 状态          |
| `git_diff`       | 读取 Git 差异              |

所有工具都会通过统一的 Registry、Security Gate、Dispatcher 和 Observation 生命周期。工具定义本身只包含模型可见的数据，不携带执行器、凭据或 Runtime 对象。

## 项目结构

```text
Caelush/
├── apps/
│   ├── daemon/          本地 Agent 服务与唯一生产组合根
│   ├── launcher/        产品启动、Daemon 发现与环境诊断
│   ├── web/             React/Vite 浏览器客户端
│   └── cli/             Ink 终端客户端
├── packages/
│   ├── agent/           Agent Kernel、Tool 编排与控制 Hook
│   ├── ai/              Provider 中立的模型领域与 Gateway
│   ├── client/          HTTP/SSE 客户端与宿主投影
│   ├── coding-agent/    内置 Coding Tools 与执行适配
│   ├── core/            Run 生命周期与 Completion Authority
│   ├── memory/          Memory 记录与存储接口
│   ├── observability/   可观测性边界
│   ├── protocol/        稳定、JSON-safe 的跨进程协议
│   ├── runtime/         文件、补丁、命令、进程和 Git 执行底座
│   ├── security/        权限、审批、命令与路径策略
│   ├── shared/          无业务依赖的共享工具
│   ├── storage/         SQLite、迁移、Repository 与持久适配器
│   └── verification/    证据收集与完成验证
├── native/
│   └── sandbox-runner/  Windows 原生受限进程 Runner
├── docs/                架构和专题设计文档
├── scripts/             构建、发布、架构与集成检查
├── tests/               架构守卫和跨包集成测试
├── AGENTS.md            仓库级开发与架构约束
└── README.md
```

## 开发与质量检查

常用命令：

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check:architecture:ci
pnpm check
```

`pnpm check` 是完整仓库检查。修改包边界、依赖方向或生产组合时，至少运行 `pnpm check:architecture:ci`。

项目坚持以下开发约束：

- 行为变更先添加或更新聚焦测试，再编写最小实现；
- 跨包导入必须使用公开入口，不允许导入其他包的私有 `src` 路径；
- 不建立第二套 Agent Loop、Tool Catalog、Runtime API 或事件写入通道；
- 不把凭据、隐藏推理、原始 Provider 流或无限输出写入公共协议；
- 所有影响任务完成状态的逻辑必须经过 RunController 和 Completion Authority。

完整约束请阅读 [AGENTS.md](./AGENTS.md)，系统真实架构请阅读 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 项目状态

Caelush 当前处于早期开发阶段，已经具备：

- 共享的 Web/CLI Agent Kernel；
- 持久 Session、Run、Conversation、Tool 与 Event 基础；
- 本地 Coding Tool、命令和进程执行；
- 实时观察、断线重连和持久事件重放；
- 权限策略、审批流程与三档权限界面；
- Context 选择、压缩和恢复机制；
- Verification 与 Completion Authority；
- Windows 原生受限 Runner 的基础实现。

仍在完善或尚未进入稳定支持范围的能力包括：

- Windows 三档权限从发布构件到 Daemon、API、Web 和真实执行的完整产品闭环；
- 面向所有平台的强隔离沙箱和通用进程树约束；
- MCP、Skills、Browser Agent、Computer Use 与 Web Search；
- Multi-Agent/Sub-Agent 编排和真正的并行 Tool 执行；
- 稳定的公共 SDK、版本兼容承诺和正式发布安装流程。

README 只描述当前产品能力和稳定边界。详细的内部演进历史保留在架构文档和 Git 记录中。

## 参与开发

欢迎通过 [Issues](https://github.com/GehrmannMerlin/Caelush/issues) 报告问题、讨论需求，或提交 Pull Request。

开始贡献前，请先：

1. 阅读 [AGENTS.md](./AGENTS.md) 中的架构与开发合同；
2. 阅读 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) 了解当前权威边界；
3. 为行为变化添加聚焦测试；
4. 运行与改动范围相匹配的检查；
5. 在提交前检查 `git status`、`git diff --check` 和完整差异。

如果你正在设计新的宿主、Provider、Tool、Runtime 或存储适配器，请优先扩展现有公开边界，而不是在应用层复制一套 Agent 实现。

---

<div align="center">

**Caelush — 让编程 Agent 的执行过程可理解、可恢复、可控制、可验证。**

</div>
