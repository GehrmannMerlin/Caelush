import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(composition.contextRuntime).toBeDefined();
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
      "git_status",
      "git_diff",
    ]);
    // Phase 4E moved usage guidance out of the provider-visible tool catalog: the nine defaults carry
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
        sessionTranscript: true,
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
    ]);
    expect(composition.toolTurn.modelSpecs().map((tool) => tool.name)).toEqual(
      composition.toolRegistry.names(),
    );
    // Filtering is aligned across every view: the registry, the model catalog the Tool turn publishes
    // and the Coding catalog all describe the same seven active Tools. Phase 4F made that one
    // derivation — the reduced *definition* list builds all three — rather than a registry the catalog
    // was then filtered against.
    for (const spec of composition.toolTurn.modelSpecs()) {
      expect(Object.keys(spec).sort(), spec.name).toEqual(["description", "inputSchema", "name"]);
    }
    expect(composition.toolRegistry.names()).not.toContain("git_status");
    expect(composition.toolRegistry.names()).not.toContain("git_diff");
  });
});
