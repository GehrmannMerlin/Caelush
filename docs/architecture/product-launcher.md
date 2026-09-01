# Product Launcher

Phase 12E adds the production `caelush` command as a small host process around the existing CLI and daemon. It owns product startup and distribution concerns; it does not own Agent execution semantics.

## Process model

```text
caelush (Product Launcher / CLI host)
        │ HTTP + durable SSE
        ▼
Caelush Local Agent Service (daemon)
        │
        └── Core → Tools → Runtime / LLM / Storage / Verification
```

The launcher and daemon are separate OS processes. The launcher may resolve and spawn the daemon entrypoint, but it never imports `@caelush/core`, constructs an `AgentLoop`, executes a Tool, opens Storage, or performs Provider work. The interactive CLI remains a thin HTTP/SSE client, and print mode uses the same client boundary without instantiating Ink.

## Responsibilities

The launcher is responsible for:

- static `--help` and `--version` responses;
- Node/platform preflight;
- default local daemon discovery, compatibility checks, startup lease coordination, and detached spawn;
- honoring externally managed `CAELUSH_DAEMON_URL` without local lifecycle ownership;
- dispatching interactive CLI or non-interactive print mode;
- stable product exit codes.

The direct launcher dependencies are `@caelush/cli`, `@caelush/client`, `@caelush/daemon` (entry/path/diagnostic subpaths only), and `@caelush/protocol`. Core/runtime/storage/tool/security/verification/provider implementation remains daemon-owned.

## Version ownership

The product version is read from launcher package metadata. The daemon exposes its own package-derived version through `/api/v1/info`; default local startup requires exact equality with the launcher product version. The release manifest uses the launcher version and the repository, launcher, and daemon version test keeps these values aligned. External daemons remain externally managed: a version difference is reported as a warning after API/protocol compatibility succeeds and never triggers replacement or restart.

## Startup flow

1. Handle static commands without contacting a daemon.
2. Parse the command and apply the interactive TTY gate when required.
3. Probe health, then info, and validate API/protocol compatibility.
4. In external mode, return the compatible client and never create a lock, log, child process, or local lifecycle file.
5. In default local mode, reuse a healthy exact-version daemon.
6. Otherwise coordinate startup with the atomic lease, spawn the exported daemon entrypoint using the current `process.execPath`, and poll health/info until the bounded deadline.
7. Release the lease after convergence and hand the client to the thin CLI or print host.

The daemon is detached from the launcher. Closing the CLI or using `Ctrl+D` only detaches the local host; it does not stop the daemon or erase its durable Session/Run state.
