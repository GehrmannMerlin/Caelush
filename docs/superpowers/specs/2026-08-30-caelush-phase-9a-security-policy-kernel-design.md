# Caelush Phase 9A — Security Policy Kernel & Tool Execution Gate

## Scope

Phase 9A adds the policy-only security decision layer for Tool calls. A
durable `AgentRun` remains the authority for `PermissionProfile` and
`ApprovalPolicy`; the RunController derives a separate `ToolSecurityContext`
and carries it through the Tool batch and dispatch contracts. The evaluator
then makes a deterministic `ALLOW`, `DENY`, or `REQUIRE_APPROVAL` decision from
the context and Tool metadata.

This phase does not implement ApprovalRequest persistence or resolution,
command-aware policy, sensitive-file policy, secret redaction, cancellation,
retry/timeout, or an OS sandbox. `ToolExecutionEnvironment` remains the
runtime/workspace contract and does not acquire policy fields.

## Architecture

```text
AgentRun.permissionProfile + approvalPolicy
                    │
                    ▼
          ToolSecurityContext
                    │
                    ▼
ToolBatchRequest → ToolDispatchRequest → ToolExecutionGatePort
                                             ▲
                                             │
                                  @caelush/security
                                             │
                                             ▼
                               ALLOW / DENY / REQUIRE_APPROVAL
```

`@caelush/tools` owns the Gate port and request contracts. `@caelush/security`
implements the port and depends only on `@caelush/protocol` plus the Tool port
types. Tools do not depend on Security. The evaluator is pure: it does not
read invocation arguments, call clocks/randomness, access Runtime, Storage,
EventBus, network, or the filesystem.

## Policy model

The existing protocol enums are reused without V2 duplicates.

| Profile | Granted capabilities |
| --- | --- |
| `READ_ONLY` | `FS_READ`, `GIT_READ` |
| `PROJECT_ACCESS` | `FS_READ`, `FS_WRITE`, `FS_DELETE`, `SHELL_EXEC`, `PROCESS_START`, `PROCESS_KILL`, `GIT_READ` |
| `FULL_ACCESS` | every current `Capability` |

`SHELL_EXEC`, `PROCESS_START`, and `PROCESS_KILL` classify a Tool as
`UNCONFINED_PROCESS`; all other metadata classify as
`STRUCTURED_WORKSPACE`. This is a conservative policy classification, not an
OS sandbox claim.

Decision precedence is fixed:

1. Validate the security context and Tool metadata/invocation risk invariant.
2. Resolve the profile's granted capability set.
3. Deny when any required capability is missing.
4. For `PROJECT_ACCESS` plus `UNCONFINED_PROCESS`, deny under `NEVER_ASK` and
   require approval when the policy permits asking.
5. Otherwise, `ALWAYS_ASK` requires approval, `DANGEROUS_ONLY` allows
   `LOW`/`MEDIUM` and asks for `HIGH`/`CRITICAL`, and `NEVER_ASK` allows the
   already-authorized action.

Stable non-secret decision codes are returned with safe reason text:
`ALLOWED_BY_POLICY`, `MISSING_REQUIRED_CAPABILITY`,
`APPROVAL_POLICY_REQUIRES_REVIEW`, `DANGEROUS_ACTION_REQUIRES_REVIEW`,
`UNCONFINED_EXECUTION_REQUIRES_REVIEW`, and
`UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL`. No decision or public error
may include raw arguments, commands, stdin, file content, environment
variables, or host absolute paths.

## Lifecycle and recovery

The Dispatcher remains the lifecycle owner. `ALLOW` transitions a requested
invocation to `RUNNING` and invokes the handler; `DENY` persists a terminal
`PERMISSION_DENIED`/`SECURITY` observation without invoking the handler;
`REQUIRE_APPROVAL` persists `WAITING_APPROVAL` without invoking the handler.
Batch execution stops at the approval boundary but retains completed prefix
results. A known permission denial is a model-observable Tool result and does
not become uncertain side effect state.

`REQUESTED` recovery re-evaluates through the real Gate using the durable Run
context. `WAITING_APPROVAL` remains waiting, `RUNNING` remains the existing
uncertain-side-effect recovery boundary, and terminal invocations reuse their
durable observations without re-running the Gate or handler.

The RunController compares the durable Run policy to the corresponding
AgentState policy before constructing the Tool batch and fails closed on a
mismatch. It never accepts policy from the model, Tool arguments, or
environment variables.

## Verification and boundaries

Tests cover the real nine-Tool catalog metadata, capability and approval
matrices, containment, safe-reason privacy, strict context/request validation,
Gate/Dispatcher lifecycle, batch boundaries, recovery, and Run-derived E2E
flows. Architecture tests enforce package direction and Security's lack of
I/O dependencies. No database migration is added and no Approval workflow,
command policy, secret redaction, or hard sandbox is introduced.

## Reference review

- OpenAI Codex `safety.rs` and `tools/sandboxing.rs`: observed explicit
  separation of auto-approve, ask, reject, permission profile, approval
  requirement, and sandbox enforceability. Caelush adopts that conceptual
  separation and fail-closed treatment, but does not copy Codex's Rust,
  platform sandbox, command policy, or approval cache.
- OpenAI Codex `permissions_instructions.rs`: observed that permission and
  approval state are rendered as separate concepts. Caelush adopts the
  separation at its Run/Tool boundary, not Codex prompt text or provider
  types.
- OpenCode permissions documentation: observed `allow`/`ask`/`deny` and deny
  precedence over asking, with later input-aware and session-scoped rules.
  Caelush adopts the three-way decision shape and precedence only; wildcard
  rules, config files, per-agent overrides, external-directory globs, and
  remembered approvals remain out of Phase 9A.

## Baseline

The remote is `https://github.com/GehrmannMerlin/Caelush.git`. Phase 8D
`8d45c92e0ec6c2c45e69dc0c4026f5a9d90f65a7` is not an ancestor of
`origin/master`, so the Phase 9A worktree is based on
`origin/codex/phase-8d-git-runtime-builtins-finalization` at that SHA. Plain
baseline `pnpm test` passes with 184 files, 616 tests, and 4 skipped. The
baseline `pnpm format:check` reports 517 warning files; Phase 9A must not
increase that repository debt and all changed files must format cleanly.
