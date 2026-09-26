import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";

/**
 * Phase 4D — the daemon composes the canonical Tool turn pipeline.
 *
 * ```text
 * ToolCallPreparer            +  ToolBudgetAdmissionPort  +  DurableToolExecutionCoordinator
 *        ↓
 * canonical ToolBatchCoordinator
 *        ↓
 * canonical ModelToolFeedbackProjector
 *        ↓
 * canonical ToolResultBatchNormalizer
 *        ↓
 * RunController
 * ```
 *
 * This is a composition guard, not a behaviour test: it proves the *production* root builds exactly one
 * of each canonical authority, wires the Context token projection into the projector's implementation
 * seam, and never constructs the legacy batch coordinator. Behaviour is proven by the storage and
 * daemon round-trip suites that drive this same composition.
 */

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

async function compose(): Promise<DaemonComposition> {
  directory = await mkdtemp(join(tmpdir(), "caelush-phase-4d-composition-"));
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
  return composition;
}

describe("Phase 4D daemon Tool batch composition", () => {
  it("exposes one canonical Tool turn pipeline with all three authorities", async () => {
    const daemon = await compose();
    const pipeline = daemon.toolTurn;

    // One batch scheduler, and it is the canonical one: the behaviour it must have is the Agent
    // package's, and the legacy class has a different outcome vocabulary entirely.
    expect(typeof pipeline.batches.execute).toBe("function");
    // The legacy coordinator's two extra methods must not exist on the production object.
    expect(pipeline.batches).not.toHaveProperty("recover");
    expect(pipeline.batches).not.toHaveProperty("modelDefinitions");
    expect(pipeline.batches).not.toHaveProperty("dispatch");

    // One projector, one normalizer.
    expect(typeof pipeline.feedback.project).toBe("function");
    expect(typeof pipeline.normalizer.normalize).toBe("function");

    // The catalog travels with the pipeline and is the registry's own: one registry, never two.
    expect(pipeline.modelSpecs().map((tool) => tool.name)).toEqual(daemon.toolRegistry.names());
  });

  it("constructs the legacy batch coordinator nowhere in the production root", async () => {
    const source = await readFile(new URL("../src/daemon-composition.ts", import.meta.url), "utf8");
    // Phase 4D's cutover, asserted where it happened.
    expect(source).toContain("createToolBatchCoordinator({");
    expect(source).toContain("createModelToolFeedbackProjector({");
    expect(source).toContain("createToolResultBatchNormalizer()");
    expect(source).not.toContain("new ToolBatchCoordinator(");

    // The legacy facade is still *imported* by tests and direct clients, but the production root does
    // not name the class as a value or as a type. The doc comments that explain the cutover do mention
    // it in prose, which is why this matches a TypeScript *reference* rather than the bare word.
    expect(source).not.toMatch(/\bToolBatchCoordinator\s*[;,)<]/);
    expect(source).not.toContain("new ToolBatchCoordinator");
  });

  it("wires the Context token projection into the projector's seam", async () => {
    const source = await readFile(new URL("../src/daemon-composition.ts", import.meta.url), "utf8");
    // `@caelush/agent` owns the model feedback semantics and canonical bounded observation projector;
    // the composition root wires that projector into the production pipeline.
    expect(source).toContain("projection: toContextObservationProjection()");
    expect(source).toContain("toContextObservationProjection");
    // And it passes the whole pipeline to the Run Layer, not a subset of it.
    expect(source).toContain("toolTurn,");
  });

  it("gives the Run Layer a pipeline whose parts cannot disagree", async () => {
    const daemon = await compose();

    // The batch and the projector are wired over the same registry identity, so a call the batch
    // rejects is described to the model by the projector under the same catalog.
    const calls = [
      { externalCallId: "call_1", toolName: "read_file" as const, args: { path: "a" } },
    ];
    const items = [
      {
        kind: "REJECTED" as const,
        call: calls[0]!,
        feedback: {
          code: "TOOL_UNAVAILABLE",
          content: "No such Tool is registered.",
          details: {},
          disposition: "SAFE_FAILURE" as const,
        },
      },
    ];
    const projected = daemon.toolTurn.feedback.project({
      calls,
      items,
      policy: { maxSingleObservationTokens: 1_000, maxObservationBatchTokens: 4_000 },
    });
    const normalized = daemon.toolTurn.normalizer.normalize({
      requests: calls,
      results: projected.map((item) => item.message),
    });

    // The two production objects compose without an adapter: exactly one result, same identity, error.
    expect(normalized).toEqual([
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "No such Tool is registered.",
        isError: true,
      },
    ]);
  });
});
