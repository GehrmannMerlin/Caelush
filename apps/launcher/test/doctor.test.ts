import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("reports missing ripgrep as an optional accelerator because search has a fallback", async () => {
    const result = await runDoctor(
      options({ executableCheck: async (executable) => executable === "git" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.name === "ripgrep")).toMatchObject({
      status: "WARN",
      detail: "not available; bounded Runtime fallback active",
    });
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

  it("verifies the restricted runner manifest and binary hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-doctor-sandbox-runner-"));
    try {
      const runnerPath = join(root, "caelush-sandbox-runner.exe");
      const runnerBytes = "runner-fixture";
      await writeFile(runnerPath, runnerBytes, "utf8");
      const hash = createHash("sha256").update(runnerBytes).digest("hex");
      const environment = {
        ...options().environment,
        CAELUSH_SANDBOX_RUNNER_PATH: runnerPath,
        CAELUSH_SANDBOX_RUNNER_MANIFEST: join(root, "manifest.json"),
      };
      await writeFile(
        join(root, "manifest.json"),
        JSON.stringify({
          product: "caelush",
          schemaVersion: 1,
          controlProtocolVersion: 1,
          platform: "windows",
          arch: "x64",
          executableName: "caelush-sandbox-runner.exe",
          sha256: hash,
          providers: ["windows-acl-restricted-token"],
        }),
        "utf8",
      );
      const result = await runDoctor(options({ environment }));
      expect(result.checks.find((check) => check.name === "Restricted execution Provider")).toEqual(
        {
          name: "Restricted execution Provider",
          status: "PASS",
          detail: "native runner verified",
        },
      );

      await writeFile(runnerPath, "tampered-runner", "utf8");
      const tampered = await runDoctor(options({ environment }));
      expect(
        tampered.checks.find((check) => check.name === "Restricted execution Provider"),
      ).toEqual({
        name: "Restricted execution Provider",
        status: "WARN",
        detail: "RUNNER_HASH_MISMATCH",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports host feature gates without enabling an affected capability by fallback", async () => {
    const result = await runDoctor(
      options({
        environment: {
          CAELUSH_FEATURE_PERMISSION_PRESETS_V1: "1",
          CAELUSH_FEATURE_RUNTIME_SANDBOX_V1: "0",
          CAELUSH_FEATURE_FULL_ACCESS_V1: "invalid",
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(formatDoctorReport(result)).toContain(
      "[PASS] Feature gate permissionPresetsV1: enabled",
    );
    expect(formatDoctorReport(result)).toContain(
      "[WARN] Feature gate runtimeSandboxV1: disabled by host configuration",
    );
    expect(formatDoctorReport(result)).toContain(
      "[WARN] Feature gate fullAccessV1: disabled because its host value is invalid",
    );
  });

  it("reports an unsupported workspace filesystem and failed Runner probe without enabling fallback", async () => {
    const result = await runDoctor(
      options({
        workspaceFilesystemCheck: () => ({
          available: false,
          reasonCode: "WORKSPACE_FILESYSTEM_UNSUPPORTED",
        }),
        sandboxRunnerCheck: async () => ({
          available: false,
          reasonCode: "RUNNER_PROBE_FAILED",
        }),
      }),
    );

    expect(result.exitCode).toBe(0);
    const output = formatDoctorReport(result);
    expect(output).toContain("[WARN] workspace filesystem: WORKSPACE_FILESYSTEM_UNSUPPORTED");
    expect(output).toContain("[WARN] Restricted execution Provider: RUNNER_PROBE_FAILED");
  });
});
