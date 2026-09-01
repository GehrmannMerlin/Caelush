# Caelush V1 Phase 12E — Production Hardening, Product Launcher, Packaging & Final CLI E2E

**Status:** Approved implementation design

**Date:** 2026-09-01

**Scope:** Phase 12E only. This design completes Phase 12 and does not start Phase 13.

## Goal

Turn the existing Phase 12D development workflow into a product-shaped CLI without changing Agent execution semantics. A user should be able to run `caelush`, have a compatible local daemon reused or safely started in a separate process, use interactive or non-interactive output, and install a platform-built artifact outside the source checkout.

The implementation preserves the established boundaries:

```text
Product Launcher -> HTTP/SSE client -> daemon -> shared Core/Runtime
```

The launcher owns host concerns only. It never imports or executes the Agent Kernel, and the CLI remains a thin interactive/client host.

## Delivery baseline and repository facts

- Phase 12D delivery SHA: `02c83cd65ec1c2353df41661458290977a5e88b9`.
- The local fetch was attempted with `git fetch origin --prune`; the configured remote returned a Schannel TLS handshake failure. Existing local remote-tracking refs were used only after verifying that the 12D SHA exists locally and that `origin/codex/phase-12d-interactive-control-session-recovery` points to the required line of history.
- `git merge-base --is-ancestor 02c83cd65ec1c2353df41661458290977a5e88b9 origin/master` is false, so `BASE_REF` is `origin/codex/phase-12d-interactive-control-session-recovery`.
- Worktree: `.worktrees/phase-12e-production-hardening-packaging-cli-e2e`.
- Branch: `codex/phase-12e-production-hardening-packaging-cli-e2e`.
- Fresh baseline in that worktree: install, lint, typecheck, tests, and build pass; tests report 295 files, 1093 passed, and 5 skipped. The existing repository-wide Prettier baseline is 796 warnings and causes the final format step of `pnpm check` to fail; Phase 12E changes must not increase it and changed files must be warning-free.
- Root and application packages are currently private. The root product version is `0.1.0`, Node is constrained to `>=24.0.0 <25.0.0`, the current CLI and daemon entrypoints are `node dist/index.js` and `node dist/main.js`, and the default daemon endpoint is `http://127.0.0.1:43120`.
- The daemon currently defaults its database to `~/.caelush/caelush.db`. Product path ownership will be centralized without making Core depend on a user directory.

## Research findings absorbed

The current official product patterns support the following choices:

- OpenAI Codex presents one product command with an explicit non-interactive execution mode, machine-readable JSONL events, diagnostics, and version/update commands. Caelush absorbs the single command, separate interactive/print hosts, clean stdout, structured output, and doctor-style diagnostics. It does not absorb Codex authentication, sandboxing, app-server RPC, cloud features, or Rust-binary architecture. Sources: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and [developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
- Claude Code documents a single command, platform-specific installation, `doctor`, `--version`, print/non-interactive usage, stdin behavior, and native dependency troubleshooting. Caelush absorbs the product ergonomics and diagnostic emphasis, but does not add auto-update channels, package-manager publishing, signing, remote control, or Claude-specific features. Sources: [installation](https://code.claude.com/docs/en/installation), [CLI usage](https://code.claude.com/docs/en/cli-usage), and [troubleshooting](https://code.claude.com/docs/en/troubleshooting).
- pnpm 11 `deploy` copies a package and its dependencies into an isolated production directory. Because this repository does not enable `inject-workspace-packages`, the release script must use `--legacy`; the artifact tests must prove that no workspace symlink, pnpm store, or checkout path is required at runtime. Source: [pnpm deploy](https://pnpm.io/cli/deploy).
- The tested GitHub Actions matrix uses actual hosted-runner labels: `windows-latest`, `ubuntu-latest`, `macos-14` for macOS arm64, and `macos-15-intel` for macOS x64. Platform-native artifacts are built and smoke-tested on their target platform; native dependencies are never copied across platforms. Source: [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Frozen distribution decision

The V1 production distribution is a Node.js 24 portable production bundle:

- one platform-specific installation directory;
- self-contained production dependencies from pnpm deploy;
- a `caelush` POSIX launcher and a Windows command shim;
- no pnpm, workspace symlink, repository checkout, or source path at runtime;
- Drizzle migration files included as runtime assets;
- node-pty installed and loaded from a target-platform build;
- a bounded manifest and SHA-256 checksum files.

This round explicitly does not use Node SEA, `pkg`, `nexe`, Bun compile, or a custom embedded Node runtime. node-pty is a native addon and migrations are filesystem assets; forcing them into a single-file executable would introduce native extraction, ABI, asset resolution, and loader concerns that are not required to deliver a reliable V1.

The supported and tested target matrix is Windows x64, Linux x64, macOS arm64, and macOS x64. Linux arm64 and Windows arm64 remain unsupported/unverified unless a native runner, node-pty load, and artifact smoke evidence are available.

## Product Launcher architecture

Add `apps/launcher` with only these direct Caelush dependencies:

```text
@caelush/cli
@caelush/client
@caelush/protocol
@caelush/daemon
```

The launcher contains argument dispatch, Node/platform preflight, product paths, daemon discovery and startup coordination, version compatibility, TTY selection, print host selection, doctor, and the release entrypoint. It must not directly depend on Core, Storage, Runtime, Security, Tools, Verification, or LLM. Launcher tests include import-graph guards.

The daemon exposes a small public entry-path export (for example `@caelush/daemon/entry`) that resolves the compiled `dist/main.js` path. The launcher uses that path only as a child-process target and invokes it with `process.execPath`. It never imports `startDaemon`. The daemon remains a distinct OS process with detached stdio and `child.unref()` so CLI exit cannot stop it.

Product version is authoritative from the launcher package/runtime metadata and is reused by daemon info and release manifests. The invariant is:

```text
launcher product version == DaemonInfo.daemonVersion == manifest.version
```

Protocol version remains unchanged unless a current contract requires it.

## Daemon ownership and startup flow

`CAELUSH_DAEMON_URL` is explicit external-daemon mode. The launcher connects only, does not create a startup lock or daemon log, does not spawn, and does not manage that daemon's lifecycle. API and protocol compatibility are required; a version mismatch is a warning only.

Without that variable, the launcher uses the default local URL. It probes `/health` first and `/info` second. A healthy compatible daemon is reused. The local daemon version must exactly equal the launcher product version. API, protocol, or local product-version mismatch fails closed with a bounded actionable diagnostic; the launcher never kills an unknown process.

If no compatible local daemon is reachable, startup uses an atomic directory lease at `~/.caelush/run/daemon-start.lock/` (under the centralized product paths). Acquisition is `mkdir`, not an existence check followed by a write. Metadata may contain only an owner token, PID, creation time, and version. The lease is coordination, not singleton authority; the TCP bind remains authoritative.

Launchers that lose the lease poll health/info. An expired lease may be removed only after confirming both that its bounded TTL has elapsed and that no compatible daemon is reachable. The startup deadline is bounded at approximately ten seconds with fixed polling. A child that exits before health is available fails with the product startup diagnostic. An `EADDRINUSE` race is re-probed and converges on a healthy compatible daemon; an incompatible or unknown port owner is reported safely without process termination.

Daemon logs are redirected away from the terminal to `~/.caelush/logs/daemon.log`. Rotation keeps the current file and one `.1` backup, with a five MiB limit. Startup diagnostics and logs are sanitized and bounded. Provider configuration may be inherited by the detached child, but environment dumps, API keys, authorization headers, raw prompts, and provider payloads must never enter lock metadata, logs, doctor output, errors, or manifests.

Centralized `ProductPaths` covers the database, run directory, startup lease, log directory, and daemon log. Tests may override the product home through an explicit host-only environment/test seam; Core receives only its existing injected ports and never resolves `homedir()`.

## CLI grammar and hosts

The existing interactive grammar (`--continue`/`-c`, `--resume`/`-r`, exact session IDs, and the resume picker) remains compatible. The launcher adds:

```text
caelush --help | -h
caelush --version | -V
caelush doctor
caelush --print | -p [PROMPT]
caelush --print PROMPT --output-format text|json|stream-json
```

Unknown flags, duplicate flags, multiple prompts, malformed IDs, `--output-format` without print, and a print resume picker are usage errors. `-c -p` and `-r SESSION_ID -p` are valid. `--help`, `--version`, and `doctor` never start a daemon; interactive and print commands do.

Interactive mode checks `stdin.isTTY` and `stdout.isTTY` before Ink is imported/rendered or raw input is requested. When the check fails it prints:

```text
Interactive Caelush requires a terminal.
Use `caelush --print "..."` for non-interactive execution.
```

The terminal check remains safe for `TERM=dumb`, `NO_COLOR`, and narrow terminals; semantic status markers remain readable. Print mode never instantiates Ink.

The print host still uses client HTTP/SSE and the existing daemon/Core lifecycle. It accepts a prompt argument or strict UTF-8 stdin, reuses `MAX_CLI_PROMPT_BYTES = 32 * 1024`, treats empty stdin as no prompt, and rejects a prompt argument plus non-empty stdin with:

```text
Provide the prompt either as an argument or through stdin, not both.
```

Text reserves stdout for the verified final text; diagnostics are stderr. JSON emits exactly one public-safe result object. stream-json emits newline-delimited public `USER_VISIBLE` events followed by one canonical result/control record. Hidden reasoning, model answer text before verification, tool arguments, provider payloads, credentials, and internal IDs not covered by the public result contract are excluded.

Print approval is fail-safe: no approval dialog and no auto-approval. `WAITING_APPROVAL` remains durable and resumable interactively; text explains how to resume on stderr, JSON sets `requiresApproval`, stream-json includes the real public approval event and a result control record, and the process exits with code 5. Ctrl+C calls the existing cancellation path, waits for bounded confirmed cleanup, returns 130 only for confirmed user cancellation, and returns 0 if completion wins the race.

Stable host exit codes are centralized: 0 verified completion, 1 doctor critical failure, 2 usage, 3 bootstrap/daemon/compatibility, 4 terminal non-success, 5 approval required, 6 transport recovery/unconfirmed cleanup, and 130 confirmed user cancellation.

## Doctor

`caelush doctor` is read-only and does not auto-start. It reports bounded check rows for product version, Node range, platform, architecture, TTY state, workspace, daemon URL/reachability/API/protocol/version, database parent, Git, ripgrep, node-pty loadability, migration assets, and provider configuration presence. Provider diagnostics are restricted to public provider ID/default model fields and configured yes/no; credentials, authorization, base URLs, raw environment, and process dumps are forbidden. Critical failures return 1; warning-only reports return 0.

## Packaging and installation

The release entrypoint performs a clean build, uses `pnpm --filter @caelush/launcher --prod deploy <staging-dir> --legacy`, verifies package files and workspace resolution, includes storage migrations, writes a bounded manifest with product/version/platform/arch/nodeRange/createdAt/protocolVersion, and writes SHA-256 checksum metadata. The artifact layout is suitable for copying outside the repository. Package `files` declarations explicitly include `dist`, launcher shims, and `drizzle` assets where required.

Installers accept an already-downloaded artifact path and never hardcode a future download URL. `install.sh` installs under `~/.local/share/caelush/<version>` with `~/.local/bin/caelush`; it prints PATH guidance without editing shell startup files. `install.ps1` installs under `%LOCALAPPDATA%\\Caelush\\versions\\<version>` with a user-scope command shim under `%LOCALAPPDATA%\\Caelush\\bin`; it is idempotent, does not touch System PATH, and may add a missing user PATH entry without duplication. There is no updater, release channel, package registry publishing, delta update, or signing claim.

## Verification strategy

Unit and architecture tests cover parser contracts, version equality, path ownership, startup lease races, compatibility decisions, stale-lock conditions, bounded startup, detached spawning, log rotation/sanitization, TTY gating, strict stdin, output isolation, approval/cancellation exit behavior, deploy layout, migration resolution, and node-pty loading. Source E2E tests use a temporary product home/workspace, a real fresh SQLite database, and a fake HTTP provider through `CAELUSH_PROVIDER_BASE_URL`.

Artifact-only E2E copies the deployed bundle to a temporary directory outside the repository and runs it without `NODE_PATH`, pnpm, workspace links, source paths, or provider override objects. It covers help/version, single-command startup, daemon reuse, parallel startup, continue/resume, file read and verified patch, approval, cancellation, detach/reconnect, migrations, node-pty/PTY smoke, non-TTY behavior, piped print, JSON/JSONL parsing, incompatible port ownership, custom URL no-spawn behavior, and secret sentinel absence from logs/doctor/manifest. A release-smoke workflow builds and tests the supported matrix on actual native runners.

All changed files are formatted individually. The repository's existing Prettier debt is measured against the fresh 796-warning baseline; `pnpm check` is evaluated honestly and may only retain that historical format failure. Final verification runs lint, typecheck, plain tests, build, clean build/artifact smoke, `git diff --check`, and status inspection without `git clean` or destructive resets.

## Explicit non-goals

Phase 12E does not change Agent execution semantics, introduce a second AgentLoop, move execution into the launcher, add Web UI, Web Search, MCP, Browser, Computer Use, Sub-Agent/Multi-Agent features, background auto-updates, package-manager publishing, release channels, code signing, remote control, hard sandboxing, or a single-file native executable. The next stage, after this round is complete, is only `Phase 13 — Production Web`; it is not implemented here.
