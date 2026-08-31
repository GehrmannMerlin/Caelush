# Local Runtime Foundation

## Phase 9D security boundary

The Runtime owns child-process environment construction. Agent processes receive a platform-aware compatibility allowlist; structured Git and ripgrep helpers receive a smaller environment. Credential, injection, proxy-credential, SSH-agent, and helper-config variables are removed without mutating the caller environment. Windows variable names are matched case-insensitively.

`exec_command` and `write_stdin` are local process capabilities, explicitly labeled `UNCONFINED_LOCAL_PROCESS` by Security. The label is an honesty boundary: V1 provides policy and durable approval checks plus sanitized environment, not OS syscall, network, filesystem, container, or process-identity isolation.

Phase 8C extends the runtime with a workspace-bound `RuntimeExecService`. It is implemented by one long-lived `LocalProcessManager` per `LocalRuntime`, which selects a pipe adapter or a lazy `node-pty` adapter. See [Shell and Process Runtime](process-runtime.md) for the session, ownership, bounded-output, stale-generation, and Phase 8C boundary rules. This execution capability remains below Tools and above the OS process adapters; it has no Storage, Core, Events, Security, or Verification dependency.

Phase 8A establishes the first concrete execution substrate for Caelush. It is deliberately below the Tool System and deliberately narrower than a general host runtime.

## Architecture

```text
ToolHandler
    │  ToolExecutionEnvironment { workspace, runtime }
    ▼
RuntimeResolver
    ▼
Runtime.openWorkspace(WorkspaceRef)
    ▼
RuntimeWorkspaceScope
    ├── WorkspacePathResolver
    ├── RuntimeFileSystem ───────► Node filesystem APIs
    ├── RuntimeFileDiscovery ────► fast-glob
    ├── RuntimeTextSearch ───────► fixed rg subprocess adapter
    ├── RuntimePatchService ────► verified patch-private mutation primitives
    ├── RuntimeExecService ────► pipe/PTY process adapters
    └── RuntimeGitService ────► fixed read-only git subprocess
```

`Runtime`, `RuntimeWorkspaceScope`, and the filesystem/search/patch interfaces are Caelush-owned contracts. Node `Stats`, `Dirent`, `FileHandle`, `ChildProcess`, raw ripgrep parser state, and mutable buffers do not cross the public package boundary. `LocalRuntime` implements the Phase 8A read/search capabilities plus the narrow Phase 8B `RuntimePatchService`; it does not expose generic blind write, overwrite, delete, or raw-byte APIs.

The package direction is:

```text
core → tools → runtime → protocol/shared
context → shared
```

Runtime never imports Tools, Core, Context, Storage, Events, LLM, Security, Verification, or a host application. The Tool Kernel remains generic; only built-in handlers depend on Runtime.

## Workspace and path model

`AgentRun.workspace.path` is the sole workspace root for a Tool call, and `AgentRun.runtime` selects the Runtime. The execution environment carries only the JSON-safe `WorkspaceRef` and `RuntimeRef`; it does not carry a Runtime object, filesystem service, repository, EventBus, permission manager, signal, secret, or model data.

All Phase 8A model paths are workspace-relative. `.` denotes the workspace root. POSIX absolute paths, Windows drive paths, UNC paths, NUL-containing paths, traversal escapes, and over-budget UTF-8 path strings are rejected. Paths are normalized for resolution, and all model-facing paths are emitted with `/` separators.

Workspace opening preserves both `logicalRoot` (the normalized configured path) and `realRoot` (its realpath). Existing targets pass two checks: lexical containment beneath `logicalRoot` and realpath containment beneath `realRoot`. This allows an internal symlink while failing closed when a symlink resolves outside the workspace. A workspace root must exist and be a directory.

Runtime containment is a correctness invariant, not authorization. Phase 8A does not inspect `permissionProfile`, `approvalPolicy`, or capabilities to make a decision. Secret-file policy and permission enforcement belong to Phase 9.

## Read-only filesystem

`read_file` accepts a required workspace-relative `path` plus optional 1-indexed `offset` and `limit` values. It defaults to 400 lines, caps the line count at 2,000, and applies a 50 KiB model-facing read budget. The reader consumes bounded chunks, detects binary data from extensions and content, decodes UTF-8 with fatal errors, handles BOM/CRLF/no-final-newline/Unicode correctly, and bounds individual long lines. Results report the canonical path, line range, byte count, BOM state, and whether `nextOffset` is available. Empty files are successful and are represented as `(empty file)`.

`list_directory` is non-recursive, deterministic, and capped at 500 returned entries. Directory and symlink children are represented by structured `kind` metadata and `/` or `@` display markers. An explicitly requested directory symlink may be listed only after its realpath passes the workspace boundary.

Neither tool mutates the filesystem. Successful `read_file` settlement also emits a durable, workspace-relative `file.read` effect event; the ToolInvocation/ToolObservation remains the canonical output audit record.

## Discovery and search

`find_files` uses exact-pinned `fast-glob` with `onlyFiles`, `absolute: false`, `unique`, and `followSymbolicLinks: false`. It reuses the shared hard-excluded project directory names, returns sorted workspace-relative paths, asks for `limit + 1` entries to determine truncation, and reports `No files found.` as a successful empty result.

`search_text` accepts a ripgrep-compatible regular expression, an optional workspace-relative directory, an optional include glob, and a bounded result limit. It uses a fixed `rg` executable through `spawn` with `shell: false`, an argv array owned by the adapter, JSON output, line numbers, and no `--follow`, `-L`, or `--no-ignore`. Exit code 0 means matches, 1 means no matches, and 2 or greater is an expected search error. Missing `rg` becomes `RIPGREP_UNAVAILABLE`; malformed JSON or a result that violates the Runtime contract is an infrastructure invariant. Stdout/stderr are bounded and raw stderr never reaches the model.

The model cannot choose the executable, arbitrary flags, shell mode, environment variables, or a raw argument array. Pattern text is passed as one argv value, so shell metacharacters are data rather than commands.

## Error model and Phase boundaries

## Phase 10A cancellation boundary

Runtime operations receive the Run-owned host signal through Tool handlers. `LocalProcessManager` can terminate all live entries for one exact `ownerRunId`, including yielded `exec_command` sessions, and removes them after cleanup. `search_text`, Git helpers, and process waits race their child/process operation against abort. Patch preparation can stop before mutation; once commit begins, cancellation is deferred through verified commit/rollback and observed afterward. These controls provide cooperative managed-runtime cleanup, not an OS hard sandbox or a universal descendant-process guarantee.

## Phase 10B deadline boundary

Run deadline expiry uses the same signal and owned-resource controller. The Controller aborts first, then waits for the active execution to unwind before asking Runtime to clean up `exec_command`, PTY/yielded sessions, `write_stdin`, ripgrep, Git helpers, and other Run-owned processes. A timeout is not considered terminal until cleanup is confirmed; an unconfirmed cleanup returns `TIMEOUT_PENDING` and can be retried by recovery. Runtime does not own the deadline timer or decide the durable Run status. See [Run Deadline and Timeout](timeout.md).

Operational Runtime errors are typed and converted by built-in handlers to model-recoverable `ToolExecutionResult` values with safe error codes. Host paths, stack traces, raw filesystem errors, raw stderr, and internal IDs are not model-facing. Unexpected Runtime invariants remain typed throws; the existing ToolDispatcher sanitizes and durably records those infrastructure failures.

Phase 8B adds the verified `apply_patch` path and Phase 8C adds managed shell/process execution. Phase 8D adds only read-only Git inspection and the host-side effect bridge; it does not add Git mutation. Parsing and preparation remain bounded and deterministic, and patch failures remain best-effort rather than crash-atomic or exactly-once. Permission evaluation, approval resolution, sandboxing, secret redaction, retry/backoff, run cancellation, generic timeout, and Verification execution remain out of scope. Runtime has no persistence tables or process reattachment; effect settlement reuses the existing Tool/Run storage boundaries.

## References

The separation between a Tool handler and its execution substrate follows the Runtime/handler layering observed in OpenAI Codex. The bounded, paginated, binary-aware, ripgrep-backed read/search behavior follows the practical safeguards observed in OpenCode's `read`, `glob`, and `grep` tools. Caelush intentionally does not copy their host-specific permission, attachment, instruction-loading, or process orchestration features into Phase 8A.

## Phase 10D budget boundary

Runtime does not own budget policy, pricing, retry, or timeout. The Dispatcher
and RunController reserve and settle Tool/LLM usage outside the Runtime; the
Runtime only reports bounded execution results and exact uncertainty. Budget
cleanup uses the existing Run-owned resource controller and does not claim hard
OS sandboxing or universal process-tree termination.
