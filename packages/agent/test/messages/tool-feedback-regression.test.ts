import { describe, expect, it } from "vitest";

import {
  NO_TOOL_RESULT_OBSERVATION,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
  createModelToolFeedbackProjector,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  projectionVersionTable,
  toolFeedbackPolicySnapshot,
  toolMessageSource,
  toolResultObservation,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  SKIPPED_AFTER_UNCERTAIN_EXECUTION,
  UNCERTAIN_SIDE_EFFECT,
} from "@caelush/agent";
import type {
  AgentMessageRecord,
  AgentToolResultMessage,
  ToolBatchItemOutcome,
  ToolFeedbackProjectionReceipt,
} from "@caelush/agent";

import { CREATED_AT, OBSERVATION_ID, RUN_ID, SESSION_ID, turnIdFor } from "./fixtures.js";
import { createAgentMessageBase, createAgentToolResultMessage } from "@caelush/agent";

/**
 * Phase 5B — the regression that proves *why* the errata was necessary.
 *
 * The Freeze previously implied that every model-visible Tool Result has a `ToolObservation`. This
 * suite runs the **real** Tool System projector over the **real** outcome kinds and shows that two
 * of the three produce model-visible feedback with no execution behind them.
 *
 * It is a regression test in the strict sense: if a future change made `REJECTED` or `SKIPPED`
 * observe-backed, or made the corrected Message contract unable to carry them, this fails.
 */

const POLICY = toolFeedbackPolicySnapshot({
  maxSingleObservationTokens: 1000,
  maxObservationBatchTokens: 4000,
});

const RECEIPT: ToolFeedbackProjectionReceipt = {
  policy: POLICY,
  fingerprint: "regression-fingerprint",
  version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
};

const CALL = { externalCallId: "call_rejected", toolName: "exec_command", args: { command: "ls" } };

const projector = createModelToolFeedbackProjector();

/** Turn one real batch item into the Agent Tool Result Message a Phase 5C writer would create. */
function toToolResultMessage(
  item: ToolBatchItemOutcome,
  observationBacked: boolean,
): AgentToolResultMessage {
  const projected = projector.project({
    calls: [CALL],
    items: [item],
    policy: { maxSingleObservationTokens: 1000, maxObservationBatchTokens: 4000 },
  });
  const message = projected[0];
  if (message === undefined) throw new Error("the projector produced no Tool result");

  return createAgentToolResultMessage(
    createAgentMessageBase({
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-0000000000f1" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      createdAt: CREATED_AT as never,
      source: toolMessageSource(),
      audience: { model: true, transcript: false, debug: true },
    }),
    {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      // A pre-execution rejection and an uncertain skip never reached a handler, so there is no
      // observation to name. The arm states that rather than inventing an identity.
      observation: observationBacked
        ? toolResultObservation(OBSERVATION_ID as never)
        : NO_TOOL_RESULT_OBSERVATION,
      isError: message.isError,
      projectedContent: message.content,
      projection: RECEIPT,
    },
  );
}

describe("Phase 5B regression — the Tool System produces non-observation feedback", () => {
  it("projects a REJECTED call to model-visible feedback with no observation", () => {
    const item: ToolBatchItemOutcome = {
      kind: "REJECTED",
      call: CALL,
      feedback: {
        code: "TOOL_ARGUMENT_ERROR",
        content: "the command argument is missing",
        details: {},
        disposition: "SAFE_FAILURE",
      },
    };

    const projected = projector.project({
      calls: [CALL],
      items: [item],
      policy: { maxSingleObservationTokens: 1000, maxObservationBatchTokens: 4000 },
    });

    // The Tool System's own output: one model-visible Tool result, and no invocation was created.
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      role: "tool",
      toolCallId: "call_rejected",
      toolName: "exec_command",
      content: "the command argument is missing",
      isError: true,
    });

    // The corrected contract carries it: NO_OBSERVATION + SNAPSHOT.
    const message = toToolResultMessage(item, false);
    expect(message.observation).toEqual({ kind: "NO_OBSERVATION" });
    expect(message.projection.policy.kind).toBe("SNAPSHOT");
    expect(message.isError).toBe(true);
  });

  it("projects a SKIPPED call after an uncertain execution to model-visible feedback", () => {
    const item: ToolBatchItemOutcome = {
      kind: "SKIPPED",
      call: CALL,
      feedback: {
        code: SKIPPED_AFTER_UNCERTAIN_EXECUTION,
        content: "skipped because a previous Tool's side effect could not be determined",
        details: { disposition: UNCERTAIN_SIDE_EFFECT },
        disposition: "UNCERTAIN_SIDE_EFFECT",
      },
    };

    const projected = projector.project({
      calls: [CALL],
      items: [item],
      policy: { maxSingleObservationTokens: 1000, maxObservationBatchTokens: 4000 },
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.isError).toBe(true);

    const message = toToolResultMessage(item, false);
    expect(message.observation.kind).toBe("NO_OBSERVATION");
    expect(message.projectedContent).toBe(projected[0]?.content);
  });

  it("keeps the executed OBSERVATION path observation-backed", () => {
    // The errata must not weaken the executed case: a result that came from a settled observation
    // still names it.
    const item: ToolBatchItemOutcome = {
      kind: "OBSERVATION",
      call: CALL,
      invocationId: "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9e" as never,
      observation: {
        id: OBSERVATION_ID as never,
        toolInvocationId: "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9e" as never,
        runId: RUN_ID as never,
        stepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e01" as never,
        kind: "TOOL",
        isError: false,
        content: "real output",
        createdAt: CREATED_AT as never,
        protocolVersion: 1,
      },
    } as unknown as ToolBatchItemOutcome;

    const message = toToolResultMessage(item, true);
    expect(message.observation).toEqual({
      kind: "OBSERVATION",
      observationId: OBSERVATION_ID,
    });
    expect(message.isError).toBe(false);
  });

  it("round-trips both non-observation and observation feedback through the codec", () => {
    const codecs = createStandardAgentMessageCodecRegistry(
      projectionVersionTable({ TOOL_RESULT: 1 }),
    );
    const rejected: ToolBatchItemOutcome = {
      kind: "REJECTED",
      call: CALL,
      feedback: {
        code: "TOOL_NOT_AVAILABLE",
        content: "no such tool",
        details: {},
        disposition: "SAFE_FAILURE",
      },
    };
    const message = toToolResultMessage(rejected, false);

    const draft = codecs.encode(message);
    const record: AgentMessageRecord = {
      messageId: message.id,
      runId: message.runId,
      sessionId: message.sessionId,
      sequence: 1,
      conversationTurnId: message.conversationTurnId,
      messageType: "TOOL_RESULT",
      schemaVersion: draft.schemaVersion,
      modelProjectionVersion: draft.modelProjectionVersion as number,
      createdAt: message.createdAt,
      source: message.source,
      audience: message.audience,
      // `AgentMessageDraft.message` is the codec's encoded payload, not the semantic message. The
      // field name reads as the latter, which is a known awkwardness the repository layer will
      // document explicitly rather than compound.
      data: draft.message as unknown as AgentMessageRecord["data"],
    };
    expect(codecs.decode(record)).toEqual(message);
    expect(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.canDecode(1)).toBe(true);
  });

  it("projects the non-observation result to the same model view as an observed one", () => {
    // The whole justification for recording NO_OBSERVATION honestly: it changes nothing the model
    // sees, so it cannot alter replay.
    const projectors = createStandardAgentMessageProjectorRegistry();
    const rejected: ToolBatchItemOutcome = {
      kind: "REJECTED",
      call: CALL,
      feedback: {
        code: "TOOL_ARGUMENT_ERROR",
        content: "same content",
        details: {},
        disposition: "SAFE_FAILURE",
      },
    };
    const message = toToolResultMessage(rejected, false);
    const projection = projectors.project({
      sequence: 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message,
    });
    expect(projection.messages).toEqual([
      {
        role: "tool",
        toolCallId: "call_rejected",
        toolName: "exec_command",
        content: "same content",
        isError: true,
      },
    ]);

    // The observed variant of the same text projects to the identical model view, which is what
    // makes recording NO_OBSERVATION a change to *provenance* and never to history.
    const observed = createAgentToolResultMessage(
      createAgentMessageBase({
        id: "amsg_0192f5b1-4d3a-7c2e-8a91-0000000000f2" as never,
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        createdAt: CREATED_AT as never,
        source: toolMessageSource(),
        audience: { model: true, transcript: false, debug: true },
      }),
      {
        toolCallId: "call_rejected",
        toolName: "exec_command",
        observation: toolResultObservation(OBSERVATION_ID as never),
        isError: true,
        projectedContent: "same content",
        projection: RECEIPT,
      },
    );
    expect(
      projectors.project({
        sequence: 1,
        schemaVersion: 1,
        modelProjectionVersion: 1,
        message: observed,
      }),
    ).toEqual(projection);
  });
});
