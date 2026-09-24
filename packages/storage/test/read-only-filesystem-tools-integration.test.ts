import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEventId,
  createTimestampMs,
  createWorkspaceId,
  type JsonObject,
  type ToolName,
} from "@caelush/protocol";
import { EventBus } from "./support/test-event-notifier.js";
import {
  createToolResultPipeline,
  DefaultAgentToolRegistryBuilder,
  type AgentToolRegistry,
} from "@caelush/agent";
import {
  createCodingToolCatalog,
  createCodingToolDurableMetadataPort,
  createCodingToolSettlementExtensionProjector,
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  type CodingToolCatalog,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
} from "@caelush/coding-agent";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import { makeRun, makeSession, makeStep } from "./support/fixtures.js";
import { openToolStorage } from "./support/tool-settlement-decoder.js";
import { createCanonicalToolRuntime } from "./support/canonical-tool-runtime.js";

/**
 * The four read-only filesystem Tools, end to end through the canonical durable Tool pipeline.
 *
 * ```text
 * createDefaultCodingTools(...)      read_file · list_directory · find_files · search_text   Coding layer
 *        ↓
 * AgentToolRegistry                  the immutable execution authority                      Agent layer
 *        ↓
 * DurableToolExecutionCoordinator    REQUESTED → RUNNING → execute → settle                  Agent layer
 *        ↓
 * SqliteToolExecutionStore           invocation + observation + effects + events, atomically
 * ```
 *
 * The Tools themselves are the real Coding builtins over the real `LocalRuntime`; only the policy port
 * is a fixture, because this suite is about the read-only Tool surface and its durable settlement. The
 * `file.read` host event is produced by the Coding settlement extension projector — the same one the
 * daemon composition builds — so an effect and the terminal event it accompanies are drawn from one
 * durable sequence.
 */
const READ_ONLY_TOOL_NAMES = Object.freeze([
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
] as const);

function readOnlyDefinitions(runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>): {
  readonly definitions: readonly CodingToolDefinition[];
  readonly registry: AgentToolRegistry;
  readonly catalog: CodingToolCatalog;
} {
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  const operations: DefaultCodingToolOperations = {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(runtimeResolver),
    exec: createRuntimeProcessOperations(runtimeResolver),
    process: createRuntimeProcessOperations(runtimeResolver),
    git: createRuntimeGitOperations(runtimeResolver),
  };
  const selected = new Set<string>(READ_ONLY_TOOL_NAMES);
  const definitions = createDefaultCodingTools(operations).filter((definition) =>
    selected.has(definition.tool.name),
  );
  expect(definitions.map((definition) => definition.tool.name)).toEqual([...READ_ONLY_TOOL_NAMES]);
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  const registry = builder.build();
  return { definitions, registry, catalog: createCodingToolCatalog({ registry, definitions }) };
}

describe("read-only filesystem tools through the canonical Tool pipeline", () => {
  it("executes all built-ins against the run workspace and persists their observations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-read-only-tools-"));
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "caelush.sqlite");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "README.txt"), "alpha\nneedle in readme\n", "utf8");
    await writeFile(path.join(workspace, "src", "app.ts"), "const needle = true;\n", "utf8");

    const storage = await openToolStorage({ path: databasePath });
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: workspace },
      runtime: { id: "local", kind: "local" },
    });
    const step = makeStep(run.id, { status: "COMPLETED", finishedAt: createTimestampMs(101) });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    const eventBus = new EventBus(storage.eventReader);
    const { definitions, registry, catalog } = readOnlyDefinitions(
      createLocalRuntimeResolver(new LocalRuntime()),
    );
    const runtime = createCanonicalToolRuntime({
      storage,
      registry,
      notifier: eventBus,
      startTimestamp: 200,
      // The durable row's risk level comes from the Coding catalog, which owns it.
      metadata: createCodingToolDurableMetadataPort({ registry, catalog }),
      // The Coding effect vocabulary, projected inside the invocation's own settlement transaction.
      resultPipelineFactory: ({ invocation, environment, sessionId }) =>
        createToolResultPipeline({
          settlementExtension: createCodingToolSettlementExtensionProjector({
            catalog,
            invocation: {
              invocation,
              ...(sessionId === undefined ? {} : { sessionId }),
              environment,
              // The durable event identity factory, so a Tool effect's host-domain event (`file.read`)
              // is drawn from the same sequence as the terminal event it accompanies.
              nextEventId: () => createEventId(),
            },
          }),
        }),
    });
    expect(definitions).toHaveLength(4);

    const environment = { workspace: run.workspace, runtime: run.runtime };
    const dispatch = async (externalCallId: string, toolName: ToolName, args: JsonObject) => {
      const outcome = await runtime.coordinator.execute({
        runId: run.id,
        sessionId: session.id,
        sourceStepId: step.id,
        call: runtime.prepare({ externalCallId, toolName, args }),
        environment,
        securityContext: {
          permissionProfile: run.permissionProfile,
          approvalPolicy: run.approvalPolicy,
        },
        signal: new AbortController().signal,
      });
      expect(outcome.kind).toBe("SETTLED");
      if (outcome.kind !== "SETTLED") throw new Error("expected a settled Tool execution");
      return outcome;
    };

    try {
      const read = await dispatch("read", "read_file", { path: "README.txt" });
      expect(read.observation.isError).toBe(false);
      expect(read.observation.content).toContain("needle in readme");

      const listed = await dispatch("list", "list_directory", { path: "." });
      expect(listed.observation.content).toBe("README.txt\nsrc/");

      const found = await dispatch("find", "find_files", { pattern: "**/*.ts" });
      expect(found.observation.content).toBe("src/app.ts");

      const searched = await dispatch("search", "search_text", {
        pattern: "needle",
        include: "*.ts",
      });
      expect(searched.observation.content).toContain("src/app.ts:1:");

      expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(4);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(4);
      expect(
        (
          await storage.eventReader.replay(run.id, {
            afterSequence: 0,
            throughSequence: Number.MAX_SAFE_INTEGER,
            limit: 1000,
          })
        ).map((event) => event.type),
      ).toEqual([
        "tool.requested",
        "tool.started",
        "file.read",
        "tool.completed",
        "tool.requested",
        "tool.started",
        "tool.completed",
        "tool.requested",
        "tool.started",
        "tool.completed",
        "tool.requested",
        "tool.started",
        "tool.completed",
      ]);
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
