import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEventId,
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
  type ToolName,
} from "@caelush/protocol";
import { EventBus } from "@caelush/events";
import {
  ToolDispatcher,
  ToolRegistryBuilder,
  createReadOnlyFilesystemToolRegistrations,
  type ToolCommittedEventNotifier,
  type ToolDispatcherOutcome,
} from "@caelush/tools";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

describe("read-only filesystem tools through ToolDispatcher", () => {
  it("executes all built-ins against the run workspace and persists their observations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-read-only-tools-"));
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "caelush.sqlite");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "README.txt"), "alpha\nneedle in readme\n", "utf8");
    await writeFile(path.join(workspace, "src", "app.ts"), "const needle = true;\n", "utf8");

    const storage = await openCaelushStorage({ path: databasePath });
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

    const eventBus = new EventBus(storage.events);
    const registrations = createReadOnlyFilesystemToolRegistrations(
      createLocalRuntimeResolver(new LocalRuntime()),
    );
    const registryBuilder = new ToolRegistryBuilder();
    for (const registration of registrations) registryBuilder.register(registration);
    const notifier: ToolCommittedEventNotifier = {
      notifyCommitted: (events) => eventBus.notifyCommitted(events),
    };
    let now = 200;
    const dispatcher = new ToolDispatcher({
      registry: registryBuilder.build(),
      store: storage.toolExecution,
      gate: { decide: async () => ({ kind: "ALLOW" as const }) },
      notifier,
      clock: { now: () => createTimestampMs(++now) },
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
    });

    const environment = { workspace: run.workspace, runtime: run.runtime };
    const dispatch = async (externalCallId: string, toolName: ToolName, args: JsonObject) => {
      const outcome = await dispatcher.dispatch({
        sessionId: session.id,
        runId: run.id,
        stepId: step.id,
        externalCallId,
        toolName,
        args,
        environment,
        securityContext: {
          permissionProfile: run.permissionProfile,
          approvalPolicy: run.approvalPolicy,
        },
      });
      expect(outcome.kind).toBe("RESULT");
      return outcome as Extract<ToolDispatcherOutcome, { kind: "RESULT" }>;
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
      expect((await storage.events.replay(run.id)).map((event) => event.type)).toEqual([
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
