import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEventId,
  createObservationId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { EventBus } from "@caelush/events";
import {
  ToolDispatcher,
  ToolRegistryBuilder,
  type ToolCommittedEventNotifier,
  type ToolDispatchRequest,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from "@caelush/tools";
import { describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

const definition = {
  name: "echo_value",
  description: "Echo a value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  riskLevel: "LOW" as const,
  requiredCapabilities: [],
  runtimeRequirements: {},
};

function createDispatcher(
  storage: CaelushStorage,
  execute: (request: ToolExecutionRequest) => Promise<ToolExecutionResult>,
  eventBus: EventBus,
): ToolDispatcher {
  const registry = new ToolRegistryBuilder().register({ definition, handler: { execute } }).build();
  const notifier: ToolCommittedEventNotifier = {
    notifyCommitted(events) {
      eventBus.notifyCommitted(events);
    },
  };
  let timestamp = 200;
  return new ToolDispatcher({
    registry,
    store: storage.toolExecution,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier,
    clock: { now: () => createTimestampMs(++timestamp) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
}

async function createFixture(databasePath: string) {
  const storage = await openCaelushStorage({ path: databasePath });
  const session = makeSession({ id: createSessionId() });
  const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(101) });
  const step = makeStep(run.id, {
    status: "COMPLETED",
    finishedAt: createTimestampMs(102),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  await storage.steps.insert(step);
  return { storage, session, run, step };
}

describe("ToolDispatcher with durable storage and EventBus", () => {
  it("persists and publishes lifecycle events before invoking and after settling", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-tool-dispatcher-"));
    const databasePath = path.join(directory, "caelush.db");
    const { storage, session, run, step } = await createFixture(databasePath);
    const eventBus = new EventBus(storage.events);
    const notified: string[] = [];
    const unsubscribe = eventBus.subscribe(run.id, (event) => notified.push(event.type));
    try {
      const before = {
        session: await storage.sessions.get(session.id),
        run: await storage.runs.get(run.id),
        step: await storage.steps.get(step.id),
        state: await storage.runStates.get(run.id),
        messages: await storage.messages.listByRun(run.id),
        continuation: await storage.continuations.get(run.id),
      };
      const request: ToolDispatchRequest = {
        sessionId: session.id,
        runId: run.id,
        stepId: step.id,
        externalCallId: "call-integration-1",
        toolName: "echo_value",
        args: { value: "hello" },
        environment: { workspace: run.workspace, runtime: run.runtime },
      };
      const dispatcher = createDispatcher(
        storage,
        async (handlerRequest) => {
          const running = await storage.toolExecution.findByExternalCall(
            run.id,
            step.id,
            handlerRequest.externalCallId,
          );
          expect(running?.invocation.status).toBe("RUNNING");
          expect((await storage.events.replay(run.id)).map((event) => event.type)).toEqual([
            "tool.requested",
            "tool.started",
          ]);
          return { content: "hello", details: { echoed: "hello" }, isError: false };
        },
        eventBus,
      );

      const outcome = await dispatcher.dispatch(request);

      expect(outcome.kind).toBe("RESULT");
      expect(notified).toEqual(["tool.requested", "tool.started", "tool.completed"]);
      expect((await storage.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
        "COMPLETED",
      ]);
      expect((await storage.observations.listByRun(run.id)).map((item) => item.isError)).toEqual([
        false,
      ]);
      expect((await storage.events.replay(run.id)).map((event) => event.type)).toEqual([
        "tool.requested",
        "tool.started",
        "tool.completed",
      ]);
      expect(await storage.sessions.get(session.id)).toEqual(before.session);
      expect(await storage.runs.get(run.id)).toEqual(before.run);
      expect(await storage.steps.get(step.id)).toEqual(before.step);
      expect(await storage.runStates.get(run.id)).toEqual(before.state);
      expect(await storage.messages.listByRun(run.id)).toEqual(before.messages);
      expect(await storage.continuations.get(run.id)).toEqual(before.continuation);
      expect(notified.filter((type) => type === "tool.output")).toHaveLength(0);
    } finally {
      unsubscribe();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a terminal invocation after restart without executing the handler again", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-tool-restart-"));
    const databasePath = path.join(directory, "caelush.db");
    const fixture = await createFixture(databasePath);
    const request: ToolDispatchRequest = {
      sessionId: fixture.session.id,
      runId: fixture.run.id,
      stepId: fixture.step.id,
      externalCallId: "call-restart-1",
      toolName: "echo_value",
      args: { value: "restart" },
      environment: { workspace: fixture.run.workspace, runtime: fixture.run.runtime },
    };
    let executions = 0;
    try {
      const firstBus = new EventBus(fixture.storage.events);
      const first = createDispatcher(
        fixture.storage,
        async () => {
          executions += 1;
          return { content: "restart", details: { echoed: "restart" }, isError: false };
        },
        firstBus,
      );
      await first.dispatch(request);
      await fixture.storage.close();

      const restarted = await openCaelushStorage({ path: databasePath });
      try {
        const secondBus = new EventBus(restarted.events);
        const second = createDispatcher(
          restarted,
          async () => {
            executions += 1;
            return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
          },
          secondBus,
        );
        const outcome = await second.dispatch(request);

        expect(outcome.kind).toBe("RESULT");
        expect(executions).toBe(1);
        expect(
          (await restarted.events.replay(fixture.run.id)).map((event) => event.durability.sequence),
        ).toEqual([1, 2, 3]);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
