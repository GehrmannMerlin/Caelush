import { randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_VERSION } from "../src/version.js";

const REQUIRED_CAPABILITIES = [
  "runExecution",
  "runRecovery",
  "cancellation",
  "approvals",
  "sseReplay",
  "sessionTranscript",
  "desktopHostAuthV1",
  "desktopProfileBindingV1",
  "desktopLocalProxyV1",
] as const;
const profileRoots: string[] = [];
const children = new Set<ChildProcess>();
const desktopEntryPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "desktop-entry.js",
);

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(
    profileRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private Desktop Daemon child IPC", () => {
  it("starts on an ephemeral loopback port, enforces its Host Token, and rejects repeat bootstrap", async () => {
    const profile = await createProfile();
    const child = spawnChild(profile.localAppDataDirectory, profile.rootDirectory);
    const start = makeStartMessage(profile.profileId);
    const readyPromise = waitForMessage(
      child,
      (value) => isRecord(value) && value.type === "DAEMON_READY",
    );
    await send(child, start);
    const rawReady = await readyPromise;
    expect(rawReady).toMatchObject({
      type: "DAEMON_READY",
      generationId: start.generationId,
      profileId: profile.profileId,
      childPid: child.pid,
      parentPid: process.pid,
      host: "127.0.0.1",
      daemonVersion: DAEMON_VERSION,
      apiVersion: "v1",
      protocolVersion: 1,
      bootstrapAccepted: true,
    });
    expect(isRecord(rawReady) ? rawReady.port : 0).toBeGreaterThan(0);
    expect(isRecord(rawReady) ? JSON.stringify(rawReady) : "").not.toContain(start.hostToken);
    const baseUrl = `http://127.0.0.1:${String(isRecord(rawReady) ? rawReady.port : 0)}`;

    const missingToken = await fetch(`${baseUrl}/api/v1/info`, {
      headers: { origin: baseUrl },
    });
    expect(missingToken.status).toBe(403);
    expect(await missingToken.text()).not.toContain(start.hostToken);

    const staleToken = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { origin: baseUrl, "x-caelush-host-token": randomBytes(32).toString("base64url") },
    });
    expect(staleToken.status).toBe(403);

    const invalidOrigin = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { origin: "https://attacker.example", "x-caelush-host-token": start.hostToken },
    });
    expect(invalidOrigin.status).toBe(403);

    const wrongHost = await requestWithHostHeader(new URL(baseUrl), "attacker.example", {
      origin: baseUrl,
      "x-caelush-host-token": start.hostToken,
    });
    expect(wrongHost.statusCode).toBe(403);

    const info = await fetch(`${baseUrl}/api/v1/info`, {
      headers: { origin: baseUrl, "x-caelush-host-token": start.hostToken },
    });
    expect(info.status).toBe(200);
    const infoBody = await info.text();
    expect(infoBody).toContain('"desktopHostAuthV1":true');
    expect(infoBody).not.toContain(start.hostToken);

    const repeatedFailure = waitForMessage(
      child,
      (value) => isRecord(value) && value.type === "DAEMON_STARTUP_FAILED",
    );
    await send(child, { ...start, bootstrapSecret: randomBytes(32).toString("base64url") });
    expect(await repeatedFailure).toMatchObject({
      type: "DAEMON_STARTUP_FAILED",
      code: "BOOTSTRAP_ALREADY_USED",
    });
    await waitForExit(child);
    expect(child.exitCode).toBe(0);
  }, 30_000);

  it("rejects a STOP message from a different Generation before closing the owned Daemon", async () => {
    const profile = await createProfile();
    const child = spawnChild(profile.localAppDataDirectory, profile.rootDirectory);
    const start = makeStartMessage(profile.profileId);
    const readyPromise = waitForMessage(
      child,
      (value) => isRecord(value) && value.type === "DAEMON_READY",
    );
    await send(child, start);
    await readyPromise;
    const failurePromise = waitForMessage(
      child,
      (value) => isRecord(value) && value.type === "DAEMON_STARTUP_FAILED",
    );
    await send(child, {
      type: "STOP_DESKTOP_DAEMON",
      ipcProtocolVersion: 1,
      generationId: randomUUID(),
    });
    expect(await failurePromise).toMatchObject({
      type: "DAEMON_STARTUP_FAILED",
      code: "INVALID_CONTROL_MESSAGE",
    });
    await waitForExit(child);
    expect(child.exitCode).toBe(0);
  }, 30_000);
});

interface TestProfile {
  readonly localAppDataDirectory: string;
  readonly rootDirectory: string;
  readonly profileId: string;
}

interface StartMessage {
  readonly type: "START_DESKTOP_DAEMON";
  readonly ipcProtocolVersion: 1;
  readonly generationId: string;
  readonly profileId: string;
  readonly desktopVersion: string;
  readonly expectedDaemonVersion: string;
  readonly apiVersion: "v1";
  readonly protocolVersion: 1;
  readonly requiredCapabilities: readonly string[];
  readonly bootstrapSecret: string;
  readonly bootstrapExpiresAt: number;
  readonly hostToken: string;
}

async function createProfile(): Promise<TestProfile> {
  const localAppDataDirectory = await mkdtemp(path.join(tmpdir(), "caelush-d4-private-ipc-"));
  profileRoots.push(localAppDataDirectory);
  const profileId = `u_${"a".repeat(64)}`;
  const rootDirectory = path.join(localAppDataDirectory, "Caelush", "profiles", profileId);
  await mkdir(rootDirectory, { recursive: true });
  for (const name of ["runs", "logs", "backups", "browser", "downloads", "run"]) {
    await mkdir(path.join(rootDirectory, name));
  }
  await writeFile(
    path.join(rootDirectory, "profile.json"),
    JSON.stringify({ schemaVersion: 1, profileId, createdAt: new Date().toISOString() }),
    { encoding: "utf8", flag: "wx" },
  );
  return { localAppDataDirectory, rootDirectory, profileId };
}

function spawnChild(localAppDataDirectory: string, profileRootDirectory: string): ChildProcess {
  const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: localAppDataDirectory };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CAELUSH_PROVIDER_") || key.startsWith("CAELUSH_DEFAULT_")) {
      delete environment[key];
    }
  }
  environment.CAELUSH_HOME = profileRootDirectory;
  const child = fork(desktopEntryPath, [], {
    cwd: profileRootDirectory,
    env: environment,
    execPath: process.execPath,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function makeStartMessage(profileId: string): StartMessage {
  return {
    type: "START_DESKTOP_DAEMON",
    ipcProtocolVersion: 1,
    generationId: randomUUID(),
    profileId,
    desktopVersion: DAEMON_VERSION,
    expectedDaemonVersion: DAEMON_VERSION,
    apiVersion: "v1",
    protocolVersion: 1,
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    bootstrapSecret: randomBytes(32).toString("base64url"),
    bootstrapExpiresAt: Date.now() + 10_000,
    hostToken: randomBytes(32).toString("base64url"),
  };
}

async function send(child: ChildProcess, message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("Child IPC channel is closed."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function waitForMessage(
  child: ChildProcess,
  predicate: (value: unknown) => boolean,
  timeoutMs = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Private Desktop child IPC timed out."));
    }, timeoutMs);
    const onMessage = (value: unknown) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Private Desktop child exited before its IPC response."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Desktop child did not exit after its private shutdown."));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requestWithHostHeader(
  target: URL,
  hostHeader: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly statusCode: number | undefined; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(target.port),
        path: "/api/v1/health",
        method: "GET",
        headers: { ...headers, host: hostHeader },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
