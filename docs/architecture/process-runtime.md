# Shell 与 Managed Process Runtime

Phase 9D keeps shell/process execution as an explicitly `UNCONFINED_LOCAL_PROCESS` local boundary. Runtime sanitizes child environments before launch; shell resolution remains fixed by the host platform and process adapters use `shell: false` for the adapter spawn itself. This is logical/policy hardening, not OS sandboxing.

Phase 8C 在现有 `LocalRuntime` 下增加统一的本地执行底座。`exec_command` 与 `write_stdin` 是薄 Tool handler；真正的执行路径是：

```text
ToolDispatcher / ToolBatchCoordinator
        ↓
Shell/Process Tool handler
        ↓
RuntimeResolver → stable LocalRuntime
        ↓
RuntimeWorkspaceScope.exec
        ↓
RuntimeExecService
        ↓
LocalProcessManager
      ↙             ↘
 Pipe adapter     PTY adapter
 child_process    node-pty
```

一次性命令和长进程使用同一个 `LocalProcessManager`。区别只在于进程是否在本次 `yield_time_ms` 到期前退出；yield 到期不会 kill、timeout 或取消进程。

## Workspace 与 Shell 边界

`exec_command.workdir` 是 workspace-relative，默认是 `.`。它复用 `WorkspacePathResolver`，同时经过 lexical containment 和 realpath containment 检查，必须存在且是目录；内部 symlink 只有在 realpath 仍位于 workspace 内时才允许。workdir 通过 child process 的 `cwd` 传递，绝不拼接成 `cd ... && command`。

模型不能指定任意 shell executable。POSIX 使用配置的可用 `SHELL`，否则 `/bin/sh -c command`；Windows 优先使用 PowerShell，缺失时使用 `cmd.exe`。所有 pipe spawn 都是显式 argv 且 `shell: false`。本轮允许继承宿主环境以获得 PATH、Node、pnpm 等能力，并只加入 `NO_COLOR=1`、`PAGER=cat`、`GIT_PAGER=cat` 以及 PTY 所需的 `TERM`；模型不能传 `env`。

## Process session

`LocalProcessManager` 由一个 `LocalRuntime` 实例长期持有，`openWorkspace()` 只创建 workspace-bound facade，不能为每个 Tool Call 创建 manager。每个 session 绑定 `ownerRunId`，因此进程可以跨 Step、ToolInvocation 和 provider turn，但不能跨 Run。

Session ID 使用 `proc_<runtime-generation>_<random>_<sequence>` 形式；generation 默认是随机值，测试可以注入确定值。Process session 仅存在于 manager 内存中，本轮不增加 process table、SQLite repository、migration、PID reattach 或 durable process state。Runtime dispose 会进行 best-effort cleanup；这不是 Run cancellation。

旧 generation 的 session 返回 `PROCESS_SESSION_STALE`，在 Tool handler 中转换为 `ToolExecutionUncertainError`，由 Dispatcher 记录 `UNCERTAIN_SIDE_EFFECT`。同一 generation 的随机未知 ID 和跨 Run 访问都 fail closed 为不泄漏归属信息的普通 session-not-found error。旧 command 不会自动重跑。

## Adapters 与输出

pipe adapter 使用 `node:child_process.spawn`，显式 `stdio: ["pipe", "pipe", "pipe"]`，分别接收 stdout/stderr，并把两路到达顺序合成为 model-facing transcript。PTY adapter 仅在 `tty: true` 时 lazy import exact-pinned `node-pty`，使用一个 merged terminal stream。Tool handler 不直接 import这两个实现。

每个 process 的 unread output 使用 1 MiB head/tail buffer；超出部分不会静默丢失，而是保留 omission marker 和 `omittedBytes`。每次 `exec_command` 或 `write_stdin` 只 drain 自上次交付后的新增内容，累计 metadata 保留 total bytes。输出经 streaming UTF-8 decoder、跨 chunk ANSI/OSC/CSI sanitizer 和 CRLF/CR → LF 处理；必要的 newline/tab 保留，其余 unsafe C0 controls 移除。Terminal sanitization 不是 Phase 9 secret redaction，当前 shell output 仍可能暴露宿主环境 secret，后续安全阶段负责该边界。

Tool handler 再施加 `MAX_EXEC_MODEL_OUTPUT_BYTES = 48 KiB`，之后仍经过通用 `ToolOutputPolicy`。details 只保留 bounded process metadata（status、session、exit/signal、tty、relative workdir、duration、output/omitted bytes，以及 `write_stdin` 的 accepted byte count），不复制完整 command、environment、PATH、transcript 或 stdin 内容。

## Tool semantics

新增且仅新增：

- `exec_command({ cmd, workdir?, tty?, yield_time_ms? })`
- `write_stdin({ session_id, chars?, yield_time_ms? })`

两者都使用严格 object schema 和 `additionalProperties: false`。`exec_command` 的 command 必须非空且不超过 64 KiB；`write_stdin` 的 chars 默认空字符串，空字符串只 poll、不写 stdin，非空输入先写后等待，输入上限 64 KiB。yield 合法范围是 250–30000ms；exec 默认 10000ms，空 poll 默认 5000ms，非空 write 默认 250ms。schema 不暴露 `timeout_ms`、`env`、任意 shell、sandbox、kill-after 或 permission 参数。

正常退出（包括 non-zero exit code 和 signal exit）仍是 `isError: false` 的成功 Tool result，结果中区分 `EXITED`、`exitCode` 和 `signal`。blank input、bad workdir、shell/PTY unavailable、process cap、spawn-before-start failure、unknown current session 和 closed stdin 才是普通 model-recoverable Tool error。process 启动后若 stdin/manager failure 无法证明副作用或进程状态，则转为 uncertain side effect；Tool Batch 的既有 uncertainty barrier 会跳过 trailing calls。

## Phase boundary

Phase 8C 不实现 capability decision、Permission/Approval、sandbox、retry、timeout policy、Run cancellation、process events、AgentState.activeProcesses bridge、Storage persistence、Git、Verification 或新的 default V1 catalog。可观察的执行结果仍通过既有 ToolDispatcher 的 durable ToolInvocation/Observation lifecycle；没有 `process.started` 等非 durable side channel。Process/file/shell effect bridge 保留给 Phase 8D。
