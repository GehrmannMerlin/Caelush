# Git Runtime

Phase 8D adds a read-only Git capability below the Tool layer. `RuntimeWorkspaceScope.git` is implemented by `LocalGitService`; it invokes the fixed `git` executable directly with `spawn("git", argv, { shell: false })`. It does not use `RuntimeExecService`, the user shell resolver, PTY, or a model-controlled executable.

The service first uses `git rev-parse --show-toplevel` to detect the repository, which supports ordinary repositories and linked worktrees without inspecting `.git` as a filesystem directory. Status and diff commands always receive `--` followed by a pathspec derived from `WorkspacePathResolver.resolveLexical`. The pathspec is constrained to the current Agent Workspace, including when that workspace is a subdirectory of a parent repository. Git’s internal root and metadata paths never enter a model result.

`git_status` uses porcelain v2, NUL-delimited output and `--branch`, then parses headers and entries in a dedicated parser. Results are bounded by an explicit limit and contain only branch/detached/ahead/behind state and workspace-relative entries. `git_diff` supports `WORKTREE`, `STAGED`, and `ALL`; external diff/textconv, color, and binary patches are disabled. Capture is capped at 1 MiB and model-facing text at 48 KiB, with truncation, omitted-byte, and decode-replacement metadata.

The runtime maps missing Git, non-repository, invalid path/scope, malformed machine output, unsupported path encoding, and command failures to typed errors. Diagnostics are intentionally sanitized; raw stderr, environment, absolute paths, and Git internals are not model-facing.

Git is read-only in Phase 8. There are no add, commit, push, pull, fetch, checkout, reset, restore, clean, merge, rebase, cherry-pick, move, or remove APIs.
