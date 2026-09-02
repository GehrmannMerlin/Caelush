import { describe, expect, it, vi } from "vitest";
import type { DaemonInfo, HealthResponse } from "@caelush/protocol";
import { resolveProductPaths } from "@caelush/daemon/paths";
import { formatDoctorReport, runDoctor, type DoctorOptions } from "../src/doctor.js";

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
  configuredProviders: ["openai-compatible"],
  defaultModel: { provider: "openai-compatible", model: "fixture-model" },
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
};

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    environment: {
      CAELUSH_PROVIDER_ID: "openai-compatible",
      CAELUSH_PROVIDER_BASE_URL: "https://provider.invalid",
      CAELUSH_PROVIDER_API_KEY: "SECRET_SENTINEL",
      CAELUSH_DEFAULT_PROVIDER: "openai-compatible",
      CAELUSH_DEFAULT_MODEL: "fixture-model",
    },
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
      getHealth: vi.fn(async () => health),
      getInfo: vi.fn(async () => info),
    },
    nodePtyCheck: async () => ({ available: true }),
    migrationCheck: () => ({ available: true, migrationCount: 7 }),
    executableCheck: async () => true,
    ...overrides,
  };
}

describe("doctor", () => {
  it("is read-only and reports public provider fields without secrets", async () => {
    const doctorOptions = options();
    const result = await runDoctor(doctorOptions);
    const output = formatDoctorReport(result);
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Provider configured: yes");
    expect(output).toContain("Provider ID: openai-compatible");
    expect(output).toContain("Default model: fixture-model");
    expect(output).not.toContain("SECRET_SENTINEL");
    expect(doctorOptions.probeClient?.getHealth).toHaveBeenCalledOnce();
  });

  it("does not auto-start when daemon is unreachable and keeps warning-only checks at exit 0", async () => {
    const result = await runDoctor(
      options({
        probeClient: {
          getHealth: vi.fn(async () => {
            throw new Error("connection refused");
          }),
          getInfo: vi.fn(async () => info),
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.name === "daemon reachable")?.status).toBe("WARN");
  });

  it("returns exit 1 for critical preflight failures", async () => {
    const result = await runDoctor(
      options({ nodeVersion: "25.0.0", nodePtyCheck: async () => ({ available: false }) }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.checks.filter((check) => check.status === "FAIL").length).toBeGreaterThan(0);
  });

  it("redacts credentials and query values from a configured daemon URL", async () => {
    const result = await runDoctor(
      options({
        environment: {
          CAELUSH_DAEMON_URL:
            "http://user:SECRET_SENTINEL@127.0.0.1:43120/api?token=SECRET_SENTINEL",
        },
      }),
    );
    const output = formatDoctorReport(result);
    expect(output).toContain("daemon URL: http://127.0.0.1:43120/api");
    expect(output).not.toContain("SECRET_SENTINEL");
  });

  it("reports when a reachable daemon is healthy but has no default model", async () => {
    const result = await runDoctor(
      options({
        environment: {},
        probeClient: {
          getHealth: vi.fn(async () => health),
          getInfo: vi.fn(
            async () =>
              ({
                ...info,
                configuredProviders: [],
                defaultModel: undefined,
              }) as unknown as DaemonInfo,
          ),
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(formatDoctorReport(result)).toContain(
      "[WARN] Default model: not configured in the running daemon; set CAELUSH_DEFAULT_PROVIDER and CAELUSH_DEFAULT_MODEL, then restart the daemon.",
    );
  });

  it("reports an invalid daemon URL without throwing or starting anything", async () => {
    const result = await runDoctor(
      options({
        environment: { CAELUSH_DAEMON_URL: "not a URL" },
        probeClient: undefined,
      }),
    );
    expect(formatDoctorReport(result)).toContain("[WARN] daemon reachable: not reachable");
  });
});
