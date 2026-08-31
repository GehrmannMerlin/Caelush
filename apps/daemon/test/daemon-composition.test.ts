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
    expect(composition.providerRegistry.listProviderIds()).toEqual(["openai-compatible"]);
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
    });
    expect(JSON.stringify(composition.info)).not.toContain("secret-that-must-not-be-public");
    expect(() =>
      composition.modelCanonicalizer.canonicalize({
        provider: "not-configured",
        model: "fixture-model",
      }),
    ).toThrow("model provider is unavailable");
  });
});
