import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionId, createTimestampMs, type RunId, type StepId } from "@caelush/protocol";
import { EventBus } from "./support/test-event-notifier.js";
import {
  DefaultAgentToolRegistryBuilder,
  type AgentTool,
  type AgentToolRegistry,
  type PreparedToolCall,
  type ToolAdmissionPort,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";
import { createCanonicalToolRuntime } from "./support/canonical-tool-runtime.js";

/**
 * The canonical durable Tool execution boundary, over real SQLite and a real EventBus.
 *
 * ```text
 * ToolCallPreparer                  resolve, normalize and validate          @caelush/agent
 *        ↓
 * DurableToolExecutionCoordinator   the Tool Invocation Lifecycle Authority  @caelush/agent
 *   ① REQUESTED committed durably + tool.requested published
 *   ② ToolAdmissionCoordinator (allow-all policy port)
 *   ③ RUNNING committed durably + tool.started published, BEFORE the handler runs
 *   ④ ToolInvocationExecutor → AgentTool.execute
 *   ⑤ ToolResultPipeline
 *   ⑥ terminal invocation + observation + tool.completed, atomically
 * ```
 *
 * Phase 4F retired the legacy `ToolDispatcher`, whose integration test this suite replaces. The
 * behaviour it asserts is unchanged; it is now measured against the canonical lifecycle authority: the
 * durable ordering (`REQUESTED` before admission, `RUNNING` before the handler), the atomic terminal
 * settlement, the exact committed-event sequence, and restart recovery that never re-runs a Tool which
 * already has a durable answer.
 */

const echoTool = (execute: AgentTool["execute"]): AgentTool => ({
  name: "echo_value",
  description: "Echo a value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  label: "Echo value",
  resultDetailsSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  executionMode: "SEQUENTIAL",
  execute,
});

function registryWith(execute: AgentTool["execute"]): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register(echoTool(execute));
  return builder.build();
}

/** One Running Run with a Completed source Step, which is what a Tool execution requires. */
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

function prepared(
  runtime: ReturnType<typeof createCanonicalToolRuntime>,
  externalCallId: string,
  value: string,
): PreparedToolCall {
  return runtime.prepare({ externalCallId, toolName: "echo_value", args: { value } });
}

/**
 * Read the durable ledger while admission runs — after the `REQUESTED` commit and before the `RUNNING`
 * one — so the ordering claim is measured against storage rather than assumed.
 */
function admissionProbe(input: {
  readonly storage: Awaited<ReturnType<typeof createFixture>>["storage"];
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly externalCallId: string;
  readonly observed: { value?: string | undefined };
}): ToolAdmissionPort {
  return {
    async evaluate() {
      const existing = await input.storage.toolExecution.findByExternalCall(
        input.runId,
        input.sourceStepId,
        input.externalCallId,
      );
      input.observed.value = existing?.invocation.status;
      return { kind: "ALLOW" as const };
    },
  };
}

describe("DurableToolExecutionCoordinator with durable storage and EventBus", () => {
  it("persists and publishes lifecycle events before invoking and after settling", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-tool-coordinator-"));
    const databasePath = path.join(directory, "caelush.db");
    const { storage, session, run, step } = await createFixture(databasePath);
    const eventBus = new EventBus(storage.eventReader);
    const notified: string[] = [];
    const unsubscribe = eventBus.subscribe(run.id, (event) => notified.push(event.type));
    try {
      const before = {
        session: await storage.sessions.get(session.id),
        run: await storage.runs.get(run.id),
        step: await storage.steps.get(step.id),
        state: await storage.runStates.get(run.id),
        messages: await storage.messageRecords.listByRun(run.id),
        continuation: await storage.continuations.get(run.id),
      };
      const durableStatusAtAdmission: { value?: string | undefined } = {};
      let executions = 0;
      const registry = registryWith(async ({ identity, args }) => {
        executions += 1;
        // The RUNNING checkpoint is durable before the handler begins, and the two lifecycle events
        // are already published: a crash inside this handler is an uncertain side effect, never a
        // silently re-runnable call.
        const running = await storage.toolExecution.findByExternalCall(
          run.id,
          step.id,
          identity.externalCallId,
        );
        expect(running?.invocation.status).toBe("RUNNING");
        expect(
          (
            await storage.eventReader.replay(run.id, {
              afterSequence: 0,
              throughSequence: Number.MAX_SAFE_INTEGER,
              limit: 1000,
            })
          ).map((event) => event.type),
        ).toEqual(["tool.requested", "tool.started"]);
        return {
          content: String(args.value),
          details: { echoed: String(args.value) },
          isError: false,
        };
      });
      const runtime = createCanonicalToolRuntime({
        storage,
        registry,
        notifier: eventBus,
        policy: admissionProbe({
          storage,
          runId: run.id,
          sourceStepId: step.id,
          externalCallId: "call-integration-1",
          observed: durableStatusAtAdmission,
        }),
      });
      const call = prepared(runtime, "call-integration-1", "hello");

      const outcome = await runtime.coordinator.execute({
        runId: run.id,
        sessionId: session.id,
        sourceStepId: step.id,
        call,
        environment: { workspace: run.workspace, runtime: run.runtime },
        securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
        signal: new AbortController().signal,
      });

      expect(outcome.kind).toBe("SETTLED");
      expect(executions).toBe(1);
      // The `REQUESTED` row was durable before admission ran.
      expect(durableStatusAtAdmission.value).toBe("REQUESTED");
      expect(notified).toEqual(["tool.requested", "tool.started", "tool.completed"]);
      expect((await storage.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
        "COMPLETED",
      ]);
      expect((await storage.observations.listByRun(run.id)).map((item) => item.isError)).toEqual([
        false,
      ]);
      // The terminal invocation and its observation settled together: one snapshot carries both.
      const settled = await storage.toolExecution.load(outcome.invocation.id);
      expect(settled?.invocation.status).toBe("COMPLETED");
      expect(settled?.observation?.content).toBe("hello");
      expect(
        (
          await storage.eventReader.replay(run.id, {
            afterSequence: 0,
            throughSequence: Number.MAX_SAFE_INTEGER,
            limit: 1000,
          })
        ).map((event) => event.type),
      ).toEqual(["tool.requested", "tool.started", "tool.completed"]);
      expect(await storage.sessions.get(session.id)).toEqual(before.session);
      expect(await storage.runs.get(run.id)).toEqual(before.run);
      expect(await storage.steps.get(step.id)).toEqual(before.step);
      expect(await storage.runStates.get(run.id)).toEqual(before.state);
      expect(await storage.messageRecords.listByRun(run.id)).toEqual(before.messages);
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
    const externalCallId = "call-restart-1";
    let executions = 0;
    try {
      const firstBus = new EventBus(fixture.storage.eventReader);
      const firstRegistry = registryWith(async () => {
        executions += 1;
        return { content: "restart", details: { echoed: "restart" }, isError: false };
      });
      const first = createCanonicalToolRuntime({
        storage: fixture.storage,
        registry: firstRegistry,
        notifier: firstBus,
      });
      const request = {
        runId: fixture.run.id,
        sessionId: fixture.session.id,
        sourceStepId: fixture.step.id,
        call: prepared(first, externalCallId, "restart"),
        environment: { workspace: fixture.run.workspace, runtime: fixture.run.runtime },
        securityContext: {
          permissionProfile: "FULL_ACCESS" as const,
          approvalPolicy: "NEVER_ASK" as const,
        },
        signal: new AbortController().signal,
      };
      const firstOutcome = await first.coordinator.execute(request);
      expect(firstOutcome.kind).toBe("SETTLED");
      await fixture.storage.close();

      const restarted = await openCaelushStorage({ path: databasePath });
      try {
        const secondBus = new EventBus(restarted.eventReader);
        const secondRegistry = registryWith(async () => {
          executions += 1;
          return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
        });
        const second = createCanonicalToolRuntime({
          storage: restarted,
          registry: secondRegistry,
          notifier: secondBus,
        });

        const outcome = await second.coordinator.execute({
          ...request,
          call: prepared(second, externalCallId, "restart"),
        });

        expect(outcome.kind).toBe("SETTLED");
        expect(executions).toBe(1);
        // The durable answer is the one committed before the restart, not a recomputation.
        if (outcome.kind !== "SETTLED") throw new Error("expected a settled outcome");
        expect(outcome.observation.content).toBe("restart");
        expect(
          (
            await restarted.eventReader.replay(fixture.run.id, {
              afterSequence: 0,
              throughSequence: Number.MAX_SAFE_INTEGER,
              limit: 1000,
            })
          ).map((event) => event.durability.sequence),
        ).toEqual([1, 2, 3]);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
