# Caelush Phase 11B — Deterministic Verification Execution Design

## Status and scope

Phase 11A creates an immutable `VerificationPlan` containing intent-only
`PROJECT`, `WORKSPACE`, `GIT`, and `TASK` checks. Phase 11B gives only the
`PROJECT` checks for `LINT`, `TYPECHECK`, `TEST`, and `BUILD` a deterministic
discovery and execution path. It does not implement workspace changeset
verification, Git semantic review, task acceptance, repair, re-verification,
completion authority, or a new approval workflow.

The final Run state remains `VERIFYING` after Phase 11B, including when every
executed PROJECT check passes, because WORKSPACE, GIT, and TASK checks remain
pending. Phase 11B never emits `run.completed`, writes `finalResult`, or
transitions `VERIFYING` to `RUNNING` or `COMPLETED`.

## Goals

1. Resolve supported project checks from fresh Phase 5 project facts rather
   than guessing commands from language or file extensions.
2. Execute resolved commands through the existing Runtime process substrate,
   using typed executable/argv and `shell:false`.
3. Reuse Phase 9 security semantics without routing host verification through
   `ToolDispatcher` or fabricating `ToolInvocation` records.
4. Persist bounded, redacted Discovery and Command evidence using the existing
   verification tables and durable event boundary.
5. Make start and settlement crash-safe at the database boundary: durable
   `RUNNING` before process launch, and terminal Check/evidence/completed event
   in one settlement transaction.
6. Honor the existing Run `AbortSignal` and deadline authority without adding
   a verification timeout or budget system.

## Non-goals

- No `TASK/ACCEPTANCE`, `WORKSPACE/CHANGESET_SANITY`, or
  `GIT/CHANGESET_REVIEW` execution.
- No automatic repair loop, LLM reviewer, re-planning, or retry.
- No second project detector, package.json parser, lockfile detector, shell
  executor, process manager, approval workflow, or sandbox.
- No ToolInvocation, ToolObservation, shell/process Tool Effects, conversation
  messages, Agent Step, LLM call, or Tool/LLM budget entry for verification.
- No verification-specific timeout, deadline, cancellation status, or
  persistence/reattachment of processes.
- No claim of OS-level sandboxing or universal descendant termination.

## Existing architecture characterization

### 11A boundary

The current path is:

```text
Final Candidate
  -> RunController Final Candidate commit
  -> VerificationPlan + VerificationCheck rows
  -> Run VERIFYING
  -> AWAITING_VERIFICATION(planId)
  -> verification.planned
```

`RunExecutionStorePort` already owns the Run/State/Step/conversation/
continuation/plan commit boundary. The storage package owns the
`verification_plans`, `verification_checks`, and `verification_evidence`
repositories and the SQLite durable event append path. Phase 11B extends
these ports with narrow verification execution transactions; it does not add
verification attempt or command tables.

The existing Run execution invariant requires a VERIFYING Run to retain the
same plan through `AWAITING_VERIFICATION`, with no active Agent Step and no
final result. The controller remains the authority for Run cancellation,
deadline, recovery, and terminal status.

### Phase 5 project facts

`ProjectInspector.inspect()` resolves the workspace scope, project root,
environment, `ProjectProfile`, instructions, and diagnostics. It invokes the
existing `ProjectProfileDetector`, which walks only the bounded project
ancestors and provides:

- ordered ecosystem and language signals;
- manifest evidence and relative paths;
- `rootPackage` and `activePackage` with parsed exact script names/bodies;
- package-manager name, source, version hint, and evidence paths;
- monorepo facts;
- Cargo, Go, Maven, and Gradle tool evidence.

Before verification execution, the composition root supplies a fresh profile
from this existing path. The durable Run does not receive a ProjectProfile,
and `@caelush/verification` receives a structural profile input rather than
creating a detector. Verification never scans child packages or re-parses
manifests/lockfiles.

### Phase 8 Runtime path

The current string command path is:

```text
RuntimeExecService.execute
  -> LocalRuntimeExecService
  -> LocalShellResolver
  -> LocalProcessManager
  -> PipeProcessAdapter
  -> spawn(..., { shell: false })
```

The current `interact()` path polls a managed session and can write stdin.
Verification gets a narrow `executeArgv()` entry on the same service. It uses
the existing workspace path resolver, process manager, environment policy,
bounded output buffer, owner Run ID, and AbortSignal. Verification always uses
pipe mode (`tty:false`) and polls with `interact({ chars: "" })`; it never
writes stdin and never routes through PTY.

The new typed argv entry must not alter the existing `exec_command` string
semantics. Verification arguments are validated for non-empty executable,
NUL exclusion, bounded argument count/size/total UTF-8 bytes, and workspace
relative workdir. It uses the stricter existing Runtime limit whenever one is
already smaller.

### Phase 9 security path

Phase 9 currently separates base capability/risk policy, command
classification, input policy, logical containment, permission profile,
approval policy, and secret redaction. The verification adapter consumes
those generic semantics through a narrow host-command port. It does not call
`CaelushToolExecutionGate`, `ToolRegistry`, or `ToolDispatcher`, because
verification is a host action rather than an LLM Tool call.

The security adapter receives the current Run permission/approval profiles,
the typed candidate metadata, the candidate workdir, and one security input
for each Node lifecycle body. It applies the existing classification and
input-policy rules to all `pre<script>`, `<script>`, and `post<script>` bodies.
`SYSTEM_DESTRUCTIVE` is always denied. `REVIEW_REQUIRED` is fail-closed in
11B: no process starts, the Check becomes `ERROR`, and a bounded safe reason
is recorded as evidence. No Verification ApprovalRequest is created.

## Domain contracts

### Project command candidates

The verification package defines an ephemeral candidate, not a Protocol
entity:

```ts
interface VerificationCommandCandidate {
  readonly checkId: VerificationCheckId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly provenance: {
    readonly ecosystem: string;
    readonly resolver: string;
    readonly evidencePath?: string;
    readonly scriptName?: string;
  };
  readonly securityInputs: readonly VerificationCommandSecurityInput[];
  readonly candidateHash: string;
}
```

`VerificationCommandSecurityInput` is a structural, non-durable input carrying
only the script label/body and command context required by the security
adapter. Candidate objects, raw script bodies, full command lines, absolute
paths, environment values, and secrets never enter Protocol entities,
durable events, AgentState, Conversation, ToolObservation, or public result
summaries.

Resolver output is:

```ts
type ProjectCheckResolution =
  | { readonly kind: "READY"; readonly candidate: VerificationCommandCandidate }
  | { readonly kind: "UNAVAILABLE"; readonly reason: VerificationDiscoveryReason };
```

The bounded discovery reason set includes:
`SCRIPT_NOT_DEFINED`, `PACKAGE_MANAGER_UNKNOWN`,
`PACKAGE_MANAGER_AMBIGUOUS`, `ECOSYSTEM_UNSUPPORTED`,
`TOOLING_UNAVAILABLE`, and `PROJECT_PROFILE_INSUFFICIENT`.

### Resolver registry

`ProjectCheckResolverRegistry` owns immutable resolver registrations and selects
by the existing ProjectProfile facts. Resolver implementations are focused:

- `NodeProjectCheckResolver` handles exact package scripts and lifecycle
  security inputs.
- `RustProjectCheckResolver` handles explicit Cargo evidence.
- `JavaProjectCheckResolver` handles one unambiguous Maven or Gradle evidence.
- A conservative unsupported-ecosystem resolver returns unavailable without
  guessing Python or Go commands.

The registry is deterministic: no clock, randomness, network, LLM, environment
mutation, or child-package scan is permitted. A given profile/check pair
produces the same executable, argv, provenance, and SHA-256 candidate hash.

### Exact Node resolution

Supported aliases are intentionally exact:

| Check purpose | Exact script order             |
| ------------- | ------------------------------ |
| `LINT`        | `lint`                         |
| `TYPECHECK`   | `typecheck`, then `type-check` |
| `TEST`        | `test`                         |
| `BUILD`       | `build`                        |

In a monorepo, the root package is selected first for project-wide checks. If
the root package exists but lacks the exact alias, the active package is the
only fallback. The resolver never searches arbitrary child packages. An
unknown package manager is unavailable; an ambiguous lockfile result is
unavailable. Supported invocations are:

```text
pnpm -> ["pnpm", "run", scriptName]
npm  -> ["npm", "run", scriptName]
yarn -> ["yarn", "run", scriptName]
bun  -> ["bun", "run", scriptName]
```

The resolver never emits installers or one-shot downloaders (`npm install`,
`pnpm install`, `npx`, `pnpx`, `yarn dlx`, `bunx`, or equivalents).

The candidate hash covers the resolver version, executable, ordered args,
workspace-relative workdir, manifest evidence path, and the ordered
pre/main/post script bodies. The body is hash input only; its raw value is
never persisted.

### Rust resolution

Rust commands are available only when Phase 5 reports explicit Cargo evidence:

```text
TYPECHECK -> cargo check --offline
TEST      -> cargo test --offline
BUILD     -> cargo build --offline
LINT      -> unavailable
```

The offline flag prevents verification discovery from implicitly fetching
dependencies. No `cargo clippy` guess is made.

### Java resolution

Java commands are available only for a single explicit Maven or Gradle tool
evidence. Maven uses `mvn -o test` for TEST and `mvn -o -DskipTests package`
for BUILD so the two checks remain semantically separate. Gradle uses
`gradle --offline test` and `gradle --offline build`; no new high-risk flags
are introduced even if the build task may execute project-defined test work.
Java LINT and TYPECHECK are unavailable in 11B. Ambiguous Maven/Gradle facts
are unavailable.

Python and Go remain unavailable by default. The resolver does not guess
`pytest`, `ruff`, `mypy`, or `go test ./...`; adding explicit evidence for
those ecosystems is future work.

## Execution and persistence flow

For each PROJECT check in immutable Plan ordinal order:

1. Load the fresh ProjectProfile and resolve the current Check.
2. Create safe Discovery evidence data. For an unavailable resolution, append
   bounded Discovery evidence and settle `IF_AVAILABLE` as `SKIPPED` with
   `NOT_AVAILABLE`, or settle `REQUIRED` as `ERROR`. These preflight terminal
   paths emit a completed Check event but no started event.
3. Run the host Security admission. `DENY`, `SYSTEM_DESTRUCTIVE`, and
   `REVIEW_REQUIRED` all start zero processes and settle the Check as `ERROR`
   with a safe bounded reason.
4. Atomically commit `Check=RUNNING`, Discovery evidence, and
   `verification.check.started`. Do not launch an external process until this
   transaction commits successfully.
5. Call typed-argv Runtime with the Run owner, workspace-relative workdir,
   `tty:false`, no stdin write, and the Run AbortSignal.
6. Poll the returned managed session through existing `interact()` with an
   empty `chars` value until `EXITED`, abort, or Runtime error.
7. Normalize Runtime output, invoke the shared Phase 9 redactor, then apply
   the evidence byte cap. Never persist raw output first.
8. Atomically commit the terminal Check, Command evidence, and
   `verification.check.completed`; publish committed events only after the
   transaction returns.
9. Continue or stop according to the Check requirement and result.

The Runtime result mapping is deterministic:

| Runtime outcome                                            | Check status                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| exit code `0`                                              | `PASSED`                                                   |
| non-zero exit or signal exit                               | `FAILED`                                                   |
| executable missing / spawn failure                         | `ERROR` with `EXECUTABLE_UNAVAILABLE` or safe Runtime code |
| infrastructure failure with uncertain side-effect boundary | `ERROR`, fail closed                                       |
| Run cancellation                                           | RunController settles `CANCELLED`                          |
| Run deadline                                               | RunController settles `TIMEOUT`                            |

No verification-specific timeout or retry catches these outcomes.

## Check lifecycle and evidence

### Lifecycle invariants

The pure lifecycle validator enforces:

```text
PENDING -> RUNNING | SKIPPED | ERROR
RUNNING -> PASSED | FAILED | ERROR | CANCELLED
```

Terminal states cannot transition again. Timestamp rules are strict:

- `PENDING`: neither timestamp;
- `RUNNING`: `startedAt` required and `finishedAt` absent;
- `PASSED`, `FAILED`, `CANCELLED`: both timestamps required;
- `SKIPPED`: `startedAt` absent, `finishedAt` and `skipReason` required;
- preflight `ERROR`: `startedAt` absent and `finishedAt` required;
- execution `ERROR`: both timestamps required.

The schema accepts the two ERROR timestamp forms only by deriving whether
execution started; it does not permit ambiguous partial states.

### Evidence shape and bounds

Evidence remains append-only. Discovery evidence contains only safe provenance:

- resolver kind/version;
- ecosystem and package scope;
- workspace-relative manifest evidence path;
- package-manager/tool name;
- exact selected script name when applicable;
- candidate hash;
- bounded discovery reason/status.

Command evidence contains only a safe command label (`project lint`,
`project typecheck`, `project test`, or `project build`), candidate hash,
exit code or signal, bounded duration, bounded redacted output, total output
bytes, omitted bytes, and truncation status. It never stores the full command,
raw script body, absolute host path, environment, or credentials.

`VerificationEvidence.details` is validated against a maximum serialized JSON
UTF-8 size of 32 KiB. Command output is bounded to 16 KiB UTF-8 before it is
placed in the evidence details. The order is:

```text
Runtime output
  -> terminal normalization
  -> shared Phase 9 redactText/redactJson
  -> UTF-8 byte bound
  -> VerificationEvidence schema validation
  -> durable persistence
```

The same sanitized values are used for public summaries and events. Raw
secret values, raw script bodies, and raw output do not appear in the database
or event stream.

### Events

Phase 11B adds these durable events without changing legacy contracts:

- `verification.check.started`: `planId`, `checkId`, `ordinal`, `kind`,
  `purpose`, and `stage`;
- `verification.check.completed`: `planId`, `checkId`, terminal `status`,
  evidence IDs, and optional bounded duration.

Started is emitted exactly once only after the atomic start commit. A
preflight SKIPPED/ERROR emits only completed. Completion is emitted exactly
once only after the terminal settlement commit. Neither event carries command
text, script bodies, stdout/stderr, goal, candidate text, or secrets.

Legacy `verification.started`, `verification.completed`, `VerificationResult`,
and `VerificationState` remain exported for compatibility but are not used by
the Phase 11 pipeline.

## RunController behavior

The Final Candidate transaction remains unchanged and commits before any
verification process is launched. Once it is published, the controller may
drive PROJECT checks through an injected verification runner. The runner has
no database access; the controller/storage adapter owns durable transactions.

The controller never mutates the Plan structure, reorders checks, appends or
deletes checks, or updates old evidence. It drives one PENDING check at a time
and reuses terminal checks on recovery. It does not rerun a terminal Check.

Blocking behavior:

- REQUIRED `FAILED` or `ERROR` stops later PROJECT checks;
- an executed `IF_AVAILABLE` `FAILED` or `ERROR` also stops later checks;
- ADVISORY failure continues;
- valid `IF_AVAILABLE` `SKIPPED` continues;
- preflight REQUIRED unavailable is blocking ERROR;
- missing executable after successful discovery is execution ERROR, not
  `NOT_AVAILABLE`.

The returned result contains only safe verification counts and an optional
blocking Check ID. It never returns stdout, script body, or full command.
After all PROJECT checks pass, `evaluateVerification()` remains `INCOMPLETE`
because TASK, WORKSPACE, and/or GIT checks are still pending; the Run remains
`VERIFYING`.

The configured Run scope propagates cancellation to the owned Runtime process.
After cancellation or deadline, the controller prevents trailing checks from
starting and lets canonical Run termination settle `CANCELLED` or `TIMEOUT`.
No verification process can make a cancelled or timed-out Run pass.

Recovery is deliberately conservative:

- a VERIFYING Run with no RUNNING Check may continue its next PENDING PROJECT
  check;
- a RUNNING Check after restart is stale and is never reset to PENDING or
  replayed; the controller returns `VERIFICATION_RECOVERY_REQUIRED` while the
  Run stays VERIFYING;
- completed checks and their evidence/events are reused exactly as persisted;
- no LLM, Tool, process reattachment, or automatic replay occurs for stale
  work.

## Dependency direction

The intended dependency graph is:

```text
apps -> core -> verification -> protocol
apps -> context
apps -> runtime
apps -> security
apps -> storage -> core/events/protocol
```

`verification` receives structural ProjectProfile and execution/security
ports; it does not import storage, tools, llm, or child process APIs. Runtime
does not import verification. Security does not import verification. Context
does not import verification. Core does not spawn processes directly. Only
Runtime owns `node:child_process` and `node-pty` imports. The composition root
connects the fresh Phase 5 profile provider, Phase 9 host security adapter,
typed Runtime service, and storage execution transactions.

## Research inputs

| Project                                                                                   | Absorbed                                                                            | Rejected                                   | Reason                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [OpenAI Codex](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md) | Specific validation first, then broader checks; truthful unrelated-failure handling | Codex-specific workflow/UI                 | Caelush needs deterministic host contracts, not prompt behavior                           |
| [OpenCode](https://github.com/anomalyco/opencode)                                         | Project-specific configuration and manifest evidence as the command source          | Copying its product/runtime composition    | Caelush already has Phase 5 ProjectProfile and Phase 8 Runtime                            |
| [Aider](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)           | Explicit lint/test command concepts and bounded diagnostics                         | Shell-based execution and automatic repair | A repo-provided command is untrusted input; Caelush uses typed argv and Phase 9 admission |
| [Aider security issue #5254](https://github.com/Aider-AI/aider/issues/5254)               | Treat repository lint/test configuration as an arbitrary-code execution boundary    | Automatic execution without review         | This directly motivates lifecycle-body analysis and fail-closed review                    |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent)                                       | Submission/test validation as a distinct boundary                                   | LLM-driven task acceptance                 | Task acceptance belongs to Phase 11C/11D, not 11B                                         |
| [Cline](https://github.com/cline/cline)                                                   | Completion claims must remain separate from evidence                                | `attempt_completion`-style authority       | Phase 11B cannot complete a Run                                                           |

## Testing strategy

New tests are written RED before implementation and cover real behavior:

- Protocol lifecycle timestamp transitions and serialized evidence-byte cap;
- Node exact alias, root/active precedence, package-manager unknown/ambiguous,
  lifecycle inclusion, deterministic hash, and forbidden installer/dlx output;
- Rust offline, Java offline, and conservative Python/Go behavior;
- typed argv validation, exact executable/args, workspace containment,
  `shell:false`, `tty:false`, abort cleanup, bounded output, and unchanged
  `exec_command` regression;
- Security ALLOW/REVIEW_REQUIRED/DENY/system-destructive/opaque/secret cases,
  including dangerous pre/post lifecycle bodies and zero process starts;
- redacted bounded Discovery/Command evidence and raw-secret absence;
- atomic start/settlement failure injection and publish-after-persist;
- exit mapping, missing executable, fail-fast, advisory/skip continuation,
  ordinal order, plan immutability, and no Tool/Step/LLM/budget accounting;
- cancellation, Run deadline, PENDING recovery, stale RUNNING no-replay,
  SQLite restart, and event exact-once behavior;
- architecture guards for forbidden package imports and Phase 11C/11D leakage.

New production functions are introduced only after their focused test has
failed for the expected missing-behavior reason. Focused and full gates are
run serially. The final clean-build pass removes only generated
`apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` using Node filesystem
APIs, never `git clean`. Phase 11B changed files must have zero Prettier
warnings, while the full repository warning count must remain at or below the
recorded baseline of 637.

## Phase boundary after implementation

On success, README status is:

```text
Phase 11A  COMPLETED
Phase 11B  COMPLETED
Phase 11C  NOT STARTED
Phase 11D  NOT STARTED
Phase 11   IN PROGRESS
```

The capability statement is deliberately limited: Caelush can discover
supported project checks from real project evidence, safely admit them,
execute them through the shared typed-argv Runtime, and persist bounded
verification evidence. Workspace/Git/task acceptance, repair, and completion
authority remain pending for later Phase 11 rounds.
