# Local Runtime Foundation

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
    └── RuntimePatchService ────► verified patch-private mutation primitives
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

Neither tool mutates the filesystem. Phase 8A does not emit a separate `file.read` side event; durable ToolInvocation/ToolObservation lifecycle events remain the audit mechanism.

## Discovery and search

`find_files` uses exact-pinned `fast-glob` with `onlyFiles`, `absolute: false`, `unique`, and `followSymbolicLinks: false`. It reuses the shared hard-excluded project directory names, returns sorted workspace-relative paths, asks for `limit + 1` entries to determine truncation, and reports `No files found.` as a successful empty result.

`search_text` accepts a ripgrep-compatible regular expression, an optional workspace-relative directory, an optional include glob, and a bounded result limit. It uses a fixed `rg` executable through `spawn` with `shell: false`, an argv array owned by the adapter, JSON output, line numbers, and no `--follow`, `-L`, or `--no-ignore`. Exit code 0 means matches, 1 means no matches, and 2 or greater is an expected search error. Missing `rg` becomes `RIPGREP_UNAVAILABLE`; malformed JSON or a result that violates the Runtime contract is an infrastructure invariant. Stdout/stderr are bounded and raw stderr never reaches the model.

The model cannot choose the executable, arbitrary flags, shell mode, environment variables, or a raw argument array. Pattern text is passed as one argv value, so shell metacharacters are data rather than commands.

## Error model and Phase boundaries

Operational Runtime errors are typed and converted by built-in handlers to model-recoverable `ToolExecutionResult` values with safe error codes. Host paths, stack traces, raw filesystem errors, raw stderr, and internal IDs are not model-facing. Unexpected Runtime invariants remain typed throws; the existing ToolDispatcher sanitizes and durably records those infrastructure failures.

Phase 8B adds only the verified `apply_patch` path. Parsing and preparation are mutation-free; all sources and destinations are guarded before sequential commit; ordinary commit failures attempt exact reverse rollback; rollback failure or verification mismatch becomes an uncertain side effect. This is not crash-atomic, exactly-once, or a fully transactional filesystem. Shell execution, managed processes, PTY, Git, permission evaluation, approval resolution, sandboxing, retry/backoff, run cancellation, generic timeout, and Verification execution remain out of scope. There are no Runtime persistence tables or migrations, no Runtime event side channel, and no final default catalog beyond the explicit read-only and mutation registration factories.

## References

The separation between a Tool handler and its execution substrate follows the Runtime/handler layering observed in OpenAI Codex. The bounded, paginated, binary-aware, ripgrep-backed read/search behavior follows the practical safeguards observed in OpenCode's `read`, `glob`, and `grep` tools. Caelush intentionally does not copy their host-specific permission, attachment, instruction-loading, or process orchestration features into Phase 8A.
