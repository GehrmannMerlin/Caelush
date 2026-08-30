# Caelush Phase 8D — Git Runtime, Built-in Tool Integration & Phase 8 Finalization

## Baseline and scope

- Worktree: `codex/phase-8d-git-runtime-builtins-finalization`.
- Base: `origin/codex/phase-8c-shell-managed-process-runtime` at `67302f2`.
- Preserve the Phase 8C shell/process contract and implement only the Phase 8D final scope.
- Do not implement Phase 9 security, Phase 10 cancellation/timeout/retry/budget, or Phase 11 product work.

## Research decisions

- Use the current OpenAI Codex `git-utils` structure as a reference for small, explicit Git operations and centralized process setup: `lib.rs`, `status.rs`, `info.rs`, `git_process.rs`, and `baseline.rs`.
- Keep Caelush's Git Runtime narrower than Codex's internal baseline utilities: read-only `rev-parse`, `status`, and `diff`; never expose Git metadata or mutation commands.
- Treat the diff tracker lesson as a bounded-output concern: cap process capture and model-facing output, and report truncation explicitly.

## Implementation sequence

1. Add `RuntimeWorkspaceScope.git`, lexical workspace path resolution, typed Git errors, fixed-executable Git runner, repository locator, porcelain-v2 parser, bounded diff capture, and `LocalGitService`.
2. Add `git_status` and `git_diff` built-in definitions/handlers, then add the canonical default catalog with one injected `RuntimeResolver` and no hidden `LocalRuntime` defaults.
3. Add pure `ToolEffect` projection and effect-to-domain-event translation for file reads, patches, shell/process lifecycle, and managed stdin. Use the safe shell label in every public projection.
4. Add the pure bounded `AgentState` reducer and extend `ToolExecutionStore.commit` so invocation, observation, state revision, domain events, and terminal tool event share one `BEGIN IMMEDIATE` transaction.
5. Reuse the storage-internal state writer, reload current run snapshots after tool batches in `RunController`, and verify rollback/uncertain/revision behavior.
6. Add real temporary Git repository tests, parser/path/diff tests, effect/reducer/store tests, catalog tests, architecture/privacy tests, and a real Agent E2E covering patch, command, Git inspection, and verification state.
7. Update architecture docs and repository instructions; run targeted tests, full `pnpm check`, diff/status checks, commit, push, and verify remote SHA equality.

## Non-negotiable invariants

- Dedicated Git Runtime calls `spawn("git", argv, { shell: false })` directly, with deterministic non-interactive environment and bounded UTF-8 capture.
- Git pathspecs are workspace-relative, lexical-safe, and constrained to the current Agent Workspace even when it is a subdirectory of a parent repository.
- Git results expose only model-facing structured summaries and bounded diff text; no absolute paths, `.git` paths, raw environment, or raw diagnostics.
- Tool effects are produced only after a validated successful result; handler failure, uncertain side effect, or projector failure never fabricates effects.
- `AgentState.activeProcesses` and shell/process events use `shell command`; raw command and stdin remain private invocation data only.
- Durable effects/events are persisted before notification; a failed terminal settlement rolls back to the existing running invocation so recovery can classify it as uncertain.
- `git_status`/`git_diff` remain read-only and require `GIT_READ`; the default registry is the sole source for model definitions and runtime dispatch.

## Verification gates

- TDD: add a focused failing test before each behavior implementation.
- Targeted runtime/tools/storage/core tests plus package typecheck/lint/build.
- Changed-file Prettier check is clean; repository-wide warning count does not increase from baseline.
- Full `pnpm check`, `git diff --check`, `git status --short`.
- Commit and push only this branch; no reset, clean, force-push, merge, or PR creation.
