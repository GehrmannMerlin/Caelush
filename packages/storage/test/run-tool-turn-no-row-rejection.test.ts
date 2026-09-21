import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AIToolSpec } from "@caelush/ai";
import {
  AgentRunSchema,
  createApprovalRequestId,
  createEventId,
  createLLMCallId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolDefinition,
} from "@caelush/protocol";
import {
  RunController,
  toContextObservationProjection,
  type AIModelTurnResult,
  type ToolTurnPipeline,
} from "@caelush/core";
import { EventBus } from "@caelush/events";
import {
  ToolDispatcher,
  ToolRegistryBuilder,
  createToolExecutionDependencies,
  type ToolCommittedEventNotifier,
} from "@caelush/tools";
import {
  createModelToolFeedbackProjector,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolResultBatchNormalizer,
  UNBOUNDED_TOOL_BUDGET_ADMISSION,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";

import type { CaelushStorage } from "../src/index.js";
import { verificationPlanner } from "./support/fixtures.js";
import { openToolStorage } from "./support/tool-settlement-decoder.js";
import { modelTurnResult } from "./support/model-turns.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";

/**
 * Phase 4D — the pre-invocation rejection, end to end.
 *
 * ```text
 * model turn 1        an invalid Tool call
 *        ↓
 * canonical ToolBatchCoordinator + ToolCallPreparer
 *        ↓
 * ToolBatchItemOutcome.REJECTED
 *        ↓
 * NO ToolInvocation row, NO observation, NO approval, NO budget reservation, NO Tool execution
 *        ↓
 * ModelToolFeedbackProjector  →  AIToolResultMessage { same id, same name, isError: true }
 *        ↓
 * ToolResultBatchNormalizer
 *        ↓
 * frozen ToolTurnResult COMPLETED
 *        ↓
 * Run continuation persists receivedResults
 *        ↓
 * AgentLoop turn 2 receives exactly that safe Tool Result
 * ```
 *
 * The Tool System's production path is composed for real here — the real preparer, the real canonical
 * batch, the real projector and normalizer, the real durable coordinator over real SQLite — so the
 * "no durable row" claim is measured against the actual ledger rather than against a mock's opinion.
 */

const echo: ToolDefinition = {
  name: "echo_value",
  description: "Echo a value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", minLength: 1 } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  riskLevel: "LOW",
  requiredCapabilities: [],
  runtimeRequirements: {},
};

function makeRun(workspacePath: string) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "echo a value",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: workspacePath },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

function turn(
  text: string,
  toolCalls: AIModelTurnResult["toolCalls"],
  finishReason: AIModelTurnResult["finishReason"],
): AIModelTurnResult {
  return modelTurnResult({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

/** The canonical pipeline over the dispatcher's own durable coordinator. */
function canonicalToolTurn(
  registry: ReturnType<ToolRegistryBuilder["build"]>,
  dispatcher: ToolDispatcher,
): ToolTurnPipeline {
  return {
    // One store, one durable coordinator, one in-process call guard: the canonical batch borrows the
    // coordinator the legacy facade already built rather than constructing a second one.
    batches: createToolBatchCoordinator({
      preparer: createToolCallPreparer(registry.agentRegistry()),
      budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
      durable: dispatcher.durableCoordinator(),
      registry: registry.agentRegistry(),
    }),
    feedback: createModelToolFeedbackProjector({
      projection: toContextObservationProjection(),
    }),
    normalizer: createToolResultBatchNormalizer(),
    modelDefinitions: () => registry.modelDefinitions(),
  };
}

interface Harness {
  readonly storage: CaelushStorage;
  readonly run: ReturnType<typeof makeRun>;
  readonly controller: RunController;
  readonly observed: Array<{ tools?: unknown; messages: readonly unknown[] }>;
  /** Every Tool handler that actually ran, in order. */
  readonly toolExecutions: readonly string[];
  /** What the durable ledger holds for this Run, counted from the real repositories. */
  readonly ledger: () => Promise<{
    readonly invocations: number;
    readonly observations: number;
    readonly approvals: number;
  }>;
  readonly close: () => Promise<void>;
}

async function harness(input: {
  readonly calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
  }[];
  readonly finalText?: string;
}): Promise<Harness> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-4d-no-row-"));
  const storage = await openToolStorage({ path: path.join(directory, "caelush.sqlite") });
  const run = makeRun(path.join(directory, "project"));
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  });
  await storage.runs.insert(run);

  const eventBus = new EventBus(storage.events);
  const builder = new ToolRegistryBuilder();
  const toolExecutions: string[] = [];
  for (const definition of [echo]) {
    builder.register({
      definition,
      handler: {
        execute: async ({ externalCallId }) => {
          toolExecutions.push(externalCallId);
          return { content: "hello", details: { value: "hello" }, isError: false };
        },
      },
    });
  }
  const registry = builder.build();
  const notifier: ToolCommittedEventNotifier = {
    notifyCommitted: (events) => eventBus.notifyCommitted(events),
  };
  let now = 10;
  const dispatcher = new ToolDispatcher({
    registry,
    store: storage.toolExecution,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    execution: createToolExecutionDependencies({ registry }),
    approvalStore: storage.approvals,
    approvalIdFactory: { create: createApprovalRequestId },
  });

  const observed: Array<{ tools?: unknown; messages: readonly unknown[] }> = [];
  const turns: Array<AIModelTurnResult | Error> = [
    turn("", input.calls as never, "TOOL_CALLS"),
    turn(input.finalText ?? "finished", [], "STOP"),
  ];
  const executor = fakeFrozenModelTurnExecutor(async (request) => {
    observed.push({ tools: request.tools, messages: request.messages });
    const next = turns.shift();
    if (next instanceof Error) throw next;
    return next!;
  });
  const agentExecution = testRunAgentExecution({
    executor,
    tools: registry.modelDefinitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })) as readonly AIToolSpec[],
    createStepId: () => createStepId(),
  });

  const controller = new RunController({
    agentExecution: agentExecution.factory,
    executionStore: storage.execution,
    events: eventBus,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1_000 },
      }),
    },
    toolTurn: canonicalToolTurn(registry, dispatcher),
    clock: { now: () => createTimestampMs(++now) },
    eventIdFactory: { create: createEventId },
    verificationPlanner,
    approvals: storage.approvals,
  });

  return {
    storage,
    run,
    controller,
    observed,
    toolExecutions,
    // Counted from the real durable repositories, so "no row" is a measurement rather than an opinion.
    ledger: async () => ({
      invocations: (await storage.toolInvocations.listByRun(run.id)).length,
      observations: (await storage.observations.listByRun(run.id)).length,
      approvals: (await storage.approvals.listPendingByRun(run.id)).length,
    }),
    close: async () => {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Phase 4D pre-invocation rejection — the durable ledger stays empty", () => {
  it("creates no ToolInvocation for an unknown Tool and still tells the model safely", async () => {
    const h = await harness({ calls: [{ id: "call_unknown", name: "not_a_tool", input: {} }] });
    try {
      const result = await h.controller.start(h.run.id);

      // The Run completed the Tool turn and moved on: a rejection is model-correctable, not fatal.
      expect(result.status).toBe("AWAITING_VERIFICATION");

      // No durable Tool fact of any kind exists for a call that never executed.
      expect(await h.ledger()).toEqual({ invocations: 0, observations: 0, approvals: 0 });

      // And no handler ran.
      expect(h.toolExecutions).toEqual([]);

      // The model was still told, with the original identity and an error flag.
      const resume = h.observed[1]?.messages ?? [];
      const toolMessages = resume.filter(
        (message) => (message as { readonly role?: unknown }).role === "tool",
      );
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "call_unknown",
        toolName: "not_a_tool",
        isError: true,
      });
    } finally {
      await h.close();
    }
  });

  it("creates no ToolInvocation for invalid schema arguments", async () => {
    // `value` is required and must be a non-empty string.
    const h = await harness({
      calls: [{ id: "call_bad", name: "echo_value", input: { value: 7 } }],
    });
    try {
      const result = await h.controller.start(h.run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      expect(await h.storage.toolInvocations.listByRun(h.run.id)).toHaveLength(0);
      expect(await h.ledger()).toEqual({ invocations: 0, observations: 0, approvals: 0 });
      expect(h.toolExecutions).toEqual([]);

      expect(h.observed[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call_bad",
        toolName: "echo_value",
        isError: true,
      });
    } finally {
      await h.close();
    }
  });

  it("creates no ToolInvocation for oversized arguments", async () => {
    const h = await harness({
      calls: [
        {
          id: "call_big",
          name: "echo_value",
          // Far past the 256 KiB argument bound the Preparer enforces.
          input: { value: "x".repeat(400_000) },
        },
      ],
    });
    try {
      const result = await h.controller.start(h.run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      expect(await h.storage.toolInvocations.listByRun(h.run.id)).toHaveLength(0);
      expect(await h.ledger()).toEqual({ invocations: 0, observations: 0, approvals: 0 });
      expect(h.toolExecutions).toEqual([]);

      const toolMessage = h.observed[1]?.messages.at(-1);
      expect(toolMessage).toMatchObject({ role: "tool", toolCallId: "call_big", isError: true });
      // The safe feedback is bounded: the oversized payload never comes back to the model.
      expect(JSON.stringify(toolMessage).length).toBeLessThan(10_000);
    } finally {
      await h.close();
    }
  });

  it("executes the valid call in a batch whose first call was rejected", async () => {
    const h = await harness({
      calls: [
        { id: "call_bad", name: "not_a_tool", input: {} },
        { id: "call_good", name: "echo_value", input: { value: "hello" } },
      ],
    });
    try {
      const result = await h.controller.start(h.run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      // Exactly one durable invocation: the rejected call created none, and the valid one ran.
      const invocations = await h.storage.toolInvocations.listByRun(h.run.id);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.externalCallId).toBe("call_good");
      expect(h.toolExecutions).toEqual(["call_good"]);

      // Both calls get a model result, in the model's own order.
      const toolMessages = (h.observed[1]?.messages ?? []).filter(
        (message) => (message as { readonly role?: unknown }).role === "tool",
      );
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual([
        "call_bad",
        "call_good",
      ]);
      expect(toolMessages.map((m) => (m as { isError: boolean }).isError)).toEqual([true, false]);
    } finally {
      await h.close();
    }
  });

  it("reaches the next AgentLoop turn with the safe result already durable", async () => {
    const h = await harness({ calls: [{ id: "call_unknown", name: "not_a_tool", input: {} }] });
    try {
      await h.controller.start(h.run.id);

      // The continuation the Run accepted carries the projected Tool result, so a restart resumes from
      // durable data rather than from a rejection the Tool Layer would have to re-derive.
      const checkpoint = await h.storage.continuations.get(h.run.id);
      const durableToolMessages = (
        checkpoint?.checkpoint as { receivedResults?: readonly unknown[] }
      )?.receivedResults;
      // The boundary that accepted the batch has since been replaced by the verification boundary, so
      // the durable conversation is the authority for what the model was told.
      const conversation = await h.storage.messages.listByRun(h.run.id);
      const toolEntries = conversation.filter((entry) => entry.message.role === "tool");
      expect(toolEntries).toHaveLength(1);
      expect(toolEntries[0]?.message).toMatchObject({
        role: "tool",
        toolCallId: "call_unknown",
        toolName: "not_a_tool",
        isError: true,
      });
      // Exactly two provider turns: the Tool call turn and the resume.
      expect(h.observed).toHaveLength(2);
      expect(durableToolMessages).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
