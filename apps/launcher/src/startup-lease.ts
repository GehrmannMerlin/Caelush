import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    return (
      typeof metadata.createdAt === "number" &&
      Number.isFinite(metadata.createdAt) &&
      now - metadata.createdAt >= ttlMs
    );
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

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await rm(this.directory, { recursive: true, force: true });
  }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
