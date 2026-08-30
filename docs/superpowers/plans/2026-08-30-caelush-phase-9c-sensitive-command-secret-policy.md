# Caelush V1 Phase 9C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add input-aware sensitive-resource and shell-command policy, deterministic secret-safe public projections, and sanitize-before-persist Tool result handling while preserving Phase 9A monotonic decisions and Phase 9B approval/recovery semantics.

**Architecture:** `@caelush/tools` owns provider-neutral host-only contracts and injects a pure `securityFactsProjector` per registration plus a required `resultSanitizer` port. `@caelush/security` owns sensitive-path classification, command tokenization/classification, input-aware policy assessment, monotonic decision combination, safe approval previews, and deterministic text/JSON/result redaction; it depends only on Protocol and Tools ports/types and never on Runtime, Storage, Events, Core, LLM, filesystem, or process APIs. Built-in Tool registrations project their arguments into facts, with patch targets obtained through a narrow pure Runtime patch-inspection export. The Dispatcher validates raw output, sanitizes it, revalidates the sanitized result, then projects effects and commits only sanitized observations/events; exact approval keys continue to use private raw arguments and current gate evaluation always precedes RUN grant lookup.

**Tech Stack:** TypeScript 6, Node.js 24 ESM, pnpm workspace, Zod Protocol contracts, AJV Tool schemas, Vitest, TypeScript project references, SQLite/Drizzle unchanged.

**Spec:** User-provided Phase 9C task text pasted at `C:\Users\韩吉衍\.codex\attachments\e4f80a08-c383-4e38-b8f4-38cb8050dc61\pasted-text.txt`.

## Global Constraints

- Base is `origin/codex/phase-9b-durable-approval-workflow` at verified SHA `632ffbf7f7ecbd00f5b84b6db1e8ebc067638311`; `origin/master` is not an ancestor.
- Work only in `.worktrees/phase-9c-sensitive-command-secret-policy` on `codex/phase-9c-sensitive-command-secret-policy`; do not merge master, create a PR, or add a Phase 9 sub-round.
- Phase 9A metadata policy remains authoritative; Phase 9C may only preserve or tighten decisions: DENY stays DENY, REQUIRE_APPROVAL stays REQUIRE_APPROVAL or DENY, and ALLOW may become ALLOW, REQUIRE_APPROVAL, or DENY.
- Input-aware review requirements become DENY under `NEVER_ASK`; high-confidence system-destructive commands are always DENY.
- Security facts are pure, deterministic, host-only, ephemeral analysis data. They must never be durable, event payloads, model definitions, observations, approval action data, or public errors.
- `ToolInvocation.args` remains private raw durable execution data for recovery, idempotency, exact execution, and exact approval identity. Phase 9C does not encrypt arguments at rest.
- No OS sandbox, cancellation, timeout manager, retry/backoff, budget manager, verification runner, CLI/Web UI, configurable wildcard rules, global policy DSL, or new database migration.
- Do not use `prettier --write .`; changed files must have zero Prettier warnings and final repository warnings must not exceed the measured `PHASE_9C_FORMAT_BASELINE`.
- All final gates run serially: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check`.

## Existing Boundary Characterization

- Baseline recorded before implementation: `pnpm install --frozen-lockfile`, lint PASS, typecheck PASS, plain tests PASS (`200` files, `683` passed, `4` skipped), build PASS, and `PHASE_9C_FORMAT_BASELINE` reports `548` existing warning files. `pnpm check` passes its lint/typecheck/test/build stages and exits at the same format debt.
- Current gate accepts `ToolInvocation`, Tool metadata, and `ToolSecurityContext`, then calls `evaluateSecurityPolicy` with capabilities/risk only. RUN grants are checked after a `REQUIRE_APPROVAL` decision in `ToolDispatcher.applyGate`; recovery re-evaluates the gate before executing approved work.
- Current output pipeline validates `ToolExecutionResult`, immediately projects effects, builds `ToolObservation`, creates tool lifecycle events, and commits them. `ToolInvocation.args` is not in lifecycle event payloads, but output content/details can contain handler secrets unless a sanitizer is inserted before observation/effects/commit.
- Current built-ins are `read_file`, `list_directory`, `find_files`, `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `git_status`, and `git_diff`. Runtime uses `$SHELL` or `/bin/sh -c` on POSIX and PowerShell/pwsh or `cmd.exe` on Windows.

## Architecture References

- Current Codex `exec_policy.rs` models command origin, parsed command context, explicit approval requirements, and forbidden/needs-approval/skip outcomes: https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- Current Codex shell safety code separates command analysis from execution and has distinct dangerous-command handling: https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/command_safety/is_dangerous_command.rs
- Current Codex approval/sandboxing code preserves approval keys and separates approval from sandbox materialization: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/sandboxing.rs
- OpenCode permission documentation demonstrates input-aware tool permissions and distinguishes ask/allow/deny; Phase 9C intentionally does not copy its user wildcard DSL: https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx
- OpenCode shell implementation is a reference for shell-tool presentation and execution boundaries only: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/shell.ts

### Task 1: Baseline and Phase 9B characterization

**Files:**
- Read: `packages/security/test/*.test.ts`, `packages/tools/test/dispatcher-*.test.ts`, `packages/storage/test/approval-repository.test.ts`, `packages/storage/test/run-controller-*.test.ts`.
- Modify: none unless a characterization test exposes a genuine 9B regression.

**Interfaces:**
- Consumes: existing `CaelushToolExecutionGate`, `ToolDispatcher`, `ToolApprovalStorePort`, and storage recovery contracts.
- Produces: recorded baseline output and a focused regression command list for every later task.

- [ ] **Step 1: Re-run the baseline commands serially.** Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from the Phase 9C worktree and record exit codes and counts in the completion report.
- [ ] **Step 2: Re-run format and check baselines.** Run `pnpm format:check` prefixed by the literal marker `PHASE_9C_FORMAT_BASELINE`, count warning files, then run `pnpm check`; do not rewrite formatting.
- [ ] **Step 3: Characterize 9B behavior.** Run `pnpm vitest run packages/tools/test/dispatcher-approval.test.ts packages/tools/test/dispatcher-recovery.test.ts packages/storage/test/approval-repository.test.ts packages/storage/test/run-controller-tool-integration.test.ts packages/storage/test/run-controller-recovery.test.ts packages/storage/test/run-controller-restart.test.ts packages/protocol/test/approval-workflow.test.ts` and retain the exact passing count.
- [ ] **Step 4: Commit only if baseline documentation is changed.** Use `git status --short` to verify the worktree has no unrelated changes; do not commit generated `dist` or `*.tsbuildinfo` files.

### Task 2: Tool Security Facts contracts and host-only registry plumbing

**Files:**
- Create: `packages/tools/src/security-facts.ts`, `packages/tools/test/security-facts-contracts.test.ts`.
- Modify: `packages/tools/src/registration.ts`, `packages/tools/src/registry.ts`, `packages/tools/src/registry-builder.ts`, `packages/tools/src/index.ts`, `packages/tools/test/registry-builder.test.ts`, `packages/tools/test/registry.test.ts`, `tests/architecture/security-boundaries.test.ts`.

**Interfaces:**
- Produces `ToolResourceOperation = "READ" | "WRITE" | "DELETE" | "MOVE" | "SEARCH" | "DIFF"`, `ToolResourceAccess { operation, path }`, `ToolShellCommandFact { command, workdir, tty }`, `ToolSecretScanInput { kind: "COMMAND" | "STDIN" | "PATCH" | "GENERIC"; text }`, `ToolSecurityFacts { resourceAccesses, shellCommand?, secretScanInputs, structuralPreview? }`, and `ToolSecurityFactsProjector = (args: Readonly<JsonObject>) => ToolSecurityFacts`.
- Extends `ToolRegistration` and internal `ResolvedTool` with optional `securityFactsProjector`; `modelDefinitions()` continues exposing exactly name/description/inputSchema and no projector/facts.
- `ToolSecurityFactsProjector` receives only validated args, is pure/deterministic/no-I/O, and throws a host-only projection error that the Dispatcher maps to conservative input handling.

- [ ] **Step 1: Write the failing contract tests.** Assert facts are not present in `modelDefinitions()`, a registration can carry a projector, projector output is not serialized by the model API, and the public package exports only data types/functions.
- [ ] **Step 2: Run the focused tests and verify RED.** Run `pnpm vitest run packages/tools/test/security-facts-contracts.test.ts packages/tools/test/registry-builder.test.ts packages/tools/test/registry.test.ts`; expected failure is missing facts contracts/registration field behavior.
- [ ] **Step 3: Implement the smallest contracts and registry plumbing.** Add the types and pass the projector through builder and registry without running it or exposing it from `modelDefinitions()`.
- [ ] **Step 4: Run focused tests and typecheck.** Re-run the focused tests and `pnpm --filter @caelush/tools typecheck`; expected PASS.
- [ ] **Step 5: Commit.** `git add packages/tools tests/architecture/security-boundaries.test.ts && git commit -m "feat(tools): project host-only security facts"`.

### Task 3: Narrow pure Runtime patch inspection

**Files:**
- Create: `packages/runtime/src/patch/inspection.ts`, `packages/runtime/test/patch-inspection.test.ts`.
- Modify: `packages/runtime/src/index.ts`, `packages/tools/package.json` only if the existing workspace dependency is insufficient.

**Interfaces:**
- Produces `inspectPatchTargets(patch: string): readonly { operation: "WRITE" | "DELETE" | "MOVE"; path: string; fromPath?: string; toPath?: string }[]`, implemented by `parsePatch` and existing `PatchOperation` values. It must not duplicate patch grammar and must preserve parser errors/limits.

- [ ] **Step 1: Write tests first.** Cover ADD→WRITE, UPDATE→WRITE, DELETE→DELETE, UPDATE with `moveTo`→MOVE with source/destination, all relative paths, and malformed/absolute/escaping patches retaining the existing parser error.
- [ ] **Step 2: Run `pnpm vitest run packages/runtime/test/patch-inspection.test.ts` and verify RED.** Expected failure is the missing inspection export.
- [ ] **Step 3: Implement `inspection.ts` by calling `parsePatch`.** Map parsed operations only; do not add a second grammar or filesystem access.
- [ ] **Step 4: Run focused Runtime tests and `pnpm --filter @caelush/runtime typecheck`.** Expected PASS with all existing patch tests unchanged.
- [ ] **Step 5: Commit.** `git add packages/runtime && git commit -m "feat(runtime): expose pure patch target inspection"`.

### Task 4: Built-in Tool Security Facts projectors

**Files:**
- Create: `packages/tools/src/builtins/security-facts.ts`, `packages/tools/test/builtin-security-facts.test.ts`.
- Modify: `packages/tools/src/builtins/read-file.ts`, `list-directory.ts`, `find-files.ts`, `search-text.ts`, `apply-patch.ts`, `exec-command.ts`, `write-stdin.ts`, `git-status.ts`, `git-diff.ts`, and `packages/tools/src/index.ts`.

**Interfaces:**
- Produces pure projector functions for each built-in. Paths normalize separators but remain workspace-relative facts. `read_file` emits READ path; `apply_patch` uses Runtime inspection and emits WRITE/DELETE/MOVE targets plus PATCH scan input without previewing body; `exec_command` emits shell command/workdir/tty and COMMAND scan input; `write_stdin` emits sessionId/inputBytes structural preview and STDIN scan input only; `search_text` emits SEARCH path/include and pattern scan input; `git_diff` emits DIFF explicit path or `.` broad scope; list/find/status emit metadata-only facts without content-read claims.
- Projector failures are represented as `OPAQUE_INPUT` by the security boundary, not ignored.

- [ ] **Step 1: Add failing projector tests.** Use validated-like args and assert exact facts, including patch operation mapping, no stdin chars in structural preview, no patch body in preview, and search `path="."` remaining broad.
- [ ] **Step 2: Run focused tests and verify RED.** `pnpm vitest run packages/tools/test/builtin-security-facts.test.ts` must fail because built-in registrations lack projectors.
- [ ] **Step 3: Implement pure projectors and attach them to registrations.** Import only the narrow Runtime inspection helper in the patch projector; do not import Security or put policy strings in Dispatcher.
- [ ] **Step 4: Run focused built-in/catalog tests and typecheck.** `pnpm vitest run packages/tools/test/builtin-security-facts.test.ts packages/tools/test/security-catalog-characterization.test.ts packages/tools/test/default-tools.test.ts` and `pnpm --filter @caelush/tools typecheck` must pass.
- [ ] **Step 5: Commit.** `git add packages/tools && git commit -m "feat(tools): add built-in security fact projectors"`.

### Task 5: Sensitive path classifier and resource overlay

**Files:**
- Create: `packages/security/src/sensitive-path.ts`, `packages/security/src/input-policy.ts`, `packages/security/test/sensitive-path.test.ts`, `packages/security/test/input-policy.test.ts`.
- Modify: `packages/security/src/decision.ts`, `packages/security/src/index.ts`, and later `tool-gate.ts`.

**Interfaces:**
- Produces `SensitivePathCategory = "ENVIRONMENT_FILE" | "CREDENTIAL_FILE" | "PRIVATE_KEY" | "AUTH_CONFIG" | "CLOUD_CREDENTIAL_FILE" | "CERTIFICATE_CONTAINER"`, `classifySensitivePath(path: string): SensitivePathCategory | undefined`, and `evaluateInputSecurityPolicy(facts, context)`.
- Matching normalizes `\\` to `/`, rejects absolute/`..` facts conservatively, matches known filenames case-insensitively, recognizes `.env`/`.env.*`, credential/auth/cloud/private-key/certificate patterns, and excludes `.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, and obvious `.env.*.example|sample|template|defaults` variants.
- Direct sensitive accesses require approval or become DENY under `NEVER_ASK`; explicit sensitive mutation is treated the same. Safe reasons/codes contain category/classification only, never paths that reveal host locations, raw args, content, or secret values.

- [ ] **Step 1: Write the classifier and policy matrix tests.** Cover forward/backslash/mixed case/nested paths, all required sensitive names, near misses, template exceptions, invalid absolute/escape paths, READ/WRITE/DELETE/MOVE/DIFF/SEARCH, READ_ONLY/FULL_ACCESS, DANGEROUS_ONLY/ALWAYS_ASK/NEVER_ASK, and opaque projector input.
- [ ] **Step 2: Run `pnpm vitest run packages/security/test/sensitive-path.test.ts packages/security/test/input-policy.test.ts` and verify RED.** Expected failure is missing classifier/overlay.
- [ ] **Step 3: Implement the pure classifier and input assessment.** Use fixed tables and deterministic matching only; return structured non-secret signals and safe preview metadata.
- [ ] **Step 4: Run focused tests and `pnpm --filter @caelush/security typecheck`.** Expected PASS.
- [ ] **Step 5: Commit.** `git add packages/security && git commit -m "feat(security): classify sensitive resources"`.

### Task 6: Command tokenizer, wrapper parser, and platform-aware analyzer

**Files:**
- Create: `packages/security/src/command-policy.ts`, `packages/security/test/command-policy.test.ts`.
- Modify: `packages/security/src/index.ts`.

**Interfaces:**
- Produces `CommandPlatform = "POSIX_SH" | "POWERSHELL" | "CMD"`, `CommandClassification = "NORMAL_LOCAL" | "LOCAL_REPO_MUTATION" | "DESTRUCTIVE_LOCAL" | "NETWORK_ACCESS" | "REMOTE_MUTATION" | "PRIVILEGE_ESCALATION" | "SYSTEM_DESTRUCTIVE" | "OPAQUE_DYNAMIC"`, `CommandPolicyAnalysis { classifications, wrapperDepth, preview }`, and `analyzeCommand({ command, platform, workdir, tty })`.
- Tokenization handles quoting, escapes, `&&`, `||`, `;`, `|`, and segments without executing. Wrappers recurse through `sh/bash/zsh -c|-lc`, `env`, `sudo`, `powershell/pwsh -Command`, and `cmd /c`; depth limit is 8, depth 9 or ambiguous/dynamic/eval/encoded command is `OPAQUE_DYNAMIC`.
- Analyzer has no process/filesystem/network/storage/EventBus access and never classifies via one raw substring check. It recognizes read-only Git, repo mutation, destructive local, high-confidence system destructive, network, remote mutation, and privilege escalation; multiple signals are retained and preview is bounded to 2 KiB with an explicit truncation marker.

- [ ] **Step 1: Write tokenizer/parser tests.** Cover simple/quoted args, separators, POSIX wrappers, nested wrappers, env/sudo, PowerShell `-Command`, cmd `/c`, wrapper depth 8/9, dynamic variables/eval/encoded PowerShell, and zero child processes.
- [ ] **Step 2: Run the focused test and verify RED.** `pnpm vitest run packages/security/test/command-policy.test.ts` must fail because the analyzer is absent.
- [ ] **Step 3: Implement bounded lexical parsing.** Keep platform syntax injected; normalize executable basenames only after structural tokenization; make ambiguity opaque rather than safe.
- [ ] **Step 4: Add classification tests and implementation.** Cover `git status/diff/log/show/rev-parse`, `git add/commit/reset/clean/merge/rebase/push`, `rm file`, `rm -rf directory`, provable `rm -rf /|/*|~`, `mkfs`, diskpart/raw disk writes, shutdown/reboot/poweroff, sudo/su/doas/runas/Start-Process -Verb RunAs, curl/wget/ssh/scp/sftp/fetch/pull/package install, npm/pnpm/yarn publish, twine/docker push, and normal `npm test`/`node --version`.
- [ ] **Step 5: Run focused tests, architecture scan, and typecheck.** Expected PASS and no `child_process`/shell execution imports.
- [ ] **Step 6: Commit.** `git add packages/security && git commit -m "feat(security): add input-aware command policy"`.

### Task 7: Monotonic decision combination and Gate integration

**Files:**
- Modify: `packages/security/src/decision.ts`, `packages/security/src/evaluator.ts`, `packages/security/src/input-policy.ts`, `packages/security/src/tool-gate.ts`, `packages/security/src/index.ts`, `packages/tools/src/dispatcher-ports.ts`, `packages/tools/src/dispatcher.ts`.
- Test: `packages/security/test/decision-matrix.test.ts`, `packages/security/test/tool-gate.test.ts`, `packages/security/test/dispatcher-integration.test.ts`, `packages/tools/test/dispatcher-approval.test.ts`.

**Interfaces:**
- Extends `ToolExecutionGateInput` with optional host-only `securityFacts` and `ToolExecutionGateDecision` with optional redacted `safeAction?: JsonObject`.
- `combineSecurityDecisions(base, overlay)` is pure and obeys DENY > REQUIRE_APPROVAL > ALLOW; input review under `NEVER_ASK` is DENY. `SYSTEM_DESTRUCTIVE` always returns DENY regardless of profile/policy.
- Gate flow is validated invocation/definition/context → base `evaluateSecurityPolicy` → projector facts → input assessment → monotonic combination. Projector failure becomes opaque review or DENY under `NEVER_ASK`; no handler runs before this completes.
- Dispatcher computes facts through resolved registration, passes them to the Gate, and checks RUN grants only after the effective decision is still `REQUIRE_APPROVAL`. Existing ONCE/RUN exact semantics and approval key inputs are unchanged.

- [ ] **Step 1: Write failing monotonic/gate tests.** Assert all nine base/overlay combinations, base DENY and ASK cannot downgrade, `NEVER_ASK` never emits approval, `SYSTEM_DESTRUCTIVE` always DENY, normal `npm test` cannot reduce CRITICAL `exec_command` approval, and cached RUN grants cannot override a new 9C DENY.
- [ ] **Step 2: Run focused tests and verify RED.** Run `pnpm vitest run packages/security/test/decision-matrix.test.ts packages/security/test/tool-gate.test.ts packages/security/test/dispatcher-integration.test.ts packages/tools/test/dispatcher-approval.test.ts`; expected failures identify missing overlay wiring.
- [ ] **Step 3: Implement decision codes and effective combination.** Keep codes stable/non-secret and preserve Phase 9A reason behavior for no-overlay calls.
- [ ] **Step 4: Wire facts through Dispatcher and reorder grant lookup.** Ensure the current gate is evaluated before `findApplicableRunGrant`; ensure old approvals can still load/recover when no rich preview exists.
- [ ] **Step 5: Run focused 9A/9B regression suite.** Include `packages/security/test/*.test.ts`, relevant Dispatcher approval/recovery tests, and storage approval/controller tests; expected PASS.
- [ ] **Step 6: Commit.** `git add packages/security packages/tools && git commit -m "feat(security): integrate monotonic input policy"`.

### Task 8: Deterministic SecretDetector and text redaction

**Files:**
- Create: `packages/security/src/secrets.ts`, `packages/security/test/secrets.test.ts`.
- Modify: `packages/security/src/index.ts`.

**Interfaces:**
- Produces `SecretCategory`, `SecretMatchReport { redactionCount, categories }`, `SecretDetector`, `SecretRedactor`, `redactText(text): { text, report }`, and constants `MAX_SECRET_SCAN_TEXT_BYTES`, `MAX_SECRET_JSON_DEPTH`, `MAX_SECRET_JSON_NODES`.
- Detects high-confidence private-key blocks, Authorization Bearer/Basic bodies, URL userinfo, credential query parameters, provider token shapes, and case-insensitive generic assignments for api_key/apikey/token/access_token/refresh_token/secret/client_secret/password/passwd/credential/private_key/access_key. It uses no entropy-only rule, random/time/I/O/network/LLM, exposes no match/offset/hash/fingerprint, and replaces full secret bodies with `[REDACTED]` or `[REDACTED:CATEGORY]` without partial fragments.
- Placeholder heuristics exempt obvious `YOUR_API_KEY`, `<token>`, `${TOKEN}`, `REDACTED`, `changeme`, `example`, `placeholder`, `xxxx`, while structurally valid provider tokens remain redacted. Oversized text returns a bounded scan-limit replacement and no raw tail. Redaction is deterministic and idempotent.

- [ ] **Step 1: Write failing detector/redactor tests.** Cover fake env assignments, JSON-like text, bearer/basic, private-key blocks, URL userinfo/query, provider token fixture, multiple secrets/lines, Unicode, CRLF, long input, placeholders, already-redacted input, and idempotency.
- [ ] **Step 2: Run `pnpm vitest run packages/security/test/secrets.test.ts` and verify RED.** Expected failure is absent API.
- [ ] **Step 3: Implement ordered high-confidence detectors and full-value replacement.** Avoid dynamic regex construction from untrusted input and keep scan bounds deterministic.
- [ ] **Step 4: Run focused tests and typecheck.** Expected PASS.
- [ ] **Step 5: Commit.** `git add packages/security && git commit -m "feat(security): add deterministic secret redaction"`.

### Task 9: JSON redaction and safe argument/preview presentation

**Files:**
- Modify: `packages/security/src/secrets.ts`, `packages/security/src/input-policy.ts`, `packages/security/src/tool-gate.ts`, `packages/security/src/index.ts`.
- Create: `packages/security/test/json-redaction.test.ts`, `packages/security/test/approval-preview.test.ts`.

**Interfaces:**
- Produces `redactJson(value: JsonValue): JsonValue`, `redactToolArgumentsForPresentation(toolName, args): JsonObject`, and bounded preview builders for FILE_READ, PATCH, SHELL_COMMAND, PROCESS_INPUT, SEARCH, and GIT_DIFF. Sensitive object keys replace entire values; strings recurse through text redaction; numbers/booleans/null remain; arrays/nested objects recurse; depth/node limits replace unscanned subtrees with `[REDACTED:SCAN_LIMIT]`.
- `safeAction` is generated only from facts, is JSON-safe and redacted, never includes patch body, stdin chars, raw command, full file content, host absolute paths, secret hashes/fingerprints, or secret fragments. `write_stdin` shows only `sessionId` and `inputBytes`; command preview includes redacted command/workdir/tty/classifications and explicit truncation.
- Redacted preview never participates in `computeToolApprovalKey`; raw canonical args remain the identity input.

- [ ] **Step 1: Write failing JSON and preview tests.** Cover object key-awareness, arrays, nested objects, limits, preview shape/privacy, command A/B same redacted preview but different approval keys, patch body exclusion, stdin chars exclusion, and sentinel absence.
- [ ] **Step 2: Run focused tests and verify RED.** Expected missing JSON/preview functions.
- [ ] **Step 3: Implement recursive bounded JSON redaction and fact-driven preview builders.** Use `canonicalJsonString` only for identity, never for redacted preview identity.
- [ ] **Step 4: Run focused tests and existing approval-key tests.** Expected PASS.
- [ ] **Step 5: Commit.** `git add packages/security && git commit -m "feat(security): add safe approval previews"`.

### Task 10: ToolResultSanitizer port and Security implementation

**Files:**
- Create: `packages/tools/src/result-sanitizer.ts`, `packages/security/src/result-sanitizer.ts`, `packages/security/test/result-sanitizer.test.ts`.
- Modify: `packages/tools/src/index.ts`, `packages/security/src/index.ts`.

**Interfaces:**
- `ToolResultSanitizerPort.sanitize({ toolName, result, invocation }): ToolExecutionResult` is defined in Tools; implementation is `SecurityToolResultSanitizer` in Security.
- Sanitization applies general text/JSON redaction. `read_file` redacts text and sensitive assignment details; `search_text` redacts each match text and replaces sensitive-file match bodies with `[REDACTED:SENSITIVE_FILE_CONTENT]` while retaining relative path/line; `git_diff` redacts added/removed/context lines and sensitive-path hunks as `[SENSITIVE DIFF CONTENT REDACTED]`; shell/stdin output redacts merged content; metadata-only outputs preserve filenames.
- Sanitizer is deterministic, pure, schema-neutral, and never a production no-op. It must preserve output shape or fail with a bounded infrastructure error; no raw result is returned after the port boundary.

- [ ] **Step 1: Write failing sanitizer tests.** Cover each built-in result, private-key/assignment/bearer/query redaction, sensitive-file search and diff, metadata preservation, schema-preserving redaction, idempotency, and sanitizer throw behavior.
- [ ] **Step 2: Run `pnpm vitest run packages/security/test/result-sanitizer.test.ts` and verify RED.** Expected missing port/implementation.
- [ ] **Step 3: Implement Security sanitizer.** Route by tool name only inside Security implementation, use facts/classifier for path sensitivity, and keep output bounded with existing Tool output policy.
- [ ] **Step 4: Run focused sanitizer/security tests and typecheck.** Expected PASS; architecture tests must reject a production no-op sanitizer.
- [ ] **Step 5: Commit.** `git add packages/tools packages/security && git commit -m "feat(tools): sanitize tool results before persistence"`.

### Task 11: Dispatcher sanitize-before-persist and uncertainty semantics

**Files:**
- Modify: `packages/tools/src/dispatcher.ts`, `packages/tools/src/dispatcher-types.ts`, `packages/tools/src/dispatcher-ports.ts`, `packages/tools/src/result-validation.ts`, `packages/tools/src/registry.ts`, `packages/tools/src/registry-builder.ts`.
- Test: `packages/tools/test/dispatcher-execution.test.ts`, `dispatcher-failure.test.ts`, `dispatcher-recovery.test.ts`, `packages/security/test/dispatcher-integration.test.ts`.

**Interfaces:**
- `ToolDispatcherOptions.resultSanitizer` is required for production composition. Existing test-only helpers may use an explicit pass-through sanitizer; no `INSECURE_NOOP_SANITIZER` may appear in production source.
- Execution pipeline becomes handler → raw result in memory → raw schema/size validation → sanitizer → sanitized schema/size revalidation → effect projection → sanitized observation/events → commit. The effect projector receives only the sanitized result.
- If sanitizer/revalidation fails after handler execution, do not invoke handler again; keep durable invocation RUNNING by not committing terminal data, and let recovery produce `UNCERTAIN_SIDE_EFFECT` exactly as existing Phase 8D behavior.

- [ ] **Step 1: Write failing Dispatcher tests.** Assert sanitizer ordering, raw result never reaches observation/effects/commit, sanitized result is revalidated, sanitizer failure leaves RUNNING and no observation/event, recovery does not rerun handler, and existing test helpers explicitly inject pass-through behavior.
- [ ] **Step 2: Run focused tests and verify RED.** Expected missing required option/order behavior.
- [ ] **Step 3: Implement required sanitizer injection and two-stage validation.** Preserve existing failure persistence for raw schema errors; map sanitizer infrastructure errors without terminal settlement.
- [ ] **Step 4: Update all test factories and integration composition.** Security-backed production composition uses `new SecurityToolResultSanitizer()`; unit tests use a named local helper only where required.
- [ ] **Step 5: Run all Tools/Security tests and typecheck.** Expected PASS.
- [ ] **Step 6: Commit.** `git add packages/tools packages/security && git commit -m "feat(tools): enforce sanitize-before-persist"`.

### Task 12: 9B-safe Approval action integration and event privacy

**Files:**
- Modify: `packages/tools/src/dispatcher.ts`, `packages/tools/src/event-factory.ts`, `packages/tools/src/tool-effects.ts`, `packages/security/src/tool-gate.ts`, `packages/protocol` only if an additive schema-compatible field is proven necessary.
- Test: `packages/tools/test/dispatcher-approval.test.ts`, `packages/tools/test/event-factory.test.ts`, `packages/tools/test/tool-effects.test.ts`, `packages/security/test/approval-preview.test.ts`, `tests/architecture/security-boundaries.test.ts`.

**Interfaces:**
- New ApprovalRequest `action` uses the Gate-provided redacted safe action and stable classifications/reason, never raw args, command secrets, stdin, patch body, full file content, or absolute host paths. Existing old 9B actions remain loadable/resolvable/recoverable.
- Tool/approval events remain structural-safe: no raw args/command/stdin/patch body; shell/process effects keep the existing safe label `shell command`; file effects contain summaries/paths only.
- `approval.requested` serializes the same safe ApprovalRequest persisted by the ToolExecutionStore; `approval.resolved`, ToolObservation, and LLM-facing result projections contain no detected secrets.

- [ ] **Step 1: Write failing privacy tests.** Use `SECRET_APPROVAL_9C_TOKEN` in command/stdin/patch/search pattern and assert zero occurrences in ApprovalRequest, approval events, Tool events, effects, observations, and model-facing result; assert raw private invocation args remain intact.
- [ ] **Step 2: Run focused tests and verify RED.** Expected raw/coarse action mismatch or missing safe action.
- [ ] **Step 3: Implement action propagation and event privacy assertions.** Do not change the approval key or event schema unless a strict additive field is required; do not copy raw args into events.
- [ ] **Step 4: Run Phase 9B approval/recovery tests.** Include pending/approved/rejected/expired/cancelled, ONCE/RUN, restart recovery, exact grant reuse, and gate-before-grant regressions.
- [ ] **Step 5: Commit.** `git add packages/tools packages/security packages/protocol tests/architecture && git commit -m "test(core): preserve approval and event privacy"`.

### Task 13: Secret sentinel end-to-end coverage

**Files:**
- Create: `packages/security/test/secret-sentinel-e2e.test.ts` or extend the existing storage/tool integration fixture without introducing a duplicate persistence model.
- Modify: `packages/storage/test/read-only-filesystem-tools-integration.test.ts`, relevant Tool/Storage integration factories, and model continuation test fixtures only as needed.

**Interfaces:**
- Covers `.env` approval then read, search across normal and sensitive files, Git diff with sensitive and source changes, exec output, stdin output, storage reopen, durable events, ToolObservation, continuation/next-turn model messages, and public error surfaces.

- [ ] **Step 1: Write the sentinel tests first.** Use fake fixture values for `CAELUSH_SECRET_9C_ENV`, `_COMMAND`, `_OUTPUT`, `_PATCH`, `_STDIN`, and provider-shaped fake credentials; exclude private `ToolInvocation.args` from the zero-leak scan intentionally.
- [ ] **Step 2: Run the sentinel suite and verify RED.** Expected failures identify every unsanitized projection.
- [ ] **Step 3: Fix only the minimal missing public/model/event boundaries.** Never replace private raw args used for exact execution/recovery/key identity.
- [ ] **Step 4: Re-run sentinel and relevant Phase 8/9B integration tests.** Expected zero sentinel occurrences in all public/model/event surfaces.
- [ ] **Step 5: Commit.** `git add packages/security packages/tools packages/storage && git commit -m "test(security): cover input policy and redaction"`.

### Task 14: Architecture audits and documentation

**Files:**
- Create: `docs/architecture/input-security-policy.md`, `docs/architecture/secret-redaction.md`.
- Modify: `docs/architecture/security.md`, `docs/architecture/approval-workflow.md`, `docs/architecture/tool-system.md`, `README.md`, `AGENTS.md`, `tests/architecture/security-boundaries.test.ts`, `tests/architecture/package-boundaries.test.ts`.

**Interfaces:**
- Documentation records Tool Security Facts, sensitive path matrix, parser/platform/wrapper limits, command classifications/matrix, monotonic overlay, NEVER_ASK, SYSTEM_DESTRUCTIVE, gate-before-grant, SecretDetector/Redactor, JSON/scan bounds/placeholders, sanitizer pipeline, event/approval/model privacy, private args boundary, uncertainty semantics, no at-rest encryption claim, and Phase 9D boundary.
- Architecture tests enforce `security → protocol/tools port/types` only; no Security→Runtime/Core/Storage/Events/LLM, no Runtime→Security, no Tools→Security, no Dispatcher command/path/secret rules, no evaluator I/O, no analyzer process execution, and no production no-op sanitizer.
- README marks 9A/9B/9C complete and Phase 9 in progress, describing only input-aware policy and high-confidence redaction without claiming complete DLP, encryption, sandboxing, or production-complete security.

- [ ] **Step 1: Write failing architecture/documentation assertions.** Assert the required dependency and source-string boundaries plus README/status/document headings.
- [ ] **Step 2: Run `pnpm vitest run tests/architecture packages/security/test/public-api.test.ts packages/tools/test/public-api.test.ts` and verify RED where new exports/docs are absent.
- [ ] **Step 3: Add docs and tighten architecture tests.** Include the raw-private-data → Security Boundary → safe projections flow and explicitly state Phase 9D is not implemented.
- [ ] **Step 4: Run architecture/public API tests and lint.** Expected PASS.
- [ ] **Step 5: Commit.** `git add docs README.md AGENTS.md tests/architecture && git commit -m "docs: document phase 9c security boundaries"`.

### Task 15: Full focused matrix and clean-build verification

**Files:**
- Modify only tests/implementation files identified by failing focused tests; do not run broad format rewrites.

- [ ] **Step 1: Run the complete focused matrix serially.** Run tests for sensitive paths, `.env` exceptions, resource policy, facts/projectors, patch inspection, tokenizer/platform/wrappers/depth/classifications, monotonic decisions, NEVER_ASK, base 9A and RUN grant precedence, detector/redactor/JSON/idempotency/limits, previews, sanitizer ordering/failure, all read/search/diff/shell/stdin outputs, sentinel events/model, Phase 9B recovery, Phase 8 Runtime, architecture, and public APIs.
- [ ] **Step 2: Fix any failure with TDD.** For parser discrepancy, Windows/POSIX divergence, redaction false-negative, schema regression, or recovery failure, invoke `superpowers:systematic-debugging`, add a reproducing failing test, then implement the minimal fix.
- [ ] **Step 3: Remove generated artifacts safely.** Delete only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` with explicit Node filesystem operations or equivalent validated paths; never use `git clean`.
- [ ] **Step 4: Reinstall and run clean serial verification.** Execute `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` in that order; expected all PASS.
- [ ] **Step 5: Run format/check gates.** Execute `pnpm format:check` and `pnpm check`, record existing format debt versus `548` baseline, then run `git diff --check`; changed files must have zero warnings.
- [ ] **Step 6: Commit any final test-only corrections.** Use a focused message such as `test(security): close phase 9c coverage gaps` and verify `git diff --stat`.

### Task 16: Final audit, commit history, push, and SHA gate

**Files:**
- Read: all changed files, `git diff`, `git status --short`, commit history, remote branch ref.
- Modify: none after final verification except a targeted correction that repeats the affected TDD and verification gates.

- [ ] **Step 1: Audit requirements line by line.** Confirm facts are host-only/pure, projectors cover every built-in, no duplicate patch grammar, sensitive matrix and command matrix are covered, monotonicity/gate-before-grant/9B recovery remain intact, sanitizer is required in production, raw results never persist, and no forbidden Phase 9D work exists.
- [ ] **Step 2: Run fresh verification before completion claims.** Use `superpowers:verification-before-completion`; run final `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check` serially and inspect full exit codes/counts.
- [ ] **Step 3: Verify changed-file formatting.** Run `pnpm prettier --check <changed files>` or the repository-equivalent targeted command; report zero warnings for changed files and total warnings no greater than `548`.
- [ ] **Step 4: Verify working tree and commit list.** `git status --short` must be empty after committing; report coherent commits including facts, resource policy, command policy, redaction, sanitizer, tests/docs.
- [ ] **Step 5: Push the actual branch.** Run `git push -u origin codex/phase-9c-sensitive-command-secret-policy`; do not force push.
- [ ] **Step 6: Verify remote SHA.** Set `LOCAL_SHA=$(git rev-parse HEAD)` and read `REMOTE_SHA` using `git ls-remote --heads origin refs/heads/codex/phase-9c-sensitive-command-secret-policy`; require exact equality before reporting completion.
- [ ] **Step 7: Produce the Phase 9C Completion Report and stop.** Include the requested 63 report sections, exact baseline/verification results, commits/local/remote SHA/working tree, current capability in plain language, private durable argument boundary, no at-rest encryption claim, and explicit Phase 9D handoff without implementing 9D.

## TDD and Verification Matrix

Every production function above follows RED → focused test failure → minimal implementation → focused PASS → refactor while green. The required focused coverage is: SensitivePathClassifier; `.env` exception matrix; sensitive read/mutation policy; all Tool Security Facts projectors; pure patch inspection; POSIX/PowerShell/CMD tokenization; wrapper recursion/depth; destructive/system-destructive/network/remote/privilege/opaque classification; monotonic combiner; NEVER_ASK and base-9A regressions; RUN grant DENY precedence; SecretDetector/TextRedactor/JsonRedactor; private keys/Bearer/basic/assignment/query/userinfo/provider patterns; placeholder/idempotency/scan bounds; preview privacy and approval-key independence; ToolResultSanitizer ordering/revalidation/failure uncertainty; read/search/diff/exec/stdin redaction; event/observation/model sentinel scans; Phase 9B approval/recovery and Phase 8 Runtime regression; package-boundary/public API audits; full serial lint/typecheck/plain test/build/format/check/diff verification.

## Delivery Constraints

No new database migration is expected because `ApprovalRequest.action` is already a `JsonObject`. Do not claim SQLite is encrypted or that secrets never exist in SQLite. Do not expose command/patch/stdin security facts to the model or events. Do not turn input classification into a safe-command allowlist. Do not implement OS hard sandboxing, cancellation, timeout, retry, budget, Verification, CLI, Web UI, or Phase 9D.
