# Local Daemon Auto-start

Phase 12E makes the default `caelush` command self-starting while preserving the daemon as the single local Agent composition root.

## Discovery and compatibility

The default address is `http://127.0.0.1:43120`. The launcher probes `/api/v1/health` first and `/api/v1/info` second. Both responses must report API `v1` and protocol version `1`. A default local daemon is reusable only when `daemonVersion` exactly matches the launcher product version. An incompatible occupant is a bounded bootstrap failure; the launcher does not kill or replace it.

`CAELUSH_DAEMON_URL` selects external mode. In that mode the launcher only connects and validates the endpoint. It never creates the local startup lease, opens the local daemon log, spawns a child, or manages the external daemon's lifecycle. A compatible external version mismatch is a warning, not a local restart decision.

## Startup lease and TCP authority

The lease is an atomic directory creation under the product run directory. Metadata contains only a bounded owner token, PID, creation time, and product version. It has a 15-second TTL and is coordination state, not proof that a daemon owns the TCP port.

The OS bind to `127.0.0.1:43120` is the final singleton authority. Two launchers may both observe an unavailable endpoint, but only one daemon can bind successfully. The losing launcher re-probes and converges on the healthy compatible winner. An occupied port whose owner is not a compatible Caelush daemon is handled as an unknown-port-owner/bootstrap failure; it is never terminated merely because the port is occupied.

Stale lease recovery requires the lease to be expired according to the injected clock and the directory metadata to be removable. It is bounded and retry-safe. Lease cleanup happens after health/info convergence or a startup failure.

## Spawn, detach, and deadline

The launcher starts the exported daemon entry with:

- `process.execPath` from the current Node 24 process;
- `detached: true`;
- daemon stdout/stderr redirected to the product log;
- `child.unref()` so the launcher can exit independently.

Startup has a bounded ten-second deadline with short polling intervals. A child that exits before a compatible health/info response produces a sanitized bootstrap error. The normal daemon remains alive after the launcher exits.

## Logs and paths

Product paths are centralized in the daemon package. By default they live under `~/.caelush`; `CAELUSH_HOME` is an explicit test/installation override. The SQLite database is `caelush.db`, startup coordination is under `run/`, and the daemon log is `logs/daemon.log`. Logs are size-bounded and rotate at 5 MiB with one backup. Provider API keys, authorization values, prompts, tool arguments, and secret-shaped values are not written to startup diagnostics.
