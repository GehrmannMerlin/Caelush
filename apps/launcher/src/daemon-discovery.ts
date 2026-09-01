import { spawn as systemSpawn, type SpawnOptions } from "node:child_process";
import { CaelushClient, type CaelushClientOptions } from "@caelush/client";
import type { DaemonInfo, HealthResponse } from "@caelush/protocol";
import { daemonEntryPath } from "@caelush/daemon/entry";
import { resolveProductPaths, type ProductPaths } from "@caelush/daemon/paths";
import { PRODUCT_VERSION } from "./version.js";
import { closeDaemonLog, openDaemonLog } from "./logs.js";
import {
  isStartupLeaseExpired,
  tryAcquireStartupLease,
  type StartupLease,
} from "./startup-lease.js";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:43120";
export const DAEMON_STARTUP_TIMEOUT_MS = 10_000;
export const DAEMON_STARTUP_POLL_MS = 100;

export interface DaemonProbeClient {
  getHealth(): Promise<HealthResponse>;
  getInfo(): Promise<DaemonInfo>;
}

export interface SpawnedDaemon {
  readonly pid: number | undefined;
  readonly exitCode: number | null | undefined;
  unref(): void;
  once?(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface DaemonDiscoveryResult {
  readonly mode: "EXTERNAL" | "LOCAL_REUSED" | "LOCAL_STARTED";
  readonly url: string;
  readonly client: DaemonProbeClient;
  readonly info: DaemonInfo;
  readonly warning?: string;
}

export class DaemonBootstrapError extends Error {
  constructor(
    readonly code: "UNREACHABLE" | "INCOMPATIBLE_DAEMON" | "STARTUP_TIMEOUT" | "UNKNOWN_PORT_OWNER",
    message: string,
  ) {
    super(message);
    this.name = "DaemonBootstrapError";
  }
}

export interface EnsureDaemonOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly productPaths?: ProductPaths;
  readonly productVersion?: string;
  readonly daemonEntryPath?: string;
  readonly clientFactory?: (options: CaelushClientOptions) => DaemonProbeClient;
  readonly spawn?: typeof systemSpawn;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly startupTimeoutMs?: number;
  readonly pollMs?: number;
}

interface ProbeResult {
  readonly kind: "HEALTHY" | "UNREACHABLE" | "INCOMPATIBLE";
  readonly client: DaemonProbeClient;
  readonly info?: DaemonInfo;
  readonly reason?: string;
}

export async function ensureDaemon(
  options: EnsureDaemonOptions = {},
): Promise<DaemonDiscoveryResult> {
  const environment = options.environment ?? process.env;
  const configuredUrl = environment.CAELUSH_DAEMON_URL?.trim();
  const url =
    configuredUrl === undefined || configuredUrl.length === 0 ? DEFAULT_DAEMON_URL : configuredUrl;
  const clientFactory =
    options.clientFactory ??
    ((clientOptions: CaelushClientOptions) => new CaelushClient(clientOptions));
  const client = clientFactory({ baseUrl: url });
  const productVersion = options.productVersion ?? PRODUCT_VERSION;
  const external = configuredUrl !== undefined && configuredUrl.length > 0;
  const firstProbe = await probe(client, productVersion, external);

  if (external) {
    if (firstProbe.kind !== "HEALTHY" || firstProbe.info === undefined) {
      throw new DaemonBootstrapError(
        "UNREACHABLE",
        "The configured Caelush daemon is not reachable or compatible.",
      );
    }
    return {
      mode: "EXTERNAL",
      url,
      client,
      info: firstProbe.info,
      ...(firstProbe.reason === undefined ? {} : { warning: firstProbe.reason }),
    };
  }

  if (firstProbe.kind === "HEALTHY" && firstProbe.info !== undefined) {
    return { mode: "LOCAL_REUSED", url, client, info: firstProbe.info };
  }
  if (firstProbe.kind === "INCOMPATIBLE") {
    throw new DaemonBootstrapError("INCOMPATIBLE_DAEMON", incompatibleMessage());
  }

  const paths = options.productPaths ?? resolveProductPaths({ environment });
  await mkdirForStartup(paths.runDirectory);
  const now = options.now ?? (() => Date.now());
  const delay =
    options.delay ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.startupTimeoutMs ?? DAEMON_STARTUP_TIMEOUT_MS);
  let lease: StartupLease | undefined;

  while (now() < deadline) {
    lease = await tryAcquireStartupLease({
      directory: paths.startupLockDirectory,
      version: productVersion,
      now: now(),
    });
    if (lease !== undefined) break;

    const competingProbe = await probe(client, productVersion, false);
    if (competingProbe.kind === "HEALTHY" && competingProbe.info !== undefined) {
      return { mode: "LOCAL_REUSED", url, client, info: competingProbe.info };
    }
    if (competingProbe.kind === "INCOMPATIBLE") {
      throw new DaemonBootstrapError("INCOMPATIBLE_DAEMON", incompatibleMessage());
    }
    if (await isStartupLeaseExpired(paths.startupLockDirectory, now())) {
      await removeExpiredLease(paths.startupLockDirectory);
      continue;
    }
    await delay(Math.min(options.pollMs ?? DAEMON_STARTUP_POLL_MS, Math.max(1, deadline - now())));
  }

  if (lease === undefined)
    throw new DaemonBootstrapError("STARTUP_TIMEOUT", startupFailureMessage());
  try {
    const child = await spawnDetachedDaemon({
      entryPath: options.daemonEntryPath ?? daemonEntryPath,
      logPath: paths.daemonLogPath,
      spawn: options.spawn ?? systemSpawn,
      environment,
    });
    while (now() < deadline) {
      const startedProbe = await probe(client, productVersion, false);
      if (startedProbe.kind === "HEALTHY" && startedProbe.info !== undefined) {
        return { mode: "LOCAL_STARTED", url, client, info: startedProbe.info };
      }
      if (startedProbe.kind === "INCOMPATIBLE") {
        throw new DaemonBootstrapError("INCOMPATIBLE_DAEMON", incompatibleMessage());
      }
      if (child.exitCode !== undefined && child.exitCode !== null) {
        const racedProbe = await probe(client, productVersion, false);
        if (racedProbe.kind === "HEALTHY" && racedProbe.info !== undefined) {
          return { mode: "LOCAL_REUSED", url, client, info: racedProbe.info };
        }
        throw new DaemonBootstrapError("UNKNOWN_PORT_OWNER", startupFailureMessage());
      }
      await delay(
        Math.min(options.pollMs ?? DAEMON_STARTUP_POLL_MS, Math.max(1, deadline - now())),
      );
    }
    throw new DaemonBootstrapError("STARTUP_TIMEOUT", startupFailureMessage());
  } finally {
    await lease.release();
  }
}

async function probe(
  client: DaemonProbeClient,
  productVersion: string,
  external: boolean,
): Promise<ProbeResult> {
  try {
    const health = await client.getHealth();
    if (health.apiVersion !== "v1" || health.protocolVersion !== 1) {
      return { kind: "INCOMPATIBLE", client, reason: "daemon API or protocol is incompatible" };
    }
    const info = await client.getInfo();
    if (info.apiVersion !== "v1" || info.protocolVersion !== 1) {
      return { kind: "INCOMPATIBLE", client, reason: "daemon API or protocol is incompatible" };
    }
    if (!external && info.daemonVersion !== productVersion) {
      return {
        kind: "INCOMPATIBLE",
        client,
        info,
        reason: "daemon product version is incompatible",
      };
    }
    return {
      kind: "HEALTHY",
      client,
      info,
      ...(external && info.daemonVersion !== productVersion
        ? {
            reason: `Warning: daemon product version is ${info.daemonVersion}; launcher is ${productVersion}.`,
          }
        : {}),
    };
  } catch (error) {
    return {
      kind: "UNREACHABLE",
      client,
      reason: error instanceof Error ? error.message : "unreachable",
    };
  }
}

async function spawnDetachedDaemon(input: {
  readonly entryPath: string;
  readonly logPath: string;
  readonly spawn: typeof systemSpawn;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<SpawnedDaemon> {
  const logFd = await openDaemonLog(input.logPath);
  try {
    const spawnOptions: SpawnOptions = {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...input.environment },
    };
    const child = input.spawn(process.execPath, [input.entryPath], spawnOptions);
    child.unref();
    return {
      pid: child.pid,
      get exitCode() {
        return child.exitCode;
      },
      unref: () => child.unref(),
    };
  } finally {
    closeDaemonLog(logFd);
  }
}

async function mkdirForStartup(directory: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
}

async function removeExpiredLease(directory: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(directory, { recursive: true, force: true });
}

function incompatibleMessage(): string {
  return "A different or incompatible Caelush daemon is already using the local Agent service address.";
}

function startupFailureMessage(): string {
  return "Caelush Local Agent Service could not start. Run `caelush doctor` for diagnostics.";
}
