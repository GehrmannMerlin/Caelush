import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo, HealthResponse } from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProductPaths } from "@caelush/daemon/paths";
import {
  ensureDaemon,
  type DaemonProbeClient,
  type SpawnedDaemon,
} from "../src/daemon-discovery.js";

const health: HealthResponse = {
  service: "caelush-daemon",
  status: "ready",
  apiVersion: "v1",
  protocolVersion: 1,
};
const info: DaemonInfo = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "0.1.0",
  capabilities: {
    runExecution: true,
    runRecovery: true,
    cancellation: true,
    approvals: true,
    sseReplay: true,
  },
  runtimeKinds: ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
};

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createProbeClient(
  getHealth: DaemonProbeClient["getHealth"],
  getInfo: DaemonProbeClient["getInfo"] = async () => info,
): DaemonProbeClient {
  return { getHealth, getInfo };
}

describe("daemon discovery", () => {
  it("connects to a custom daemon without creating local lifecycle files or spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-external-"));
    createdDirectories.push(root);
    const spawn = vi.fn();
    const result = await ensureDaemon({
      environment: { CAELUSH_DAEMON_URL: "http://external.example:43120" },
      productPaths: resolveProductPaths({ environment: { CAELUSH_HOME: root } }),
      clientFactory: () => createProbeClient(async () => health),
      spawn,
    });

    expect(result.mode).toBe("EXTERNAL");
    expect(result.url).toBe("http://external.example:43120");
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, "run"))).toBe(false);
    expect(existsSync(join(root, "logs"))).toBe(false);
  });

  it("reuses a compatible default daemon without spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-reuse-"));
    createdDirectories.push(root);
    const spawn = vi.fn();
    const result = await ensureDaemon({
      productPaths: resolveProductPaths({ environment: { CAELUSH_HOME: root } }),
      clientFactory: () => createProbeClient(async () => health),
      spawn,
    });

    expect(result.mode).toBe("LOCAL_REUSED");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails safely when a local daemon is reachable but has another product version", async () => {
    const mismatched = { ...info, daemonVersion: "0.0.9" };
    await expect(
      ensureDaemon({
        productPaths: resolveProductPaths({
          environment: {
            CAELUSH_HOME: await mkdtemp(join(tmpdir(), "caelush-launcher-mismatch-")),
          },
        }),
        clientFactory: () =>
          createProbeClient(
            async () => health,
            async () => mismatched,
          ),
      }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_DAEMON" });
  });

  it("spawns a detached daemon with the current Node and converges after health", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-start-"));
    createdDirectories.push(root);
    let healthy = false;
    const child: SpawnedDaemon = {
      pid: 1234,
      exitCode: undefined,
      unref: vi.fn(),
      once: vi.fn(),
    };
    const spawn = vi.fn(() => {
      healthy = true;
      return child;
    });
    const result = await ensureDaemon({
      productPaths: resolveProductPaths({ environment: { CAELUSH_HOME: root } }),
      clientFactory: () =>
        createProbeClient(async () => {
          if (!healthy) throw new Error("connection refused");
          return health;
        }),
      spawn,
      daemonEntryPath: "C:/bundle/daemon/dist/main.js",
      delay: async () => undefined,
    });

    expect(result.mode).toBe("LOCAL_STARTED");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["C:/bundle/daemon/dist/main.js"],
      expect.objectContaining({ detached: true }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    const lockPath = join(root, "run", "daemon-start.lock", "metadata.json");
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(join(root, "logs", "daemon.log"), "utf8")).not.toContain("API_KEY");
  });
});
