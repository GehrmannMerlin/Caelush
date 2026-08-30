# Caelush Phase 9D Implementation Plan

## Scope and baseline

- Base the worktree on `origin/codex/phase-9c-sensitive-command-secret-policy` at the verified `967f8ebb0165371ed692210437e3d21af67e80da`.
- Preserve Phase 9A capability/risk policy, Phase 9B durable approval semantics, and Phase 9C input-aware policy/redaction semantics.
- Add only Phase 9D integration and hardening: logical sandbox contracts, secure child environments, structured helper hardening, unified Context policy, default secure composition, egress audits, adversarial tests, and final documentation.
- Do not add OS sandboxing, cancellation, timeout, retry, budget, Verification, MCP, Browser, remote runtime, new execution HTTP routes, or Phase 10 work.
- Keep all final verification serial. Record the fresh format baseline before implementation and do not run `prettier --write .`.

## Architecture and dependency decisions

- Keep `@caelush/security` above the Tool gate port and `@caelush/runtime` independent of Security.
- Define the V1 logical sandbox contract in Security or a neutral Protocol-free contract location without claiming OS isolation.
- Represent structured workspace tools as `STRUCTURED_WORKSPACE` and `exec_command`/`write_stdin` as `UNCONFINED_LOCAL_PROCESS`.
- Put child-process environment sanitization in `@caelush/runtime`; it must be pure, deterministic, caller-input immutable, and case-insensitive for Windows names.
- Expose only narrow pure Security subpaths for Context: sensitive-path classification and redaction. Context must not import the Security root, Tools, Runtime, Storage, or approval code.
- Provide a default V1 security bundle and a secure ToolDispatcher composition helper that always wires the real Gate and Result Sanitizer. Keep low-level constructors available for narrow tests/custom hosts, but make approval-required runtime paths fail closed when durable approval infrastructure is absent.

## Implementation tasks

### 1. Contracts and admission

1. Write tests for the logical sandbox contract, runtime-kind mismatch, containment metadata, structured versus unconfined classification, and approval not bypassing admission.
2. Add the contract and pure `evaluateLogicalSandboxAdmission`-style validation for definition capabilities, containment, runtime kind, runtime requirements, and Security Facts validity.
3. Add containment metadata to safe approval/structured previews without placing it in model-facing ToolDefinitions or leaking private paths.
4. Ensure runtime-kind mismatch fails before handler execution and that approval resolution cannot bypass logical sandbox or Runtime path guards.

### 2. Runtime child environment

1. Write fake-environment tests for allowlisted compatibility variables, credential stripping, injection-variable stripping, proxy credential removal, Windows case-insensitivity, and caller immutability.
2. Add a Runtime-owned `ChildProcessEnvironmentPolicy` with separate agent-process and structured-helper environment construction.
3. Make `LocalRuntime`, `LocalRuntimeExecService`, shell resolution, and child process adapters use sanitized environments by default. Do not expose `inheritAllHostEnvironment` or `disableEnvironmentSecurity` production options.
4. Preserve required POSIX and Windows variables (`PATH`/`Path`, system roots, temp directories, home/user identity, shell/terminal/language compatibility) while removing API keys, tokens, passwords, credentials, SSH agent variables, proxy credentials, and code-injection variables.
5. Add an exec integration test proving a fake host secret is absent in the child, both before and after approval/RUN grant paths.

### 3. Structured helper hardening

1. Write tests proving rg and Git use fixed executable/argument construction, `shell: false`, bounded output, no arbitrary stdin, sanitized minimal environments, and no interactive prompts.
2. Harden `LocalRipgrepRunner` with `--no-config`, sanitized helper env, and no `RIPGREP_CONFIG_PATH` inheritance. Add an adversarial config/preprocessor marker test.
3. Harden Git execution with `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `GIT_OPTIONAL_LOCKS=0`, config/environment hardening, disabled external diff/textconv/fsmonitor where supported, and no askpass/interactive prompt.
4. Preserve WORKTREE/STAGED/ALL diff scopes. Add temporary-repository marker tests for external diff, textconv, fsmonitor, credential helper, and pager escape paths; fail closed if a mechanism cannot be reliably disabled.

### 4. Context security boundary

1. Write a drift test that runs the same sensitive-path matrix through Security and Context.
2. Expose narrow `@caelush/security/sensitive-path` and `@caelush/security/redaction` exports without exposing the Security root to Context.
3. Replace Context's duplicate sensitive path sets with the unified classifier while preserving `.env.example`, `.env.sample`, and `.env.template` exceptions.
4. Ensure sensitive files are excluded before content reads; metadata discovery may proceed, but instrumented content-read count must remain zero.
5. Apply high-confidence `redactText` to project-derived relevant file content, project instructions, and file-derived metadata before ContextBuilder emits provider messages. Do not rewrite current user messages or alter tool conversation lifecycle.
6. Add Context-to-fake-LLM sentinel tests for ordinary source embedded secrets and sensitive-file exclusion.

### 5. Secure default composition

1. Write tests for `createDefaultV1ToolExecutionSecurity` and `createV1SecureToolDispatcher` (or repository-equivalent names), asserting the real Gate and real Sanitizer are wired.
2. Add the default bundle contract and secure Dispatcher factory with required registry, store, notifier, clock/id factories, approval store, and approval ID factory dependencies.
3. Tighten `WAITING_APPROVAL` so `approvalId` is required. If a `REQUIRE_APPROVAL` decision lacks durable approval infrastructure, return an infrastructure failure without an orphan waiting state or handler execution.
4. Add registration metadata audit: every default builtin must have valid definition metadata, supported runtime requirements, and a Security Facts projector. Missing coverage must fail configuration/audit.
5. Add tests proving fake AllowAll gates, no-op sanitizers, and missing projectors cannot become the documented default composition.

### 6. Egress and adversarial integration

1. Audit model/public/event/log surfaces for raw automatic host/project/tool secrets: Context messages, ToolObservation, ApprovalRequest/action, Approval events, Tool events, Run events, errors, reasoning/plan/shell/file/process/LLM events, RunTrace, and logger fields.
2. Build an untrusted repository fixture with malicious instructions, `.env`, embedded source secrets, Git config/attributes helpers, rg config, and shell attempts. Prove repository content cannot grant permission or override current Gate decisions.
3. Add adversarial tests for sensitive approval plus redaction, old RUN grant plus new DENY, sanitizer uncertainty, symlink escape, patch containment/hash/rollback, and approval after path replacement.
4. Add a public projection sentinel sweep that explicitly excludes private `ToolInvocation.args` from the zero-leak assertion while requiring zero detected sentinel occurrences in automatic public/model/event/log projections.
5. Add cross-platform policy tests for POSIX (`sh`, `bash`, `zsh`, `env`, `sudo`, `rm`) and Windows (`PowerShell`, `cmd`, `runas`, `Remove-Item`).

### 7. Documentation and final seal

1. Add `docs/architecture/security-threat-model.md` covering assets, trust boundaries, threats, V1 assumptions, and non-protected surfaces.
2. Add `docs/architecture/security-capability-matrix.md` with `ENFORCED`, `POLICY / APPROVAL GUARDED`, and `NOT ISOLATED` states.
3. Update security, approval-workflow, tool-system, runtime, Context architecture docs; update README to mark 9A/9B/9C/9D and Phase 9 complete while explicitly stating logical/policy sandbox rather than OS sandbox.
4. Update AGENTS.md with durable Phase 9 final rules and Phase 10 exclusion.
5. Add architecture audits for package dependencies, helper process boundaries, default composition, daemon boundary, public/model egress, and no new storage migration.

### 8. Verification and delivery

1. Run focused tests after each TDD slice; use systematic debugging for any leak, bypass, helper escape, platform divergence, or schema regression before changing code.
2. Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` serially from a clean-build state using safe Node filesystem deletion only for generated dist/tsbuildinfo artifacts.
3. Run `pnpm format:check`, verify all Phase 9D changed files individually, and confirm final repository warnings do not exceed the measured baseline without global formatting.
4. Run `pnpm check`, record any sole pre-existing format-debt failure, then run `git diff --check` and `git status --short`.
5. Create coherent commits, push `codex/phase-9d-security-integration-logical-sandbox`, verify local and remote SHA equality, do not merge master, do not create a PR, and stop at the Phase 9D completion report.

## Completion checklist

- Logical Sandbox contract is explicit and does not claim OS/process/network isolation.
- Structured tools remain workspace-contained; shell/process tools are explicitly unconfined local processes with sanitized environments.
- Runtime-kind admission, secure child environment, helper hardening, unified Context policy, redaction, secure default composition, and approval fail-closed behavior are tested.
- Default builtins have Security Facts coverage and no production no-op Gate/Sanitizer exists.
- Public/model/event/log projections are secret-safe while private durable ToolInvocation args retain exact execution data.
- Phase 9A/9B/9C/Phase 8/Phase 6/7 regressions pass.
- Threat model, capability matrix, limitations, README, AGENTS, and architecture docs are complete.
- Final serial verification, format no-regression, clean tree, push, and SHA gates pass.
