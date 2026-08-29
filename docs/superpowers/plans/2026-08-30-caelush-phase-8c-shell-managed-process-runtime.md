# Caelush Phase 8C — Shell Execution & Managed Process Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified local execution substrate that supports bounded one-shot shell commands and reusable pipe/PTY process sessions through the two new `exec_command` and `write_stdin` Tools.

**Architecture:** `LocalRuntime` owns one long-lived `LocalProcessManager` and exposes a workspace-bound `RuntimeExecService` through `RuntimeWorkspaceScope.exec`. The manager creates a controlled shell launch description, chooses a pipe or PTY adapter, stores in-memory process sessions keyed by opaque runtime-generation IDs, incrementally drains bounded output, and enforces Run ownership. Tool handlers remain thin and use the same `RuntimeResolver`; the Dispatcher continues to own durable ToolInvocation/Observation lifecycle and uncertainty barriers.

**Tech Stack:** TypeScript/ESM, Node `child_process.spawn` with `shell: false`, exact-pinned `node-pty@1.1.0` behind a runtime-only adapter, Vitest, Zod/JSON-schema Tool contracts, existing `@caelush/runtime` and `@caelush/tools` package boundaries.

**Spec:** User-provided Phase 8C specification in `C:\Users\韩吉衍\.codex\attachments\fd4fd41d-ae68-4369-ac9e-27a125f10cb5\pasted-text.txt`.

## Global Constraints

- Phase 8 contains exactly 8A, 8B, 8C and 8D; this work is entirely Phase 8C.
- Reuse `LocalRuntime`, `RuntimeResolver`, `RuntimeWorkspaceScope`, `WorkspacePathResolver`, `ToolDispatcher`, `ToolBatchCoordinator`, and existing uncertainty semantics; do not create V2 APIs.
- Runtime depends only on protocol/shared; runtime must not depend on tools, core, storage, events, llm, security, or verification.
- Tool handlers must never import `node:child_process` or `node-pty`; all spawning goes through `RuntimeExecService` and `LocalProcessManager`.
- Model input is `{ cmd, workdir?, tty?, yield_time_ms? }`; there is no `timeout_ms`, `env`, arbitrary shell executable, detach, kill, approval, retry, cancellation, or BudgetManager input.
- `yield_time_ms` controls how long the call waits before returning; it never kills a process and is not a process timeout.
- `exec_command` and `write_stdin` share the same stable `LocalRuntime`/`LocalProcessManager`; process sessions are in-memory only and owned by exactly one Run.
- Cross-Run and stale-generation access fail closed; stale sessions map to `ToolExecutionUncertainError` and `UNCERTAIN_SIDE_EFFECT`, while same-generation unknown sessions are model-recoverable.
- Workdir is workspace-relative and resolved through `WorkspacePathResolver`; workspace containment is not a shell/filesystem sandbox.
- `child_process.spawn` uses `shell: false`, with shell semantics represented by controlled executable plus argv; command and cwd remain separate.
- Runtime retained output is bounded to 1 MiB using head/tail omission accounting; each Tool result is bounded to 48 KiB before existing 64 KiB `ToolOutputPolicy`.
- Terminal output uses streaming UTF-8 decoding, ANSI/CSI/OSC/control sanitization, and newline normalization; command, stdin, and inherited environment are not duplicated into result details.
- Non-zero exit codes and signal exits are successful Tool results with exit metadata, not Tool infrastructure failures.
- No process table, migration, process domain-event side channel, direct `AgentState.activeProcesses` mutation, GitRuntime, `git_status`, `git_diff`, PermissionEvaluator, Approval resolution, Run cancellation, command timeout, retry, or VerificationRunner is added.
- Every behavior change follows RED → GREEN → focused regression; final verification includes `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check`.

## File Map

- Create `packages/runtime/src/exec/contracts.ts`: provider-independent request/result, adapter, session, and process state interfaces.
- Create `packages/runtime/src/exec/errors.ts`: typed runtime execution, session, spawn, stdin, and uncertainty errors.
- Create `packages/runtime/src/exec/shell-resolver.ts`: platform-controlled shell executable/argv resolution.
- Create `packages/runtime/src/exec/output-buffer.ts`: bounded head/tail byte buffer with omitted-byte accounting and unread draining.
- Create `packages/runtime/src/exec/terminal-output.ts`: incremental UTF-8 decoder, terminal escape/control sanitization, and newline normalization.
- Create `packages/runtime/src/exec/pipe-process-adapter.ts`: `child_process.spawn` pipe implementation.
- Create `packages/runtime/src/exec/pty-process-adapter.ts`: lazy `node-pty` implementation.
- Create `packages/runtime/src/exec/process-manager.ts`: generation-aware in-memory session store, ownership, limits, lifecycle, cleanup, and interaction.
- Create `packages/runtime/src/exec/service.ts`: workspace-bound `RuntimeExecService` facade and workdir validation.
- Create `packages/runtime/src/exec/index.ts`: internal exec exports.
- Modify `packages/runtime/src/runtime.ts`, `local-runtime.ts`, `workspace-scope.ts`, `index.ts`, `runtime-errors.ts`, and `packages/runtime/package.json` for the public runtime capability and exact `node-pty` dependency.
- Create `packages/tools/src/builtins/exec-command.ts`, `write-stdin.ts`, and `shell-tools.ts`; modify `builtins/result.ts`, `index.ts`, and package exports as needed.
- Create focused runtime/tool/integration tests under `packages/runtime/test`, `packages/tools/test`, `packages/storage/test`, `packages/core/test`, and `tests/architecture` following existing fixtures.
- Create `docs/architecture/process-runtime.md`; modify `docs/architecture/runtime.md`, `docs/architecture/tool-system.md`, `README.md`, and `AGENTS.md` with explicit Phase 8C boundaries.

## Architecture References

| Source                                                                                                                               | Observed design                                                                                                                      | What Caelush adopts                                                                                                                                       | What Caelush intentionally does not copy                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Codex UnifiedExec module](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/mod.rs)                   | One substrate owns interactive processes, one-shot completion, bounded output, reusable process store, and explicit yield constants. | One manager serves one-shot and interactive calls; opaque sessions, bounded output, separate poll/write semantics, and explicit yield range.              | Codex approval orchestration, sandbox transforms, cancellation, retries, remote exec-server paths, and timeout policy. |
| [OpenAI Codex process implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process.rs)           | A transport-neutral process wrapper coordinates output tasks, lifecycle state, stdin, exit observation, and output draining.         | Transport-neutral `ManagedProcessAdapter`, incremental drain, explicit STARTING/RUNNING/EXITED/FAILED state, and final-output observation before removal. | Tokio, sandbox denial retries, network approval, plugin metrics, and force-kill/abort behavior.                        |
| [OpenAI Codex process manager](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)          | Process store has a hard process cap, opaque/deterministic test IDs, bounded yield, and reusable process lookup.                     | Runtime-generation session IDs, injectable factories, hard process cap, no silent eviction, and same-run ownership checks.                                | Codex global process IDs, background timeout, cancellation tokens, approval context, and remote process support.       |
| [OpenAI Codex head/tail buffer](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/head_tail_buffer.rs)        | Retains both beginning and end of output and reports omitted bytes instead of silently truncating.                                   | 1 MiB head/tail retained output and explicit omission metadata before a second model-facing bound.                                                        | Codex token-specific truncation APIs and provider/UI-specific formatting.                                              |
| [OpenAI Codex one-shot path](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/oneshot.rs)                    | One-shot execution is a use of the same process machinery and waits until exit or a bounded collection point.                        | Short commands return exit metadata; still-running commands return a reusable session without termination.                                                | Timeout and abort termination behavior.                                                                                |
| [OpenAI Codex exec handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs) | Tool handler normalizes command/yield input and delegates process work to unified runtime.                                           | Thin `exec_command` handler validates only Tool input and delegates to runtime; Dispatcher remains lifecycle owner.                                       | Sandbox/approval/policy orchestration and provider-specific metadata.                                                  |
| [OpenAI Codex shell spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/shell_spec.rs)                  | Shell launch behavior is separated from process execution and platform-specific shell details.                                       | `LocalShellResolver` returns executable plus argv; cwd is passed as spawn option and `shell:false` is invariant.                                          | Login-shell permission profiles, arbitrary shell selection, command scanning, and permission prompts.                  |
| [OpenCode shell implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/shell.ts)                  | Shell tools construct command/cwd/env separately, collect bounded output, and expose truncation metadata.                            | Separate command/cwd, inherited environment without metadata duplication, bounded observed output, and process cleanup discipline.                        | OpenCode permission asks, shell parser/LSP/frontend coupling, arbitrary configured shell, and timeout/retry behavior.  |

## Implementation Tasks

### Task 1: Git baseline and isolated worktree

**Files:** Existing Git metadata only; no source changes.

- [x] Verify `origin` is `https://github.com/GehrmannMerlin/Caelush.git`, run `git fetch origin --prune`, and record actual refs.
- [x] Verify `837dd59795a34e4aff6254d2dbbf398df5bdb09f` is not an ancestor of `origin/master`; select `origin/codex/phase-8b-safe-file-mutation-patch-engine` as `BASE_REF`.
- [x] Use `.worktrees/phase-8c-shell-managed-process-runtime` on branch `codex/phase-8c-shell-managed-process-runtime`.
- [x] Run `pnpm install --frozen-lockfile`; baseline is 165 files, 574 tests, 4 skipped, 0 failures, lint/typecheck/build pass, and 466 format-warning files after a successful build.

### Task 2: Research and codebase reconnaissance

**Files:** No source changes; research is captured above and in the plan.

- [x] Read the current Codex UnifiedExec module, process, process state, manager, head/tail buffer, one-shot, handler, and shell-spec sources.
- [x] Inspect current OpenCode shell/process handling and note pipe lifecycle, bounded collection, and cleanup concerns.
- [x] Scan Phase 8B runtime/tools/core/protocol code and existing architecture tests before selecting names.

### Task 3: Runtime exec contracts and error taxonomy

**Files:** Create `packages/runtime/src/exec/contracts.ts`, `packages/runtime/src/exec/errors.ts`, `packages/runtime/src/exec/index.ts`, `packages/runtime/test/exec-contracts.test.ts`; modify `packages/runtime/src/runtime-errors.ts` and `packages/runtime/src/index.ts`.

**Interfaces:**

```ts
export interface RuntimeExecRequest {
  readonly ownerRunId: RunId;
  readonly command: string;
  readonly workdir?: string;
  readonly tty: boolean;
  readonly yieldTimeMs: number;
}

export interface RuntimeProcessInteractionRequest {
  readonly ownerRunId: RunId;
  readonly sessionId: string;
  readonly chars: string;
  readonly yieldTimeMs: number;
}

export interface RuntimeExecResult {
  readonly status: "RUNNING" | "EXITED";
  readonly sessionId?: string;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly totalOutputBytes: number;
  readonly omittedBytes: number;
}

export interface RuntimeExecService {
  execute(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult>;
}
```

- [x] Write tests asserting request/result shapes are provider/tool independent and errors expose only stable codes: `INVALID_COMMAND`, `INVALID_YIELD_TIME`, `PROCESS_LIMIT_REACHED`, `SHELL_UNAVAILABLE`, `PTY_UNAVAILABLE`, `PROCESS_SESSION_NOT_FOUND`, `PROCESS_SESSION_STALE`, `SPAWN_FAILED`, `STDIN_UNAVAILABLE`, `PROCESS_UNCERTAIN`.
- [ ] Run `pnpm vitest run packages/runtime/test/exec-contracts.test.ts`; expect RED because contracts/errors do not exist.
- [x] Add the minimal interfaces/classes, export them only through runtime package indexes, and preserve existing `RuntimeError` style.
- [ ] Run the focused test and package typecheck; expect GREEN.

### Task 4: Controlled LocalShellResolver

**Files:** Create `packages/runtime/src/exec/shell-resolver.ts`, `packages/runtime/test/shell-resolver.test.ts`.

**Interfaces:**

```ts
export interface ShellLaunch {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface LocalShellResolver {
  resolve(command: string): ShellLaunch;
}
```

- [ ] Write platform-independent tests using an injected `{ platform, env, executableExists }` probe: POSIX returns configured shell or `/bin/sh` with `-c command`; Windows prefers PowerShell and falls back to `cmd.exe`; no result accepts a model-provided executable.
- [ ] Run the focused test and observe RED.
- [x] Implement deterministic resolution with `shell:false` assumptions, `-NoLogo -NoProfile -NonInteractive -Command command` for PowerShell, `/d /s /c command` for cmd, and `-c command` for POSIX.
- [ ] Add tests proving command text is one argv element and workdir is never embedded as `cd ...`.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 5: Process state, generation, IDs, and limits

**Files:** Modify `contracts.ts`; create `packages/runtime/src/exec/process-state.ts`, `packages/runtime/test/process-state.test.ts`.

- [ ] Write RED tests for STARTING/RUNNING/EXITED/FAILED transitions, opaque `proc_<generation>_<random>` IDs, injected deterministic factories, generation extraction, stale-generation detection, and default `MAX_MANAGED_PROCESSES = 32`.
- [ ] Implement immutable state helpers and factories; never use sequential guessable IDs.
- [ ] Test that stale means “cannot prove old external process state”, not “safe to rerun”.

### Task 6: Bounded head/tail output buffer

**Files:** Create `packages/runtime/src/exec/output-buffer.ts`, `packages/runtime/test/output-buffer.test.ts`.

**Interfaces:**

```ts
export interface OutputBufferSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
}

export class HeadTailOutputBuffer {
  constructor(maxBytes?: number, headBytes?: number);
  append(text: string): void;
  drain(): OutputBufferSnapshot;
  snapshot(): OutputBufferSnapshot;
}
```

- [ ] Write RED tests for under-limit preservation, head + omission marker + tail retention, UTF-8 byte accounting, cumulative total/omitted bytes, and drain returning new unread data without erasing cumulative counters.
- [x] Implement a byte-safe bounded buffer with 1 MiB default, deterministic omission marker `... <N> bytes omitted ...`, and no silent truncation.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 7: Streaming terminal decoder and sanitizer

**Files:** Create `packages/runtime/src/exec/terminal-output.ts`, `packages/runtime/test/terminal-output.test.ts`.

**Interfaces:**

```ts
export class TerminalOutputDecoder {
  push(chunk: Uint8Array): string;
  end(): string;
}
export function sanitizeTerminalOutput(value: string): string;
```

- [ ] Write RED tests for split multibyte UTF-8, invalid bytes becoming U+FFFD, ANSI SGR/CSI removal, OSC title/clipboard removal, control character removal while preserving tab/newline, CRLF/CR normalization, and Unicode preservation.
- [x] Implement `StringDecoder("utf8")`, conservative ANSI/OSC/CSI/control filtering, and terminal newline normalization.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 8: PipeProcessAdapter

**Files:** Create `packages/runtime/src/exec/pipe-process-adapter.ts`, `packages/runtime/test/pipe-process-adapter.test.ts`.

**Interfaces:**

```ts
export interface ManagedProcessAdapter {
  readonly tty: boolean;
  onOutput(listener: (event: ProcessOutputEvent) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  write(chars: string): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] Write RED integration tests using real child processes: quick success, exit 7, stdout/stderr separation, long-running stdin interaction, split Unicode, spawn-before-start failure, and `shell:false` launch inspection.
- [x] Implement only `spawn(resolved.executable, resolved.args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] })`; attach incremental listeners immediately and use terminal decoder per stream.
- [ ] Make spawn failure typed and distinguish never-started failures from post-start output/exit ambiguity.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 9: Lazy isolated PtyProcessAdapter

**Files:** Modify `packages/runtime/package.json`, `pnpm-lock.yaml`; create `packages/runtime/src/exec/pty-process-adapter.ts`, `packages/runtime/test/pty-process-adapter.test.ts`.

- [x] Pin `node-pty` exactly to the observed stable `1.1.0`, install it with the workspace lockfile, and record install/build output.
- [ ] Write RED tests for adapter construction, PTY merged output, interactive input, sanitized terminal output, and a real PTY smoke command; use an explicit native-backend skip only when the test environment reports a concrete unsupported backend error.
- [x] Implement a lazy dynamic import of `node-pty` confined to this adapter, spawn a controlled executable/argv with cwd/env/TERM, merge PTY output, and map exit events to `ProcessExit`.
- [ ] Add an architecture test proving no Tool source imports `node-pty` and run focused PTY/typecheck tests.

### Task 10: LocalProcessManager store and lifecycle

**Files:** Create `packages/runtime/src/exec/process-manager.ts`, `packages/runtime/test/process-manager.test.ts`.

- [ ] Write RED tests for one session start, same-generation lookup, process cap at 32, no silent eviction of running sessions, background exit retention, final output observation before removal, repeated poll no duplicate output, and `dispose()` cleanup.
- [x] Implement a manager-owned `Map<string, ProcessEntry>` with one runtime generation, active-process counting, adapter event accumulation, output draining, and best-effort close on dispose.
- [ ] Ensure a process started before yield can return RUNNING, while a quick exited process returns EXITED without a reusable session ID.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 11: RuntimeExecService and workdir validation

**Files:** Create `packages/runtime/src/exec/service.ts`; modify `local-runtime.ts`, `workspace-scope.ts`, `runtime.ts`; create `packages/runtime/test/exec-service.test.ts`.

- [ ] Write RED tests for default `.`, existing directory acceptance, workspace-relative path resolution through `WorkspacePathResolver`, outside-workspace rejection, file-as-workdir rejection, internal contained symlink acceptance according to 8A read semantics, command blank/64 KiB validation, and yield default/hard range.
- [x] Implement `LocalRuntimeExecService` as a workspace-bound facade over one manager, with no Tool/Core/Storage/Event dependencies and no timeout/abort/retry.
- [ ] Add `exec` to `RuntimeWorkspaceScope`; `LocalRuntime` constructs exactly one `LocalProcessManager` in its constructor and `openWorkspace()` returns a facade over it.
- [ ] Run focused tests and package build/typecheck; observe GREEN.

### Task 12: Runtime shutdown and stable resolver integration

**Files:** Modify `local-runtime.ts`, `runtime-ref.ts`, `index.ts`; create/extend `packages/runtime/test/local-runtime-exec-lifecycle.test.ts`.

- [ ] Write RED tests proving two calls to `openWorkspace()` from the same `LocalRuntime` share the same manager/session store and `dispose()` prevents further process leakage.
- [x] Implement `LocalRuntime.dispose()` and preserve stable `SingleRuntimeResolver` identity behavior.
- [ ] Run all runtime tests and architecture package-boundary tests; observe GREEN.

### Task 13: `exec_command` Tool contract and handler

**Files:** Create `packages/tools/src/builtins/exec-command.ts`; modify `builtins/result.ts`, `index.ts`; create `packages/tools/test/exec-command.test.ts`.

- [ ] Write RED tests for strict `{ cmd, workdir?, tty?, yield_time_ms? }`, default `workdir="."`, default yield, hard yield range, 64 KiB command byte limit, no timeout/env/shell fields, no full command echo, successful exit 7 with `isError:false`, and RUNNING result with session ID.
- [x] Implement definition metadata `CRITICAL`, `SHELL_EXEC`, `PROCESS_START`, `runtimeKinds: ["local"]`, and a thin handler that resolves the runtime scope and maps only typed runtime errors to sanitized model-recoverable `errorResult` values.
- [x] Bound content to 48 KiB before returning `successResult`; details include status, exitCode/signal/sessionId, output/omission counters, but not command/env/stdin.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 14: `write_stdin` Tool contract and handler

**Files:** Create `packages/tools/src/builtins/write-stdin.ts`; modify `builtins/result.ts`, `index.ts`; create `packages/tools/test/write-stdin.test.ts`.

- [ ] Write RED tests for strict `{ session_id, chars?, yield_time_ms? }`, empty chars as poll, non-empty input byte limit, default poll/write yields, no `timeout_ms`, no command echo, incremental no-duplicate output, and RUNNING/EXITED results.
- [x] Implement conservative metadata `CRITICAL`, `SHELL_EXEC`, `PROCESS_START`, `PROCESS_KILL`, delegate to `scope.exec.interact`, and map same-generation unknown session to `PROCESS_SESSION_NOT_FOUND`.
- [x] Map stale-generation and post-spawn/input ambiguity to `ToolExecutionUncertainError`; do not expose owner Run or raw input in content/details.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 15: Shared shell Tool registration factory

**Files:** Create `packages/tools/src/builtins/shell-tools.ts`; modify `index.ts`; create `packages/tools/test/shell-tools.test.ts`.

- [ ] Write RED tests proving `createShellToolRegistrations(resolver)` returns exactly two definitions in fixed order, both use the caller-supplied resolver, and default construction creates one shared `LocalRuntime` resolver.
- [x] Implement the factory and export it only from `@caelush/tools` public API.
- [ ] Run focused tests and catalog consistency tests; observe GREEN.

### Task 16: Tool output schemas and Dispatcher uncertainty bridge

**Files:** Modify `builtins/result.ts`, `dispatcher.ts` only if required; create `packages/tools/test/exec-dispatcher.test.ts`.

- [ ] Write RED tests for output-schema validation of RUNNING/EXITED results, sanitized details, `ToolExecutionUncertainError → UNCERTAIN_SIDE_EFFECT`, and ordinary runtime errors remaining model-recoverable.
- [ ] Keep the existing Dispatcher lifecycle unchanged: requested → started → completed/failed durable Tool events, with no direct process/shell events.
- [ ] Add only the minimum output schema properties and error mapping required for both shell Tools; do not persist process sessions or add a DB table.
- [ ] Run focused Dispatcher tests and existing Phase 7 recovery tests; observe GREEN.

### Task 17: Run ownership and stale-generation safety

**Files:** Extend `process-manager.ts`, `errors.ts`, `packages/runtime/test/process-ownership.test.ts`, `packages/tools/test/stale-process-uncertainty.test.ts`.

- [ ] Write RED tests for same-Run interaction success, cross-Run fail-closed with generic `PROCESS_SESSION_NOT_FOUND` and zero stdin write, stale generation detection after new `LocalRuntime`, stale mapping to `ToolExecutionUncertainError`, and no blind command replay.
- [ ] Implement ownership checks before adapter access and generation checks before same-generation lookup; never include owner Run or stale generation in model-visible content.
- [ ] Run focused tests and typecheck; observe GREEN.

### Task 18: Spawn and stdin uncertainty domains

**Files:** Extend adapter/manager/service errors; create `packages/runtime/test/uncertainty-domains.test.ts`, `packages/tools/test/uncertainty-domains.test.ts`.

- [ ] Write RED tests distinguishing spawn failure before successful start (recoverable), cleanup-proven post-start failure (known failure), post-spawn unverified failure (uncertain), empty poll of unavailable stdin (known recoverable), and non-empty stdin delivery ambiguity (uncertain).
- [ ] Implement typed error mapping without logging or copying raw command, stdin, or environment into public error messages.
- [ ] Verify uncertain outcomes stop trailing Tool calls through the existing Batch Coordinator and preserve complete ordered skipped results.
- [ ] Run focused tests and Phase 7 batch/recovery regressions; observe GREEN.

### Task 19: Registry, Dispatcher, and Batch integration

**Files:** Modify `packages/tools/src/index.ts` and integration support only; create `packages/tools/test/shell-catalog-consistency.test.ts`, `packages/storage/test/shell-tool-dispatcher-integration.test.ts`.

- [ ] Write RED tests registering both shell Tools, checking model/runtime catalog equality, dispatching quick commands through the real Dispatcher, dispatching managed processes through `write_stdin`, and verifying non-zero command exit is `isError:false`.
- [ ] Implement no separate catalog or special batch disposition; yielded processes are known successful Tool results that continue asynchronously while source-order batch execution remains sequential.
- [ ] Run Tool registry, Dispatcher, Batch, Phase 7, Phase 8A, and Phase 8B focused suites; observe GREEN.

### Task 20: Quick-command Agent E2E

**Files:** Create `packages/core/test/agent-shell-quick-command.test.ts` and fixtures under `packages/tools/test/support` if needed.

- [ ] Write RED E2E with the real `RuntimeResolver → LocalRuntime → ProcessManager → exec_command` path and a fake LLM: provider requests quick command, command output/exit metadata returns, next provider turn emits final candidate.
- [ ] Implement only test wiring needed to supply the shell catalog and execution environment; do not add AgentLoop process knowledge.
- [ ] Assert final Run status is `VERIFYING`/`AWAITING_VERIFICATION`, never `COMPLETED`, and all durable lifecycle entries remain existing Tool events/observations.
- [ ] Run focused E2E and Phase 7 Agent regressions; observe GREEN.

### Task 21: Non-zero and managed-process Agent E2E

**Files:** Extend `packages/core/test/agent-shell-quick-command.test.ts`; create `packages/core/test/agent-managed-process.test.ts`.

- [ ] Write RED E2E for exit code 7 remaining a successful Tool result and for `exec_command` → RUNNING/session → `write_stdin("ping\\n")` → `pong`/RUNNING → `write_stdin("exit\\n")` → EXITED/0 → final candidate/VERIFYING.
- [ ] Use the actual session ID from the first Tool result in the fake provider’s next request; never fake a session bridge or instantiate a second runtime per call.
- [ ] Assert manager count is 1 after start and 0 after final exit poll; assert no duplicated `READY` output across polls.
- [ ] Run focused E2E and typecheck; observe GREEN.

### Task 22: Crash/recovery regressions

**Files:** Create `packages/storage/test/shell-crash-recovery.test.ts`; modify no storage schema/migrations.

- [ ] Write RED tests with durable RUNNING `exec_command` and `write_stdin` ToolInvocations, restart/recover through existing `RunController`, and assert no command/input replay.
- [ ] Add stale session restart coverage: old session produces uncertainty, Run fail-closed path is recorded, and trailing Tool calls are skipped.
- [ ] Implement only compatibility with existing `recoverOrDispatch()` behavior; do not add process persistence.
- [ ] Run focused recovery suite plus all Phase 7 restart tests; observe GREEN.

### Task 23: Static architecture audit and regression matrix

**Files:** Create/extend `tests/architecture/process-runtime-boundaries.test.ts`, `packages/runtime/test/public-api.test.ts`, `packages/tools/test/public-api.test.ts`.

- [ ] Write RED static tests for runtime→tools/core/storage/events/llm/security absence, Tool handler→child_process/node-pty absence, `shell:true`/`exec`/`execSync` absence, no process schema/migration, no GitRuntime/git_status/git_diff, no PermissionEvaluator/Approval resolution/cancellation/timeout/retry/BudgetManager/VerificationRunner, and no direct process/shell events or activeProcesses mutation.
- [x] Implement boundary-safe imports/exports and keep all low-level spawning in the two runtime adapters only (plus existing ripgrep process path).
- [ ] Run architecture tests and focused matrix covering resolver, workdir, output buffer, sanitizer, pipe, PTY, manager, ownership, generation, tools, catalog, Dispatcher, Batch, recovery, and E2E.

### Task 24: Documentation, README, AGENTS, and final verification

**Files:** Create `docs/architecture/process-runtime.md`; modify `docs/architecture/runtime.md`, `docs/architecture/tool-system.md`, `README.md`, `AGENTS.md`.

- [ ] Write documentation tests/checklist assertions for RuntimeExecService, LocalProcessManager, Pipe/PTY, shell resolution, workdir, ownership, generation, lifecycle, buffering, sanitization, yield semantics, error uncertainty, restart behavior, and Phase 8D/9/10 boundaries.
- [ ] Document explicitly: ProcessSession is not durable across daemon restart; stale previous-runtime session is uncertain; yield-time is not timeout; contained workdir is not a shell sandbox; Phase 8C is functional but not production-secure; Phase 8D owns event bridge/Git/activeProcesses; Phase 9 owns security/redaction/sandbox; Phase 10 owns cancellation/timeout/retry/budget.
- [ ] Update README status to 8A/8B/8C completed and Phase 8 in progress without claiming sandbox, durability, timeout, cancellation, or production security.
- [ ] Add the Phase 8C durable rules to `AGENTS.md`.
- [ ] Run changed-file formatting only with `prettier --check <changed files>`; never run `prettier --write .`.
- [ ] Run clean build cleanup using Node fs for `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo`, then `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [ ] Run `pnpm format:check`, record final warning files and verify they are no greater than the 466-file baseline; run `pnpm check`, `git diff --check`, and `git status --short`.
- [ ] Commit coherent groups with the recommended runtime/tool/test/docs messages, push `codex/phase-8c-shell-managed-process-runtime`, verify local and remote SHA equality, and report all actual evidence without fabricating skipped or RED/GREEN results.

## Verification Gates

1. Runtime contract and adapter tests pass before tool integration.
2. Every new production behavior has a failing test observed before the minimal implementation.
3. Pipe and PTY adapters are real integration paths; no mocked `spawn`-only compatibility claim substitutes for them.
4. Runtime package has one manager per `LocalRuntime`, no storage/event/core/tool dependency, and no persistence.
5. Tool catalog, Dispatcher, Batch, RunController, and Agent E2E tests prove quick, non-zero, managed, cross-run, stale, and uncertainty semantics.
6. Architecture/static audit proves Phase 8D/9/10/11 non-leakage.
7. Fresh full lint/typecheck/test/build and formatting/check gates pass; historical formatting debt does not regress.
8. Final report contains actual baseline/final counts, node-pty version/build/PTY result, TDD evidence, architecture diagram, migration audit, commits, push SHA match, and current capability/status.
