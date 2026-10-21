import { describe, expect, it } from "vitest";
import {
  RunIdSchema,
  StepIdSchema,
  ToolInvocationSchema,
  ToolObservationSchema,
  createRunId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import type { ContextSourceInput } from "@caelush/agent";
import { createWorkCommentaryContextProvider } from "../src/context/work-commentary-context-provider.js";

const runId = RunIdSchema.parse(createRunId());
const stepCompleted = StepIdSchema.parse(createStepId());
const stepFailed = StepIdSchema.parse(createStepId());
const invocationId = createToolInvocationId();

describe("Work Commentary semantic identity", () => {
  it("keeps one Run-scoped identity across eight Steps and emits changed validated progress", async () => {
    const completed = ToolInvocationSchema.parse({
      id: invocationId,
      runId,
      stepId: stepCompleted,
      externalCallId: "call_completed",
      toolName: "read_file",
      args: { path: "login.html", secret: "must-not-leak" },
      riskLevel: "LOW",
      status: "COMPLETED",
      createdAt: 1,
      finishedAt: 2,
    });
    const failed = ToolInvocationSchema.parse({
      id: createToolInvocationId(),
      runId,
      stepId: stepFailed,
      externalCallId: "call_failed",
      toolName: "apply_patch",
      args: { patch: "must-not-leak" },
      riskLevel: "MEDIUM",
      status: "FAILED",
      createdAt: 3,
      finishedAt: 4,
    });
    const completedObservation = ToolObservationSchema.parse({
      id: "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      kind: "TOOL",
      runId,
      stepId: stepCompleted,
      toolInvocationId: completed.id,
      content: "large tool output must stay in conversation history",
      details: { secret: "must-not-leak" },
      isError: false,
      createdAt: 2,
    });
    const failedObservation = ToolObservationSchema.parse({
      id: "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b",
      kind: "TOOL",
      runId,
      stepId: stepFailed,
      toolInvocationId: failed.id,
      content: "failure output must stay in conversation history",
      details: { secret: "must-not-leak" },
      isError: true,
      createdAt: 4,
    });
    const invocations = new Map([
      [completed.id, completed],
      [failed.id, failed],
    ]);
    const observations = new Map([
      [completedObservation.id, completedObservation],
      [failedObservation.id, failedObservation],
    ]);
    const provider = createWorkCommentaryContextProvider({
      storage: {
        observations: {
          async get(id) {
            return observations.get(id) ?? null;
          },
        },
        toolInvocations: {
          async get(id) {
            return invocations.get(id) ?? null;
          },
        },
        verification: {
          async getLatestPlan() {
            return null;
          },
        },
      },
    });
    const commentary = {
      type: "ASSISTANT",
      runId,
      phase: "COMMENTARY",
      content: [{ type: "TEXT", text: "I have started inspecting the project." }],
    };
    const unchanged = [] as const;

    const first = await provider.collect(
      input(stepCompleted, [{ sequence: 1, message: commentary }]),
    );
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      const next = await provider.collect(
        input(createStepId(), [{ sequence: 1, message: commentary }, ...unchanged]),
      );
      expect(next.items[0]?.id).toBe(first.items[0]?.id);
      expect(next.items[0]?.payload).toEqual(first.items[0]?.payload);
      expect(next.items[0]?.source.sourceRef).not.toBe(first.items[0]?.source.sourceRef);
    }
    expect(first.items[0]?.id).toBe(`daemon.work-commentary-state:${runId}:current`);
    expect(first.items[0]?.payload.kind === "TEXT" && first.items[0].payload.text).not.toContain(
      "must-not-leak",
    );

    const withCompleted = await provider.collect(
      input(stepCompleted, [
        { sequence: 1, message: commentary },
        {
          sequence: 2,
          message: toolResult(runId, stepCompleted, completedObservation.id, "read_file"),
        },
      ]),
    );
    const withFailed = await provider.collect(
      input(stepFailed, [
        { sequence: 1, message: commentary },
        {
          sequence: 2,
          message: toolResult(runId, stepCompleted, completedObservation.id, "read_file"),
        },
        {
          sequence: 3,
          message: toolResult(runId, stepFailed, failedObservation.id, "apply_patch"),
        },
      ]),
    );

    expect(withCompleted.items[0]?.id).toBe(first.items[0]?.id);
    expect(withFailed.items[0]?.id).toBe(first.items[0]?.id);
    expect(withCompleted.items[0]?.payload).not.toEqual(withFailed.items[0]?.payload);
    expect(withFailed.items[0]?.payload).toMatchObject({
      kind: "TEXT",
      text: expect.stringContaining("apply_patch: failed"),
    });
    expect(
      withFailed.items[0]?.payload.kind === "TEXT" && withFailed.items[0].payload.text,
    ).not.toContain("must-not-leak");

    const anotherRunId = createRunId();
    const anotherRun = await provider.collect(
      input(
        createStepId(),
        [{ sequence: 1, message: { ...commentary, runId: anotherRunId } }],
        anotherRunId,
      ),
    );
    expect(anotherRun.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  /**
   * A completed observation is not news.
   *
   * The Section is replaced as a whole, so listing each validated result rewrote it on every Step for
   * a list the model can already read in the conversation. Twenty more completions must leave the
   * text byte-identical, and the block must stay small enough that a change it does make is cheap.
   */
  it("keeps the commentary byte-identical while completed observations accumulate", async () => {
    const invocations = new Map<string, unknown>();
    const observations = new Map<string, unknown>();
    const results: { sequence: number; message: unknown }[] = [];
    for (let index = 0; index < 20; index += 1) {
      const invocation = ToolInvocationSchema.parse({
        id: createToolInvocationId(),
        runId,
        stepId: stepCompleted,
        externalCallId: `call_${String(index)}`,
        toolName: "read_file",
        args: { path: `file-${String(index)}.ts` },
        riskLevel: "LOW",
        status: "COMPLETED",
        createdAt: 1,
        finishedAt: 2,
      });
      const observation = ToolObservationSchema.parse({
        id: `obs_0192f5b1-4d3a-7c2e-8a91-${String(index).padStart(12, "0")}`,
        kind: "TOOL",
        runId,
        stepId: stepCompleted,
        toolInvocationId: invocation.id,
        content: `output ${String(index)}`,
        isError: false,
        createdAt: 2,
      });
      invocations.set(invocation.id, invocation);
      observations.set(observation.id, observation);
      results.push({
        sequence: 2 + index,
        message: toolResult(runId, stepCompleted, observation.id, "read_file"),
      });
    }
    const provider = createWorkCommentaryContextProvider({
      storage: {
        observations: {
          async get(id) {
            return (observations.get(id) as never) ?? null;
          },
        },
        toolInvocations: {
          async get(id) {
            return (invocations.get(id) as never) ?? null;
          },
        },
        verification: {
          async getLatestPlan() {
            return null;
          },
        },
      },
    });
    const commentary = {
      type: "ASSISTANT",
      runId,
      phase: "COMMENTARY",
      content: [{ type: "TEXT", text: "Started." }],
    };

    const early = await provider.collect(
      input(stepCompleted, [{ sequence: 1, message: commentary }, ...results.slice(0, 1)]),
    );
    const late = await provider.collect(
      input(stepCompleted, [{ sequence: 1, message: commentary }, ...results]),
    );

    expect(late.items[0]?.payload).toEqual(early.items[0]?.payload);
    const text = late.items[0]?.payload.kind === "TEXT" ? late.items[0].payload.text : "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
  });
});

function input(
  stepId: ReturnType<typeof createStepId>,
  messages: readonly { readonly sequence: number; readonly message: unknown }[],
  scopedRunId: ReturnType<typeof createRunId> = runId,
): ContextSourceInput {
  const scopedMessages = messages.map(({ sequence, message }) => ({ sequence, message }));
  return {
    identity: {
      runId: scopedRunId,
      sessionId: "session_c2_test" as never,
      goal: "inspect project",
    },
    turn: { stepId, sequence: 1 },
    conversation: { turns: [{ messages: scopedMessages }] },
    signal: new AbortController().signal,
  } as unknown as ContextSourceInput;
}

function toolResult(
  scopedRunId: ReturnType<typeof createRunId>,
  sourceStepId: ReturnType<typeof createStepId>,
  observationId: string,
  toolName: string,
): unknown {
  return {
    type: "TOOL_RESULT",
    runId: scopedRunId,
    sourceStepId,
    observation: { kind: "OBSERVATION", observationId },
    toolName,
  };
}
