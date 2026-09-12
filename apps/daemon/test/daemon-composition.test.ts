import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@caelush/events";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
});

describe("daemon production composition", () => {
  it("builds one shared runtime, tool catalog, gateway, controller, and supervisor", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const eventBus = new EventBus(storage.events);

    composition = composeDaemon({
      storage,
      eventBus,
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

    expect(composition.eventBus).toBe(eventBus);
    expect(composition.runs).toBe(storage.runs);
    expect(composition.approvals).toBe(storage.approvals);
    expect(composition.contextRuntime).toBeDefined();
    expect(composition.runtimeResolver.resolve({ id: "local", kind: "local" })).toBe(
      composition.runtime,
    );
    expect(composition.runtime.kind).toBe("local");
    expect(composition.toolRegistry.modelDefinitions().map((tool) => tool.name)).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ]);
    expect(composition.toolRegistry.modelGuidance().map((entry) => entry.toolName)).toEqual(
      composition.toolRegistry.modelDefinitions().map((tool) => tool.name),
    );
    // Phase 2C: provider authority is the AI subsystem registry, not a legacy registry.
    expect(composition.ai.providers.list().map((provider) => provider.id)).toEqual([
      "openai-compatible",
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
        sseReplay: true,
      },
      runtimeKinds: ["local"],
      configuredProviders: ["openai-compatible"],
      defaultModel: { provider: "openai-compatible", model: "fixture-model" },
      defaultRunConfiguration: {
        runtime: { id: "local", kind: "local" },
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
    expect(JSON.stringify(composition.info)).not.toContain("secret-that-must-not-be-public");
    expect(() =>
      composition.modelCanonicalizer.canonicalize({
        provider: "not-configured",
        model: "fixture-model",
      }),
    ).toThrow("model provider is unavailable");
  });

  it("filters Git tools from the model and dispatcher registry for a non-Git workspace", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-composition-non-git-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const eventBus = new EventBus(storage.events);
    composition = composeDaemon({
      storage,
      eventBus,
      toolExposure: { git: "UNAVAILABLE" },
    });

    expect(composition.toolRegistry.names()).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
    ]);
    expect(composition.toolCoordinator.modelDefinitions().map((tool) => tool.name)).toEqual(
      composition.toolRegistry.names(),
    );
    expect(composition.toolRegistry.modelGuidance().map((entry) => entry.toolName)).toEqual(
      composition.toolRegistry.names(),
    );
  });
});
