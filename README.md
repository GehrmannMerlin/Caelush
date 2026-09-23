<div align="center">

# Caelush

**A local-first, durable and extensible coding-agent kernel for CLI, Web and future agent hosts.**

面向通用 Coding Agent 的本地 Agent Kernel。
为 CLI、Web 与未来其他宿主提供统一的、可恢复、可观察、可取消、可验证、可扩展的 Agent Runtime。

</div>

---

## Overview

Caelush 不是一个简单将大语言模型接入聊天界面的 Demo。

它正在构建一套面向 Coding Agent 与通用 Agent 的 **execution infrastructure**，将模型调用、Agent Loop、Tool 生命周期、运行时执行、安全策略、持久化、验证、事件流以及用户界面拆分为独立且具有明确边界的模块。

CLI、Web 以及未来其他宿主共享同一套 Agent Kernel，而不是分别实现自己的 Agent Runtime。

Caelush 当前仍处于快速开发和 Architecture V2 重构阶段。

当前最新重构边界：

```text
Architecture V2

Phase 1   COMPLETE
Phase 2   COMPLETE
Phase 3   COMPLETE
Phase 4   COMPLETE
Phase 5A  COMPLETE
Phase 5B  COMPLETE
Phase 5C  COMPLETE
Phase 5D  NOT STARTED
```

---

## Why Caelush?

现代 Agent 项目往往很容易逐渐演变成一个巨大的 application service：

```text
UI
 ↓
Agent
 ↓
LLM
 ↓
Tools
 ↓
Filesystem / Shell
```

当 Tool、Prompt、模型适配、Session、Memory、Approval 和业务逻辑不断叠加后，Agent Runtime 很容易变得难以测试、难以恢复，也难以替换模型或宿主。

Caelush 尝试采用另一种方式：

```text
Host
  ↓
Agent Kernel
  ↓
AI / Context / Tools
  ↓
Security / Runtime
  ↓
Storage / Events
```

不同职责拥有明确的 authority 和 dependency boundary。

项目重点不是“让模型调用几个 Tool”，而是让一次 Agent Run 成为一个：

* 可持久化
* 可恢复
* 可取消
* 可验证
* 可审计
* 可扩展

的长期执行过程。

---

# Core Capabilities

## Durable Agent Runtime

Caelush 已建立完整的 durable Run 执行骨架，包括：

* Session / Run lifecycle
* resumable Agent execution
* durable state transitions
* Provider streaming
* Tool execution lifecycle
* durable event stream
* crash / restart recovery
* cancellation
* deadline / timeout
* bounded retry
* execution budget
* Approval workflow
* completion verification

Agent 的执行 authority 位于 Kernel，而不是 CLI 或 Web。

---

## Provider-neutral AI Layer

Architecture V2 引入了独立的：

```text
@caelush/ai
```

用于承载新的 AI domain。

当前包括：

* provider-neutral message model
* model metadata
* request contracts
* streaming contracts
* provider adapters
* OpenAI-compatible adapter
* Anthropic Messages adapter boundary

Provider-specific protocol 不直接进入 Agent Kernel。

```text
Agent
  ↓
AI Contract
  ↓
Provider Adapter
  ↓
Model Provider
```

旧的 `@caelush/llm` compatibility boundary 当前仍然存在，并将在后续 Architecture V2 migration 中继续收敛。

---

## Agent Kernel

通用 Agent 执行核心位于：

```text
@caelush/agent
```

主要负责：

* Agent Loop
* model-turn execution boundary
* Run execution driver
* Agent decisions
* Tool-turn coordination
* completion boundary
* durable continuation contract

Coding-specific 行为则逐渐迁移到：

```text
@caelush/coding-agent
```

从而避免通用 Agent Kernel 被 Coding Agent 的具体业务语义污染。

---

# Tool System

Caelush Tool System 不只是一个：

```text
name → function
```

映射。

一个 Tool invocation 会经过完整生命周期：

```text
Model Tool Call

      ↓

Schema validation

      ↓

Tool Registry

      ↓

Security / Approval Gate

      ↓

Runtime execution

      ↓

Observation

      ↓

Durable settlement

      ↓

ToolResult message

      ↓

Next Agent turn
```

系统支持：

* strict Tool schema
* Tool registration
* Tool dispatch
* invocation lifecycle
* Approval
* observation
* Tool Result
* deterministic feedback projection
* durable settlement
* recovery
* idempotency boundary

Coding Runtime 当前已经包含文件、搜索、Patch、Shell、managed process 与 Git 等能力。

---

# Durable Conversation

Architecture V2 Phase 5 正在重构 Caelush 的 Message / Conversation system。

Phase 5C 完成以后，生产 Run 的 durable conversation authority 已切换为：

```text
AgentMessageRecord[]
```

而不再由旧的 AI message history 直接承担持久化 authority。

当前 production write path：

```text
AgentMessageFactory

        ↓

AgentMessageRecordDraft

        ↓

RunExecutionStore

        ↓

SQLite durable record
```

执行链：

```text
USER

 ↓ durable V2 commit

Context / AgentLoop

 ↓

Provider

 ↓

ASSISTANT

 ↓ durable V2 commit

Tool execution

 ↓

TOOL_RESULT

 ↓ durable V2 commit

Next Provider turn
```

新的：

```text
USER
ASSISTANT
TOOL_RESULT
```

production writes 已经进入 Message V2 durable path。

---

## Current Compatibility Boundary

Phase 5C 并没有一次性删除所有旧系统。

当前仍然保留：

* Context / AgentLoop AI-compatible history projection
* legacy conversation readers
* migration compatibility
* legacy physical database columns
* client transcript compatibility
* `@caelush/llm` compatibility surface

这些内容属于后续 Phase 5D–5F。

因此当前系统采用的是渐进迁移，而不是一次性重写数据库和所有 consumer。

---

# Security

Caelush 将安全策略从 Runtime execution 中独立出来。

当前安全能力包括：

* Tool execution gate
* capability policy
* permission policy
* durable Approval
* sensitive path protection
* command policy
* secret redaction
* sanitized child-process environment
* workspace containment
* cancellation cleanup
* timeout cleanup

需要特别说明：

> Caelush 当前实现的是 logical / policy sandbox，而不是 OS-level hard sandbox。

Shell 或本地 Process 并不会被描述成完全隔离的安全执行环境。

未来如果引入 container、remote runtime 或真正的系统级 sandbox，它们将作为 Runtime implementation，而不是修改 Agent Kernel。

---

# Verification

Coding Agent 不应该仅仅因为模型输出：

```text
Done.
```

就认为任务已经完成。

Caelush 为此设计了独立 Verification subsystem。

当前包括：

* verification planning
* deterministic project checks
* evidence collection
* change review
* task acceptance review
* repair workflow
* completion authority

最终状态大致遵循：

```text
Agent Candidate

      ↓

Verification

      ↓

Evidence

      ↓

Acceptance

      ↓

Completion Authority

      ↓

Run COMPLETED
```

最终 Run completion authority 不属于模型本身。

---

# Architecture

Caelush 采用 CLI / Web 共核架构。

```text
┌───────────────────────────────────────────────┐
│                 Presentation                  │
│                                               │
│             CLI / Web / Future UI             │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│              Local Agent Service              │
│                                               │
│          HTTP API / SSE / Client API          │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│                  Agent Kernel                 │
│                                               │
│ AgentLoop / Run Driver / State / Completion   │
└───────────────┬─────────────────┬─────────────┘
                │                 │
                ▼                 ▼
┌───────────────────────┐ ┌───────────────────────┐
│      AI / Context     │ │      Tool System      │
│                       │ │                       │
│ Message / Provider    │ │ Registry / Feedback   │
└────────────┬──────────┘ └────────────┬──────────┘
             │                         │
             │                         ▼
             │             ┌───────────────────────┐
             │             │ Security / Runtime    │
             │             │                       │
             │             │ FS / Shell / Git      │
             │             └────────────┬──────────┘
             │                          │
             └──────────────┬───────────┘
                            ▼
                  ┌───────────────────────┐
                  │   Storage / Events    │
                  │                       │
                  │ SQLite / Replay       │
                  └───────────────────────┘
```

核心原则：

```text
Presentation does not own Agent execution.

Runtime does not own business policy.

Storage does not own execution logic.

Provider protocol does not leak into Agent Kernel.
```

---

# Repository Structure

```text
apps/

├─ daemon/
│  Local Agent Service
│  Production composition root
│
├─ cli/
│  Ink terminal client
│
└─ web/
   React / Vite web client


packages/

├─ agent/
│  Architecture V2 general Agent kernel
│
├─ ai/
│  Provider-neutral AI contracts and adapters
│
├─ client/
│  HTTP / SSE client
│
├─ coding-agent/
│  Coding-specific Agent capabilities
│
├─ context/
│  Workspace intelligence and context construction
│
├─ core/
│  Durable Run lifecycle and compatibility orchestration
│
├─ events/
│  AgentEvent / durable event boundary
│
├─ llm/
│  Legacy compatibility LLM boundary
│
├─ memory/
│  Memory subsystem
│
├─ observability/
│  Logging / tracing boundary
│
├─ protocol/
│  Stable cross-module contracts
│
├─ runtime/
│  Filesystem / process / Git runtime
│
├─ security/
│  Policy / Approval / secret protection
│
├─ shared/
│  Minimal cross-package utilities
│
├─ storage/
│  SQLite / Drizzle persistence
│
└─ verification/
   Verification / completion boundary


docs/
Architecture and engineering documentation

scripts/
Architecture checks, release and integration scripts

tests/
Architecture guards and integration tests
```

Caelush 使用 pnpm workspace monorepo。

Workspace 之间通过公共 package API 通信，Architecture Guards 会阻止 production code 通过 private `src/**` import 绕过模块边界。

---

# Tech Stack

| Area          | Technology          |
| ------------- | ------------------- |
| Language      | TypeScript          |
| Runtime       | Node.js 24          |
| Module system | ESM                 |
| Workspace     | pnpm 11             |
| HTTP          | Fastify 5           |
| Streaming     | SSE                 |
| Schema        | Zod / Ajv           |
| Storage       | SQLite              |
| ORM           | Drizzle ORM         |
| CLI           | Ink + React         |
| Web           | React + Vite        |
| Process       | node-pty            |
| Testing       | Vitest / Playwright |
| Lint          | ESLint              |
| Format        | Prettier            |

---

# Getting Started

## Requirements

```text
Node.js 24.x
pnpm 11.x
```

仓库通过 `packageManager` 固定 pnpm 版本，并提供 `.nvmrc`。

---

## Clone

```bash
git clone https://github.com/GehrmannMerlin/Caelush.git

cd Caelush
```

安装依赖：

```bash
pnpm install --frozen-lockfile
```

> Architecture V2 当前仍处于分支收敛阶段。在主分支完成整理之前，开发时应确认自己使用的是最新 Architecture V2 integration branch。

---

# Development

构建：

```bash
pnpm build
```

类型检查：

```bash
pnpm typecheck
```

测试：

```bash
pnpm test
```

Lint：

```bash
pnpm lint
```

Architecture checks：

```bash
pnpm check:architecture:ci
```

完整检查：

```bash
pnpm check
```

---

# Local Agent Service

Caelush 使用 Local Agent Service 作为 CLI / Web 与 Kernel 之间的统一入口。

构建：

```bash
pnpm --filter @caelush/daemon build
```

启动：

```bash
pnpm --filter @caelush/daemon start
```

Daemon 负责组合：

```text
Agent
AI
Context
Coding Agent
Runtime
Security
Storage
Events
Verification
```

客户端不会自己创建另一套 Agent Runtime。

---

# Provider Configuration

Provider credential 属于 Daemon 边界。

常用环境变量：

```text
CAELUSH_PROVIDER_ID

CAELUSH_PROVIDER_BASE_URL

CAELUSH_PROVIDER_API_KEY

CAELUSH_PROVIDER_ALLOWED_MODELS

CAELUSH_DEFAULT_PROVIDER

CAELUSH_DEFAULT_MODEL
```

OpenAI-compatible 示例：

```powershell
$env:CAELUSH_PROVIDER_ID = "openai-compatible"

$env:CAELUSH_PROVIDER_BASE_URL =
"https://your-provider.example/v1"

$env:CAELUSH_PROVIDER_API_KEY =
"<your-api-key>"

$env:CAELUSH_DEFAULT_PROVIDER =
"openai-compatible"

$env:CAELUSH_DEFAULT_MODEL =
"<your-model>"
```

Provider API Key 不由 CLI / Web 请求传递。

---

# CLI

Caelush 提供交互式 CLI：

```bash
caelush
```

诊断：

```bash
caelush doctor
```

版本：

```bash
caelush --version
```

帮助：

```bash
caelush --help
```

---

## Non-interactive Mode

适用于脚本、自动化以及 CI：

```bash
caelush -p "Explain this project"
```

JSON：

```bash
caelush -p "Inspect the repository" \
  --output-format json
```

Streaming JSON：

```bash
caelush -p "Run the task" \
  --output-format stream-json
```

CLI 是 thin client。

下面这些能力仍然属于 Daemon / Kernel：

```text
Agent Loop
Tool execution
Approval
Session persistence
Run recovery
Verification
Completion authority
```

---

# Web

Web Client 位于：

```text
apps/web
```

技术栈：

```text
React
Vite
@caelush/client
```

构建：

```bash
pnpm --filter @caelush/web build
```

Web Host 不会在浏览器中重新实现：

* Agent Loop
* Provider runtime
* Tool runtime
* Storage
* Security policy

它通过 Local Agent Service 与同一套 Kernel 通信。

---

# Architecture V2

Caelush 当前正在进行 Architecture V2 重构。

这次重构的主要目标不是简单调整目录，而是重新确定各个系统的 authority。

---

## Current Progress

| Phase | Scope                                       | Status        |
| ----- | ------------------------------------------- | ------------- |
| 1     | Architecture foundation & public boundaries | ✅ Complete    |
| 2     | AI core contracts & Provider migration      | ✅ Complete    |
| 3     | Agent Kernel & Run execution migration      | ✅ Complete    |
| 4     | Tool System V2                              | ✅ Complete    |
| 5A    | Message domain foundation                   | ✅ Complete    |
| 5B    | Message storage foundation                  | ✅ Complete    |
| 5C    | Durable conversation runtime cutover        | ✅ Complete    |
| 5D    | Context / Replay conversation migration     | ⏳ Not started |
| 5E    | Message migration continuation              | ⏳ Not started |
| 5F    | Compatibility closure                       | ⏳ Not started |

---

# Latest Refactor Result

## Phase 5C — Durable Conversation Runtime Cutover

Phase 5C 将生产 Run 的 durable conversation authority 从 legacy conversation write path 切换到：

```text
AgentMessageRecord[]
```

新的 production execution flow：

```text
User message

      ↓

Durable V2 USER record

      ↓

Context / AgentLoop

      ↓

Provider

      ↓

Validated Assistant result

      ↓

Durable V2 ASSISTANT record

      ↓

Tool settlement

      ↓

Durable V2 TOOL_RESULT record

      ↓

Next Agent turn
```

Storage 现在只负责 durable record / sequence authority。

Semantic message creation 由 Message Factory 负责。

Run lifecycle 与 atomic settlement 仍由 RunController 负责。

Tool lifecycle 和 feedback receipt 仍由 Tool coordinator 负责。

---

## Phase 5C Verification

最终 clean checkout 验证：

```text
pnpm install --frozen-lockfile
PASS

pnpm build
PASS

pnpm typecheck
PASS

pnpm lint
PASS

pnpm check:architecture:ci
PASS
```

Phase 5C targeted tests：

```text
10 files
109 tests passed
0 failed
```

Full parallel Vitest：

```text
458 files passed

3368 tests passed

5 skipped

0 failed
```

Architecture readiness：

```text
active rules:               276
scanned source files:       654

legacy violations frozen:   26
new violations:             0
stale baseline entries:     0

private production imports: 0
cross-workspace imports:    0

readiness: READY
```

完整 serial Vitest 在当前 Windows host 上存在可复现的 startup blockage，因此记录为：

```text
INCONCLUSIVE
```

而不是测试失败。

---

## V1 Implementation Boundary

Architecture V2 的 Message / Conversation migration 与 V1 Runtime 能力是两条并行的演进线。当前仓库仍保留并维护以下已经完成的 V1 边界：

* Phase 9C — Sensitive Resource Policy, Command Policy & Secret Redaction: **COMPLETED**
* Phase 9D — V1 Security Integration, Logical Sandbox Boundary & Finalization: **COMPLETED**
* Phase 11B — Verification Execution: **COMPLETED**
* Phase 11D — Completion Authority & Finalization: **COMPLETED**

这些阶段属于既有 Runtime / Security / Verification 基线；README 上方的 Phase 5C 状态描述的是 Architecture V2 的当前 migration 进度。

---

# Roadmap

Architecture V2 当前首先继续完成 Message / Session migration。

随后才逐步扩展更上层的 Agent 能力。

尚未宣称完成的能力包括：

* Message V2 Phase 5D–5F
* MCP production integration
* Skills system
* Browser Agent
* Computer Use
* Web Search
* Multi-Agent
* Sub-Agent
* true parallel Tool execution
* OS-level hard sandbox
* fully stabilized public SDK

Caelush 当前更适合作为：

```text
Agent Runtime research

Coding Agent architecture development

Local-first Agent infrastructure

Durable Agent execution experimentation
```

而不是被视为 API 已冻结的稳定发行版本。

---

# Documentation

建议从下面几部分开始了解项目：

* [Architecture Overview](docs/architecture/README.md)
* [Package Boundaries](docs/architecture/package-boundaries.md)
* [Architecture V2](docs/architecture/v2/)
* [Protocol](docs/architecture/protocol-v1.md)
* [Agent Loop](docs/architecture/agent-loop.md)
* [Context](docs/architecture/context-and-project-intelligence.md)
* [Runtime](docs/architecture/runtime.md)
* [Security](docs/architecture/security.md)
* [Verification](docs/architecture/verification.md)
* [Storage & Events](docs/architecture/storage-and-events.md)
* [Local Agent Service](docs/architecture/local-agent-service.md)

Architecture V2 下的 Phase Report 与 Acceptance Map 主要用于记录 migration evidence 和 architecture acceptance。

它们属于工程记录，而不是 README 的主体。

---

# Project Status

Caelush 仍在持续开发与重构中。

当前核心原则：

> **先稳定 Agent Kernel、durable execution model 与跨模块 Contract，再扩展 MCP、Skills、Browser、Computer Use、Web Search 与 Multi-Agent 等上层能力。**

README 只维护：

```text
What Caelush is

What Caelush can do

How Caelush works

How to run Caelush

Current architecture boundary
```

详细阶段施工记录应留在 Architecture documentation 中，而不是继续堆积到仓库首页。
