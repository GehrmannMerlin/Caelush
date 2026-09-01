# Caelush Phase 12E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 12E as a production-shaped `caelush` command with a separate daemon process, safe default-daemon discovery/auto-start, non-interactive print hosting, doctor diagnostics, portable Node 24 packaging, installers, platform smoke coverage, and artifact-only CLI E2E without changing Core execution semantics.

**Architecture:** Add a host-only `apps/launcher` that dispatches commands, performs preflight, coordinates the daemon over the existing client contract, and selects the existing interactive CLI or a new print host. Export only daemon entry/path and diagnostics seams needed by the launcher. Centralize product paths in the daemon host layer. Build a platform-native portable bundle with pnpm deploy; retain migrations and node-pty in the artifact. Verify source and copied-artifact behavior with real subprocesses and a fake HTTP provider.

**Tech Stack:** TypeScript/ESM, Node.js 24, pnpm 11.21.0, existing `@caelush/client` HTTP/SSE transport, Ink only for TTY interactive mode, Vitest, Fastify daemon, SQLite/Drizzle migrations, node-pty, POSIX shell, PowerShell, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-caelush-phase-12e-production-hardening-packaging-design.md` and the approved Phase 12E user brief.

## Global Constraints

- Work only in `.worktrees/phase-12e-production-hardening-packaging-cli-e2e` on `codex/phase-12e-production-hardening-packaging-cli-e2e`, based on the verified Phase 12D line.
- Phase 12E is the final Phase 12 round. Do not create 12E-1, 12F, Phase 13 code, or unrelated feature work.
- Preserve `apps -> packages`, public `src/index.ts` entry points, provider-independent Core contracts, and the CLI/daemon process boundary.
- The launcher may spawn the daemon with `process.execPath`, but must never import `startDaemon`, Core, Storage, Runtime, Security, Tools, Verification, or LLM implementation code.
- `CAELUSH_DAEMON_URL` means external ownership: connect only, with no local spawn, lock, log, or lifecycle management.
- The default local daemon must be reused when healthy and exactly compatible; never kill an unknown port owner.
- Use atomic `mkdir` startup leases, bounded deadlines, detached child stdio, `unref`, and sanitized bounded logs.
- Node 24.x is required. Do not use SEA, pkg, nexe, Bun compile, or a custom embedded runtime.
- The portable artifact must run outside the source checkout without pnpm, workspace symlinks, `NODE_PATH`, or repository-relative assets. Include migrations and target-platform node-pty.
- Tests for behavior follow RED -> observed failure -> minimal GREEN -> refactor. Do not write production behavior first.
- Never run `git reset --hard`, `git clean -fd`, force push, or automatic merge/PR operations. Use `apply_patch` for source edits.
- Do not run `prettier --write .`; format only changed files. Preserve the measured 796-warning repository baseline at most.

---

## Task 1: Record release-surface characterization and add version/path contracts

**Files:** `docs/characterization/2026-09-01-phase-12e-release-surface.md`, `apps/daemon/src/product-paths.ts`, `apps/daemon/src/version.ts`, `apps/daemon/src/entry.ts`, `apps/daemon/src/index.ts`, `apps/daemon/package.json`, `apps/daemon/test/product-paths.test.ts`, `apps/daemon/test/version.test.ts`.

- [ ] Record the audited package scripts, ESM/import.meta.url assets, node-pty, Drizzle migrations, Ink/React, Git/rg executable dependencies, default URL, database location, and current entrypoints.
- [ ] Write failing tests for deterministic product paths, `CAELUSH_HOME` test override, daemon entry resolution, and authoritative daemon version.
- [ ] Implement host-only path/version/entry helpers and public subpath exports without adding user-directory dependencies to Core.
- [ ] Run the focused daemon tests and format only changed files.

## Task 2: Make daemon runtime metadata and migration assets deployable

**Files:** `apps/daemon/src/main.ts`, `apps/daemon/src/daemon-composition.ts`, `apps/daemon/src/diagnostics.ts`, `packages/storage/src/migrate.ts`, `packages/storage/src/index.ts`, `packages/storage/package.json`, `apps/daemon/package.json`, tests under `apps/daemon/test` and `packages/storage/test`.

- [ ] Add failing tests proving daemon info uses the authoritative version and that the migration directory is discoverable from compiled package layout.
- [ ] Implement safe daemon main startup using centralized paths and sanitized bounded fatal diagnostics; expose read-only migration/node-pty diagnostics through daemon public exports.
- [ ] Add explicit package `files` entries for `dist` and `drizzle`; keep migration resolution based on package asset location rather than current working directory.
- [ ] Verify existing daemon/storage tests and typecheck.

## Task 3: Add launcher package and platform preflight

**Files:** `apps/launcher/package.json`, `apps/launcher/tsconfig.json`, `apps/launcher/src/index.ts`, `apps/launcher/src/main.ts`, `apps/launcher/src/version.ts`, `apps/launcher/src/platform.ts`, `apps/launcher/src/exit-codes.ts`, `apps/launcher/src/help.ts`, launcher architecture/unit tests.

- [ ] Add failing tests for Node 24 range checks, supported platform matrix, stable exit-code values, help/version no-daemon behavior, and launcher forbidden-import boundaries.
- [ ] Implement the package metadata, authoritative product version, preflight, help/version text, and command entry without importing Ink/rendering interactive UI for static commands.
- [ ] Add POSIX and Windows launcher shims and preserve strict ESM/public package exports.
- [ ] Run focused launcher tests, lint, and typecheck.

## Task 4: Extend argument grammar without regressing Phase 12D

**Files:** `apps/cli/src/bootstrap/cli-args.ts`, `apps/cli/src/index.ts`, `apps/launcher/src/command.ts`, `apps/cli/test/cli-args.test.ts`, new launcher parser tests.

- [ ] Add failing tests for `--help`, `--version`, `doctor`, `-p/--print`, output formats, prompt/stdin selection, `-c -p`, exact resume print, picker rejection, duplicates, malformed IDs, and unknown/multiple flags while retaining existing deep-equality behavior for legacy intents.
- [ ] Implement a data-only command parser/translation layer. Keep existing CLI interactive intent objects compatible for callers and ensure output format is print-only.
- [ ] Verify all parser tests and architecture guards.

## Task 5: Implement daemon discovery, compatibility, startup lease, and detached spawn

**Files:** `apps/launcher/src/daemon-discovery.ts`, `apps/launcher/src/startup-lease.ts`, `apps/launcher/src/logs.ts`, launcher tests.

- [ ] Add failing tests for external URL no-spawn/no-lock/no-log, default health-then-info reuse, exact local version gate, external version warning, incompatible port fail-safe, atomic lease races, TTL cleanup condition, bounded polling, child-before-health failure, EADDRINUSE convergence, detached spawn/unref, and secret-safe log rotation.
- [ ] Implement injected host ports for clock/timer/filesystem/process/client seams so race behavior is deterministic and no test needs to kill an unknown process.
- [ ] Spawn `process.execPath` against the daemon public entry path with detached non-terminal stdio, inherited provider/default configuration only, and bounded safe diagnostics.
- [ ] Run focused tests, including concurrent launcher subprocess tests where feasible.

## Task 6: Add TTY gate and harden interactive dispatch

**Files:** `apps/launcher/src/main.ts`, `apps/cli/src/main.tsx`, `apps/cli/src/components/App.tsx`, `apps/cli/src/application/cli-controller.ts`, tests under `apps/cli/test` and `apps/launcher/test`.

- [ ] Add failing tests proving non-TTY interactive invocation emits the exact clean guidance before Ink/raw-mode use, while TTY, `TERM=dumb`, `NO_COLOR`, and narrow terminal paths remain safe.
- [ ] Implement launcher-side TTY gating before interactive rendering and retain the existing CLI as a thin daemon client host.
- [ ] Ensure daemon bootstrap occurs only for interactive/print execution and static/doctor commands never start one.
- [ ] Re-run Phase 12D interactive, detach, resume, cancellation, and reconnect tests.

## Task 7: Implement the separate print host and stdin/output contracts

**Files:** `apps/cli/src/application/print-host.ts`, `apps/cli/src/application/cli-controller.ts`, `apps/cli/src/application/exit-codes.ts` or shared public contract files, CLI/launcher tests.

- [ ] Add failing tests for strict UTF-8 bounded stdin, empty stdin, argument-plus-stdin ambiguity, prompt limit reuse, text/json/stream-json stdout isolation, USER_VISIBLE filtering, approval result shape, and stable exit codes.
- [ ] Implement print mode over `@caelush/client`/SSE without Ink. Reuse controller lifecycle and cancellation semantics; expose only public-safe final/result data.
- [ ] Add Ctrl+C handling that calls the existing cancellation endpoint/path, waits boundedly, maps confirmed cancellation to 130, and preserves completion-race success.
- [ ] Ensure print approval never auto-approves, remains durable/resumable, reports exit 5, and does not leak hidden reasoning, raw tool arguments, provider payloads, or secrets.
- [ ] Run CLI regression and focused print tests.

## Task 8: Implement doctor diagnostics

**Files:** `apps/launcher/src/doctor.ts`, launcher tests, daemon diagnostics exports as needed.

- [ ] Add failing tests for every required check, critical-versus-warning exit semantics, no auto-start, and provider secret omission.
- [ ] Implement bounded read-only checks for version, Node/platform/arch, TTY/workspace, daemon URL/reachability/compatibility, DB parent, Git, rg, node-pty, migrations, and public provider configuration presence.
- [ ] Verify doctor works with no daemon, a compatible daemon, an incompatible daemon, and a secret sentinel in the environment.

## Task 9: Add release deploy, manifest/checksums, and portable launchers

**Files:** `scripts/build-release.mjs`, `scripts/install.sh`, `scripts/install.ps1`, `.gitignore`, root `package.json`, package `files` metadata, release-script tests.

- [ ] Add failing tests for `--legacy` deploy invocation, no unresolved workspace dependency/symlink, manifest fields, SHA-256 checksums, migration inclusion, native dependency presence, safe artifact paths, and installer idempotency/layout rules.
- [ ] Implement release staging outside the repo using `pnpm --filter @caelush/launcher --prod deploy <dir> --legacy`; fail if workspace links or source paths remain; write platform/version/checksum metadata.
- [ ] Implement artifact-relative POSIX and Windows shims and user-scope installers that accept an already-downloaded artifact path and never download or modify system configuration.
- [ ] Add release scripts to the root only as required; do not claim signing or standalone executable status.

## Task 10: Add source and artifact-only E2E harnesses

**Files:** `tests/phase-12e/**`, `scripts/test-release.mjs`, fake provider helpers, workspace/test fixtures, package scripts.

- [ ] Add failing harness tests that launch real subprocesses with temporary HOME/product paths and a fake HTTP provider configured through `CAELUSH_PROVIDER_BASE_URL`.
- [ ] Implement source E2E coverage for single-command auto-start, reuse, parallel startup, session continuation, read/apply_patch, approval, cancellation, detach/resume, reconnect, migrations, node-pty, non-TTY, print pipe, JSON/JSONL, incompatible port, external URL no-spawn, and secret sentinel absence.
- [ ] Copy the deployed bundle outside the repository and run artifact-only equivalents without `NODE_PATH`, pnpm, workspace links, provider override objects, or source paths.
- [ ] Keep artifact tests bounded and platform-aware; report unsupported/unverified matrix entries honestly.

## Task 11: Add CI matrix, architecture guards, and documentation

**Files:** `.github/workflows/release-smoke.yml`, architecture guard tests, `docs/architecture/product-launcher.md`, `docs/architecture/daemon-auto-start.md`, `docs/architecture/cli-noninteractive.md`, `docs/architecture/cli-distribution.md`, `README.md`, `AGENTS.md`.

- [ ] Add failing checks for launcher dependency/import boundaries, stdout secret safety, no same-process daemon execution, and no Phase 13 leakage.
- [ ] Implement the native release-smoke matrix for `windows-latest`, `ubuntu-latest`, `macos-14`, and `macos-15-intel`, using the actual package manager/version and artifact-only smoke commands.
- [ ] Document launcher ownership, daemon races/leases/logs, CLI print contracts, Node 24 distribution, migrations, node-pty, checksums, supported matrix, and deferred updater/signing/publishing features.
- [ ] Update AGENTS durable rules with the approved Phase 12E boundary and README status/install/quickstart/non-interactive usage.

## Task 12: Full verification and delivery evidence

**Files:** changed files only plus final report in the assistant response.

- [ ] Format each changed file individually; confirm changed-file warnings are zero and global warnings are no greater than the 796 baseline.
- [ ] Run `pnpm lint`, `pnpm typecheck`, plain `pnpm test`, `pnpm build`, clean generated outputs using safe Node fs operations only, then repeat the full verification sequence.
- [ ] Build the production artifact and run focused tests from a temporary directory outside the repository. Confirm migrations, node-pty load/PTY smoke, help/version/doctor, daemon lifecycle, print outputs, and secret audits use the artifact itself.
- [ ] Run `pnpm check`, record whether its only failure is the verified historical Prettier debt, and run `git diff --check` and `git status --short`.
- [ ] Create coherent commits if useful. Attempt normal push only if remote connectivity is available; never force push or merge automatically. If push is unavailable, report the exact blocker and local SHA honestly.
- [ ] Final response must be titled `Caelush Phase 12E Completion Report`, state Phase 12E/Phase 12 status only if all required evidence supports it, enumerate unsupported platforms and verification limitations, and stop with `Phase 13 — Production Web` without implementing Phase 13.
