# Phase 11B Verification Execution

Phase 11B is the deterministic execution round for the intent created by Phase 11A. It executes only `PROJECT` checks whose purposes are `LINT`, `TYPECHECK`, `TEST`, or `BUILD`. `WORKSPACE`, `GIT`, and `TASK` checks remain `PENDING`; the Run remains `VERIFYING` even when every executed project check passes. Completion authority belongs to Phase 11D.

## Execution pipeline

```text
VerificationPlan intent
  → fresh Phase 5 ProjectInspector profile
  → exact project candidate resolver
  → Phase 9 security admission
  → typed argv on the shared Phase 8 Runtime/LocalProcessManager
  → bounded, redacted Command/Discovery evidence
  → atomic Check + evidence + durable event settlement
```

The Core composition supplies the fresh profile through `ProjectInspector.inspect()`. Verification does not scan child packages, parse manifests or lockfiles, invent commands, or persist a ProjectProfile. It receives structural facts only. Candidate hashes include resolver/version, executable, ordered argv, workspace-relative workdir, manifest/tool evidence, and ordered lifecycle script bodies; raw script bodies are ephemeral security/hash input and never durable evidence.

## Supported resolution

Node uses exact scripts: `lint`; `typecheck`, then `type-check`; `test`; and `build`. The root package wins for project-wide checks; the active package is the only fallback when the root lacks the exact alias. Commands are explicit `pnpm|npm|yarn|bun run <script>`, and existing `pre<script>`/main/`post<script>` bodies are evaluated in order. No installer, downloader, fuzzy alias, or arbitrary child-package search is generated.

Rust requires explicit Cargo evidence and runs `cargo check|test|build --offline`; lint is unavailable. Java requires exactly one explicit Maven or Gradle evidence source and runs `mvn -o test`, `mvn -o -DskipTests package`, `gradle --offline test`, or `gradle --offline build`. Python, Go, ambiguous tooling, missing package managers, and missing scripts are conservatively unavailable.

## Security and runtime

The candidate and each Node lifecycle body pass through the Phase 9 command/input policy adapter. `DENY` and `REQUIRE_APPROVAL` both fail closed in 11B: no process starts, no ApprovalRequest is created, and the check settles as `ERROR` with a safe discovery reason. Verification is a host action, not a Tool call: it does not create ToolInvocation/ToolObservation rows, Tool Effects, conversation messages, Agent Steps, LLM calls, or budget entries.

Allowed candidates use the existing Runtime `executeArgv()` entry and `LocalProcessManager` pipe path with `shell:false`, workspace-relative containment, owner Run ID, bounded output, and the existing Run-owned `AbortSignal`. Verification never uses the string shell command API, PTY, model-controlled environment, or a verification-specific timeout. Non-zero and signal exits are normal failed checks; process uncertainty is fail-closed and is never automatically replayed.

## Durable lifecycle and recovery

For an executable check, the durable `RUNNING` Check and Discovery evidence are committed before process launch. Terminal Check state, sanitized Command evidence, and `verification.check.completed` are committed atomically. Durable events are published only after commit; the durable sequence is the event order. A blocking failure or error stops later project checks (advisory failures do not); unavailable `IF_AVAILABLE`/advisory checks become `SKIPPED` with bounded discovery evidence.

The Core controller starts verification only after the Final Candidate/Plan/`VERIFYING` transaction has committed and its events have been notified. Recovery never replays a durable `RUNNING` check because its process side effect cannot be proven; it leaves the Run at the verification boundary. A clean `PENDING` boundary may execute the next check in ordinal order. Existing Run cancellation and deadline authorities win over verification work: the controller supplies the signal, aborts owned work, and performs the canonical Run settlement. Phase 11B adds no new timeout, retry, cancellation status, approval workflow, or completion transition.

Evidence details are JSON-safe and capped at 32 KiB serialized UTF-8. Command stdout/stderr is high-confidence redacted before bounded snippets are stored, with omitted-byte metadata. Discovery evidence records resolver/provenance and safe availability/security reason codes, never raw scripts, credentials, absolute paths, or full command lines.

## Explicit exclusions

Phase 11B does not execute workspace changeset sanity, Git semantic review, task acceptance, an LLM reviewer, repair, retry, re-verification, completion evaluation as authority, or `COMPLETED` transition. The local process remains a host capability with policy controls and may have workspace side effects; this is not an OS hard sandbox, universal descendant termination guarantee, or crash-atomic process transaction. See [Verification Architecture](verification.md), [Runtime](runtime.md), and [Security Policy Kernel](security.md).
