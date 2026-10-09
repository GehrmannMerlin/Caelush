import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSecurityContext } from "@caelush/agent";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import type {
  ManagedProcessAdapter,
  ProcessExit,
  ProcessOutputEvent,
  ProcessSandboxProvider,
} from "@caelush/runtime";
import {
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type SecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { OPENAI_COMPATIBLE_API_ID } from "@caelush/ai/adapters/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";
import { startDaemon, type DaemonHandle, type DaemonOptions } from "../src/daemon.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;
const startedDaemons: DaemonHandle[] = [];

afterEach(async () => {
  await Promise.all(
    startedDaemons.splice(0).map((daemon) => daemon.close().catch(() => undefined)),
  );
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
});

describe("daemon production composition", () => {
  it("leaves default Tool construction to the provider-aware composition root", async () => {
    const source = await readFile(new URL("../src/daemon.ts", import.meta.url), "utf8");

    expect(source).not.toContain("createDefaultCodingTools(");
    expect(source).not.toContain("daemonCodingOperations(");
  });

  it("does not enqueue memory extraction jobs without a production extractor", async () => {
    const source = await readFile(new URL("../src/daemon-composition.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/memoryExtractionJobs[\s\S]{0,100}\.createOrGet/u);
  });

  it("keeps equivalent transport candidates inside the shared AI subsystem", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-transports-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    composition = await composeDaemon({
      storage,
      providerBindings: [
        {
          id: "transport-fixture",
          endpoint: "https://primary.transport-fixture.invalid/v1",
          defaultApi: OPENAI_COMPATIBLE_API_ID,
          allowUnknownModels: true,
          credentials: { resolve: async () => ({ apiKey: "fixture-secret" }) },
          transportCandidates: [
            {
              id: "secondary",
              endpoint: "https://secondary.transport-fixture.invalid/v1",
              api: OPENAI_COMPATIBLE_API_ID,
            },
          ],
        },
      ],
    });

    expect(composition.ai.providers.get("transport-fixture").transportCandidates).toEqual([
      {
        id: "secondary",
        endpoint: "https://secondary.transport-fixture.invalid/v1",
        api: OPENAI_COMPATIBLE_API_ID,
      },
    ]);
    expect(composition.info.configuredProviders).toContain("transport-fixture");
    expect(JSON.stringify(composition.info)).not.toContain("transport-fixture.invalid");
    expect(JSON.stringify(composition.info)).not.toContain("fixture-secret");
  });

  it("builds one shared runtime, tool catalog, gateway, controller, and supervisor", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    composition = await composeDaemon({
      storage,
      providers: [
        {
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret-that-must-not-be-public",
          allowedModels: ["fixture-model"],
        },
      ],
      defaultModel: { provider: "openai-compatible", model: "fixture-model" },
    });

    expect(composition.eventHub).toBeDefined();
    expect(composition.events).toBe(composition.eventHub);
    expect(composition.runs).toBe(storage.runs);
    expect(composition.approvals).toBe(storage.approvals);
    // Context V2 is composed per Run behind the Agent seam; the daemon no longer exposes a legacy
    // process-wide Context runtime or a second policy authority.
    expect(composition).not.toHaveProperty("contextRuntime");
    expect(composition.runtimeResolver.resolve({ id: "local", kind: "local" })).toBe(
      composition.runtime,
    );
    expect(composition.runtime.kind).toBe("local");
    expect(composition.toolRegistry.modelSpecs().map((tool) => tool.name)).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "stop_process",
      "git_status",
      "git_diff",
    ]);
    // Phase 4E moved usage guidance out of the provider-visible tool catalog: the ten defaults carry
    // no guidance folded into a description, because their guidance travels as a Coding `promptSnippet`
    // through the budgeted Context path. Phase 4F removed the legacy `modelGuidance` accessor with the
    // package that declared it, so the assertion is now the structural one: every model spec is exactly
    // the three model-facing fields, and no description carries a guidance heading.
    for (const spec of composition.toolRegistry.modelSpecs()) {
      expect(Object.keys(spec).sort(), spec.name).toEqual(["description", "inputSchema", "name"]);
      expect(spec.description, spec.name).not.toContain("Purpose:");
      expect(spec.description, spec.name).not.toContain("When:");
      expect(spec.description, spec.name).not.toContain("Safety:");
    }
    expect(composition.toolRegistry).not.toHaveProperty("modelGuidance");
    // Phase 2C: provider authority is the AI subsystem registry, not a legacy registry.
    expect(composition.ai.providers.list().map((provider) => provider.id)).toEqual([
      "anthropic",
      "deepseek",
      "gemini",
      "glm",
      "groq",
      "kimi",
      "mimo",
      "minimax",
      "mistral",
      "openai",
      "openai-compatible",
      "openrouter",
      "qwen",
    ]);
    // The legacy environment value states no per-model profile, so the catalog holds
    // no enumerable descriptor set; a fallback source describes whatever ref it is
    // asked about and therefore cannot enumerate.
    expect(
      composition.ai.models.has({ provider: "openai-compatible", model: "fixture-model" }),
    ).toBe(true);
    expect(composition.info).toEqual({
      apiVersion: "v1",
      protocolVersion: 1,
      daemonVersion: "0.1.0",
      capabilities: {
        runExecution: true,
        runRecovery: true,
        cancellation: true,
        approvals: true,
        sessionContinuityPreflight: true,
        sessionTranscript: true,
        sessionTurnPresentation: true,
        sseReplay: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: ["openai-compatible"],
      defaultModel: { provider: "openai-compatible", model: "fixture-model" },
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
        defaultPreset: "WORKSPACE_WRITE",
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
        resourcePolicy: {
          mode: "ADAPTIVE",
          operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
          batch: { maxToolCallsPerTurn: 16 },
          progress: {
            windowTurns: 8,
            identicalCallNudgeThreshold: 3,
            noProgressTurnsBeforeReplan: 4,
            replansBeforePause: 2,
          },
          hardLimits: {},
          inactivity: {},
        },
      },
    });
    expect(composition.info.capabilities).not.toHaveProperty("desktopHostAuthV1");
    expect(composition.info.capabilities).not.toHaveProperty("desktopProfileBindingV1");
    expect(composition.info.capabilities).not.toHaveProperty("desktopLocalProxyV1");
    expect(JSON.stringify(composition.info)).not.toContain("secret-that-must-not-be-public");
    expect(() =>
      composition.modelCanonicalizer.canonicalize({
        provider: "not-configured",
        model: "fixture-model",
      }),
    ).toThrow("model provider is unavailable");
  });

  it("filters Git tools from the model catalog and the registry for a non-Git workspace", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-non-git-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    composition = await composeDaemon({
      storage,
      toolExposure: "UNAVAILABLE",
    });

    expect(composition.toolRegistry.names()).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "stop_process",
    ]);
    expect(composition.toolTurn.modelSpecs().map((tool) => tool.name)).toEqual(
      composition.toolRegistry.names(),
    );
    // Filtering is aligned across every view: the registry, the model catalog the Tool turn publishes
    // and the Coding catalog all describe the same eight active Tools. Phase 4F made that one
    // derivation — the reduced *definition* list builds all three — rather than a registry the catalog
    // was then filtered against.
    for (const spec of composition.toolTurn.modelSpecs()) {
      expect(Object.keys(spec).sort(), spec.name).toEqual(["description", "inputSchema", "name"]);
    }
    expect(composition.toolRegistry.names()).not.toContain("git_status");
    expect(composition.toolRegistry.names()).not.toContain("git_diff");
  });

  it("uses the same available restricted provider for Workspace Write Tool execution", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-restricted-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const { provider, create } = executableRestrictedProvider();
    composition = await composeDaemon({ storage, processSandboxProviders: [provider] });
    await expect(
      composition.securityCapabilityService.getGlobalCapabilities(),
    ).resolves.toMatchObject({
      processSandbox: {
        status: "AVAILABLE",
        provider: "fixture-executable-restricted",
      },
    });
    const tool = composition.toolRegistry.resolve("exec_command");
    if (tool === undefined) throw new Error("exec_command must be registered");
    const runId = createRunId();
    const securityContext: ToolSecurityContext = {
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: {
        presetId: "WORKSPACE_WRITE",
        presetVersion: 1,
        policyDigest: "b".repeat(64),
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
      },
    };

    const result = await tool.tool.execute({
      identity: {
        runId,
        sessionId: createSessionId(),
        sourceStepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call-restricted-provider",
      },
      args: { cmd: "echo restricted", tty: false, yield_time_ms: 250 },
      environment: {
        workspace: { id: createWorkspaceId(), path: directory },
        runtime: { id: "local", kind: "local" },
      },
      securityContext,
      signal: new AbortController().signal,
      updates: { publish() {} },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      policy: {
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
      },
    });
    expect(result.isError).toBe(false);
  });
});

async function startFixtureDaemon(
  options: Omit<DaemonOptions, "databasePath"> = {},
): Promise<DaemonHandle> {
  directory = await mkdtemp(join(tmpdir(), "caelush-startup-"));
  const daemon = await startDaemon({
    ...options,
    databasePath: join(directory, "caelush.db"),
    port: options.port ?? 0,
  });
  startedDaemons.push(daemon);
  return daemon;
}

async function readGlobalCapabilities(daemon: DaemonHandle): Promise<SecurityCapabilitiesResponse> {
  const response = await fetch(`${daemon.url}/api/v1/security/capabilities`);
  expect(response.status).toBe(200);
  return (await response.json()) as SecurityCapabilitiesResponse;
}

function restrictedProvider(): ProcessSandboxProvider {
  return {
    id: "fixture-restricted",
    kind: "RESTRICTED",
    enforcement: "PARTIAL",
    create: vi.fn(),
    probe: vi.fn(async () => ({ available: true, enforcement: "PARTIAL" as const })),
  };
}

function executableRestrictedProvider(): {
  readonly provider: ProcessSandboxProvider;
  readonly create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => completedProcessAdapter());
  return {
    create,
    provider: {
      id: "fixture-executable-restricted",
      kind: "RESTRICTED",
      enforcement: "PARTIAL",
      create,
      probe: vi.fn(async () => ({ available: true, enforcement: "PARTIAL" as const })),
    },
  };
}

function completedProcessAdapter(): ManagedProcessAdapter {
  const startListeners = new Set<() => void>();
  const outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  const exitListeners = new Set<(exit: ProcessExit) => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  let scheduled = false;
  const scheduleCompletion = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      for (const listener of startListeners) listener();
      for (const listener of exitListeners) listener({ exitCode: 0 });
    });
  };
  return {
    tty: false,
    onStart(listener) {
      startListeners.add(listener);
      scheduleCompletion();
      return () => startListeners.delete(listener);
    },
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    async write() {},
    async close() {},
  };
}

const absentRunnerPath = join(tmpdir(), "caelush-absent-runner", "caelush-sandbox-runner.exe");

describe("daemon startup sandbox wiring", () => {
  it("starts and reports a bounded reason when no packaged Runner resolves", async () => {
    const daemon = await startFixtureDaemon({
      environment: { CAELUSH_SANDBOX_RUNNER_PATH: absentRunnerPath },
    });

    const capabilities = await readGlobalCapabilities(daemon);

    // A missing Runner must not prevent startup, and it must not be reported as a plain spawn.
    expect(capabilities.processSandbox).toMatchObject({
      status: "UNAVAILABLE",
      enforcement: "NONE",
    });
    expect(capabilities.processSandbox.reasonCode).toBe("RUNNER_ARTIFACT_MISSING");
    expect(capabilities.workspacePreparationSupported).toBe(false);
  });

  it("reads the ambient environment a direct daemon start receives", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-env-runner-"));
    const previous = process.env.CAELUSH_SANDBOX_RUNNER_PATH;
    try {
      await writeFile(join(root, "caelush-sandbox-runner.exe"), "not-a-runner", "utf8");
      await writeFile(join(root, "manifest.json"), "{ this is not json", "utf8");
      process.env.CAELUSH_SANDBOX_RUNNER_PATH = join(root, "caelush-sandbox-runner.exe");

      // No explicit `environment`: the startup path must fall back to `process.env`, which is what a
      // launcher-spawned daemon actually receives.
      const daemon = await startFixtureDaemon();
      const capabilities = await readGlobalCapabilities(daemon);

      // Only the override path can produce this reason, so the ambient environment was consumed.
      expect(capabilities.processSandbox.reasonCode).toBe("RUNNER_MANIFEST_INVALID");
    } finally {
      if (previous === undefined) delete process.env.CAELUSH_SANDBOX_RUNNER_PATH;
      else process.env.CAELUSH_SANDBOX_RUNNER_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers an injected provider seam over host discovery", async () => {
    const daemon = await startFixtureDaemon({
      processSandboxProviders: [restrictedProvider()],
      environment: { CAELUSH_SANDBOX_RUNNER_PATH: absentRunnerPath },
    });

    const capabilities = await readGlobalCapabilities(daemon);

    expect(capabilities.processSandbox).toMatchObject({
      status: "AVAILABLE",
      enforcement: "PARTIAL",
      provider: "fixture-restricted",
    });
    expect(capabilities.processSandbox.reasonCode).toBeUndefined();
    expect(capabilities.workspacePreparationSupported).toBe(false);
  });

  it("honours an injected preparation port alongside an injected provider", async () => {
    const daemon = await startFixtureDaemon({
      processSandboxProviders: [restrictedProvider()],
      workspacePreparation: {
        supported: true,
        getStatus: async (_workspaceId, preset) =>
          preset.id === "VIEW_ONLY" ? "READY" : "REQUIRED",
        prepare: async () => ({ status: "READY" as const }),
      },
    });

    expect((await readGlobalCapabilities(daemon)).workspacePreparationSupported).toBe(true);
  });

  it("honours an injected resolution outcome without touching host discovery", async () => {
    const daemon = await startFixtureDaemon({
      windowsSandboxResolution: { available: false, reasonCode: "RUNNER_HASH_MISMATCH" },
    });

    // The injected outcome wins over the ambient environment, and its bounded reason is what the API
    // reports — not a generic unavailability.
    expect((await readGlobalCapabilities(daemon)).processSandbox).toMatchObject({
      status: "UNAVAILABLE",
      enforcement: "NONE",
      reasonCode: "RUNNER_HASH_MISMATCH",
    });
  });

  it.skipIf(process.platform !== "win32")(
    "verifies a development override before it is advertised",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "caelush-override-runner-"));
      try {
        const runnerPath = join(root, "caelush-sandbox-runner.exe");
        const bytes = Buffer.from("caelush-fixture-runner", "utf8");
        await writeFile(runnerPath, bytes);
        await writeFile(
          join(root, "manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            product: "caelush",
            controlProtocolVersion: 1,
            platform: "windows",
            arch: process.arch,
            executableName: "caelush-sandbox-runner.exe",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            providers: ["windows-acl-restricted-token"],
          }),
          "utf8",
        );

        const daemon = await startFixtureDaemon({
          environment: { CAELUSH_SANDBOX_RUNNER_PATH: runnerPath },
        });
        const capabilities = await readGlobalCapabilities(daemon);

        // The manifest identity and the SHA-256 were accepted — a mismatch would have produced
        // RUNNER_MANIFEST_INVALID or RUNNER_HASH_MISMATCH instead. Only the bounded functional probe
        // fails, which is the strongest signal reachable without a real Runner.
        expect(capabilities.processSandbox.reasonCode).toBe("RUNNER_FUNCTIONAL_PROBE_FAILED");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
