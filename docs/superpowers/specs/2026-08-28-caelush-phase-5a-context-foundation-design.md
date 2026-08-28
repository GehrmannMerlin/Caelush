# Caelush Phase 5A — Workspace & Project Intelligence Foundation

## Goal

建立 `@caelush/context` 的只读、确定性、可验证项目情报发现能力：从一个已有的 `WorkspaceRef` 解析受边界保护的 workspace scope，识别 project root、宿主环境、项目生态与 package metadata，并按项目根到 cwd 的顺序发现项目级指令。输出只包含事实、证据、来源和诊断，不组装 LLM prompt。

## Scope and non-goals

本阶段只实现 workspace/project discovery。明确不实现 AgentLoop、ContextBuilder 最终组装、相关源文件选择、递归仓库扫描、Tool/Runtime/Security/Storage/Events/Daemon 集成、Shell 或网络探测、LLM 调用、RAG、embedding、summarization 和 token budget。

## Architecture

```text
WorkspaceRef
    │
    ▼
WorkspaceScopeResolver
    │
    ▼
ProjectRootDetector
    │
    ├───────────┐
    ▼           ▼
Environment   ProjectProfile
    │           │
    └─────┬─────┘
          ▼
Instruction Discovery
          │
          ▼
ProjectIntelligenceSnapshot
```

`ContextFileSystem` 是 read-only port，只暴露 metadata、bounded text read、directory listing 和 realpath；Node adapter 是唯一接触 `node:fs/promises` 的实现。`ProjectInspector` 只编排各个 detector，并通过依赖注入接收 filesystem 和 detector；不存在 global singleton 或缓存。

## Workspace boundary

`WorkspaceRef.path` 必须是 absolute path；不得相对 `process.cwd()` 猜测。workspace 必须存在且为 directory。缺省 cwd 为 workspace path；相对 cwd 相对于 workspace logical root 解析，absolute cwd 直接使用。logical root/cwd 与 realpath 后的 real root/real cwd 都必须通过 `path.relative` 判定为 root 内部或等于 root，拒绝 `..`、absolute escape 和 symlink escape。这个边界只保护 Context read，不替代未来 PermissionManager/Sandbox。

## Project root algorithm

从 real cwd 向上搜索直到且包括 workspace real root，严格按 tier 处理：

1. 最近的 `.git`（directory 或 git-worktree file）→ `VCS_MARKER`。
2. 最近的 workspace marker：`pnpm-workspace.yaml`、`lerna.json`、`nx.json`、`rush.json`，或 `package.json` 明确含 `workspaces` → `WORKSPACE_MARKER`。
3. 最近的已知 project manifest：`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`pom.xml`、`build.gradle`、`build.gradle.kts` → `PROJECT_MANIFEST`。
4. 没有证据则使用 cwd → `CWD_FALLBACK`。

每次结果包含 `projectRoot`、`reason`，以及可用的 `marker`/`evidencePath`。不访问 workspace parent，不依赖 directory enumeration order。

## Environment and profile

Environment 只读取 allowlisted host facts：`process.platform`、`process.arch`、`process.version` 和 path style；不读取 `process.env`、shell 变量、credentials 或 provider metadata。

Profile 只检查 project root 到 cwd 路径上的已知文件，不递归扫描。V1 识别 NODE、PYTHON、RUST、GO、JAVA，并保留 manifest path/type/relative path evidence。Node `package.json` 只解析 `name`、`packageManager`、`engines.node`、`scripts` 和 `workspaces`；scripts 按名字排序。profile 区分 root package 和 cwd 路径上最近的 active package。package manager 优先使用 root `packageManager` 字段，否则仅使用 project root lockfile；多个 lockfile 冲突时返回 `UNKNOWN` 并写 diagnostic。Python 只在 `uv.lock`/`poetry.lock` 存在时提供 manager signal；Rust/Go/Java 使用各自 manifest tool evidence。Malformed manifest 生成 `MALFORMED_MANIFEST` warning 并继续探测。

## Project instructions

逐级扫描 project root 到 cwd，每个目录最多选择一个文件：`AGENTS.override.md` > `AGENTS.md` > fallback（默认 `CLAUDE.md`）。同目录 override 即使为空也赢得选择；空白文件不进入 entries。entries 以 root-to-cwd 顺序保存，并包含 path、relativePath、kind、depth、content、bytes、truncated。总默认 byte budget 为 `32768`；超出时读取 safe UTF-8 prefix、设置 `truncated` 并停止后续读取。无效 UTF-8、不可读文件或 realpath 越过 workspace 必须抛出 typed `ContextInstructionError`，不能静默跳过。文本中的 `@reference` 和远程 URL 只保留为文本，不跟随、不 fetch；不读取 global user instructions。

## Public result

```ts
interface ProjectIntelligenceSnapshot {
  workspace: WorkspaceScope;
  projectRoot: ProjectRootDetectionResult;
  environment: EnvironmentSnapshot;
  profile: ProjectProfile;
  instructions: ProjectInstructions;
  diagnostics: readonly ContextDiagnostic[];
}
```

Snapshot 是 runtime value，不是 Storage snapshot；不含 `LLMMessage`、prompt、完整源文件正文、DB 类型或 provider SDK 类型。

## Errors and diagnostics

Public errors 为最小层级：`ContextError`、`ContextInvalidWorkspaceError`、`ContextBoundaryError`、`ContextInstructionError`、`ContextIOError`。项目 manifest parse failure 是可继续的 `ContextDiagnostic`；instruction read failure 是 fatal typed error，因为忽略项目规则具有安全后果。

## Verification

测试覆盖 workspace path/cwd/symlink boundary、所有 root tiers、环境 allowlist、各生态与 manager evidence、monorepo/root-active package、malformed package JSON、instruction precedence/hierarchy/budget/UTF-8/error/boundary、ProjectInspector E2E、fresh re-inspection、public API 和 package dependency/static audits。生产 context source 不得出现 `process.env`、`child_process`、network/LLM imports 或 explicit `any`。
