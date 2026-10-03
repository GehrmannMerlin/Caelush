import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const STARTUP_LEASE_TTL_MS = 15_000;

interface StartupLeaseMetadata {
  readonly ownerToken: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly version: string;
}

export async function tryAcquireStartupLease(input: {
  readonly directory: string;
  readonly version: string;
  readonly now?: number;
}): Promise<StartupLease | undefined> {
  try {
    await mkdir(input.directory);
  } catch (error) {
    if (isAlreadyExists(error)) return undefined;
    throw error;
  }
  const metadata: StartupLeaseMetadata = {
    ownerToken: randomUUID(),
    pid: process.pid,
    createdAt: input.now ?? Date.now(),
    version: input.version,
  };
  try {
    await writeFile(`${input.directory}/metadata.json`, JSON.stringify(metadata), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const heartbeatPath = startupLeaseHeartbeatPath(input.directory, metadata.ownerToken);
    await writeFile(heartbeatPath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const initialHeartbeat = new Date(metadata.createdAt);
    await utimes(heartbeatPath, initialHeartbeat, initialHeartbeat);
  } catch (error) {
    await rm(input.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return new StartupLease(input.directory, metadata.ownerToken);
}

export async function isStartupLeaseExpired(
  directory: string,
  now: number,
  ttlMs = STARTUP_LEASE_TTL_MS,
): Promise<boolean> {
  try {
    const raw = await readFile(`${directory}/metadata.json`, "utf8");
    const metadata = JSON.parse(raw) as Partial<StartupLeaseMetadata>;
    const createdAt = metadata.createdAt;
    if (
      typeof metadata.ownerToken !== "string" ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt)
    ) {
      return false;
    }
    let lastHeartbeat = createdAt;
    try {
      const heartbeat = await stat(startupLeaseHeartbeatPath(directory, metadata.ownerToken));
      lastHeartbeat = Math.max(lastHeartbeat, heartbeat.mtimeMs);
    } catch {
      // A lease created by an older launcher has no heartbeat marker; its createdAt remains valid.
    }
    return now - lastHeartbeat >= ttlMs;
  } catch {
    return false;
  }
}

export class StartupLease {
  #released = false;

  constructor(
    private readonly directory: string,
    readonly ownerToken: string,
  ) {}

  async renew(now = Date.now()): Promise<boolean> {
    if (this.#released) return false;
    const heartbeat = new Date(now);
    try {
      await utimes(
        startupLeaseHeartbeatPath(this.directory, this.ownerToken),
        heartbeat,
        heartbeat,
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      const raw = await readFile(`${this.directory}/metadata.json`, "utf8");
      const metadata = JSON.parse(raw) as Partial<StartupLeaseMetadata>;
      if (metadata.ownerToken !== this.ownerToken) return;
    } catch {
      return;
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

function startupLeaseHeartbeatPath(directory: string, ownerToken: string): string {
  return `${directory}/heartbeat-${ownerToken}`;
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
