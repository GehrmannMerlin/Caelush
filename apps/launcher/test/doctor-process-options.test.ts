import { describe, expect, it, vi } from "vitest";
import type { DaemonInfo, HealthResponse } from "@caelush/protocol";
import { resolveProductPaths } from "@caelush/daemon/paths";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import { runDoctor } from "../src/doctor.js";

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

describe("launcher doctor executable checks", () => {
  it("hides version-check process windows", async () => {
    childProcess.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback(null);
      return undefined;
    });

    await runDoctor({
      environment: {},
      productPaths: resolveProductPaths({
        environment: { CAELUSH_HOME: process.env.TEMP ?? "C:/temp" },
      }),
      nodeVersion: "24.0.0",
      platform: "win32",
      arch: "x64",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      workspacePath: process.cwd(),
      probeClient: {
        getHealth: async () => health,
        getInfo: async () => info,
      },
      nodePtyCheck: async () => ({ available: true }),
      migrationCheck: () => ({ available: true, migrationCount: 0 }),
    });

    expect(childProcess.execFile).toHaveBeenCalledTimes(2);
    for (const call of childProcess.execFile.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ shell: false, windowsHide: true }));
    }
  });
});
