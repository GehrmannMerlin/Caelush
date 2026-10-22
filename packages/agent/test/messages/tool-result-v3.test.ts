import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V2,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V3,
  AGENT_TOOL_RESULT_MESSAGE_TRANSCRIPT_PROJECTOR,
  AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1,
  AgentMessageCodecError,
  createAgentToolResultMessage,
  createAgentMessageBase,
  type AgentMessageRecord,
  type AgentToolResultMessage,
  type ToolPreparationFailureFact,
} from "@caelush/agent";

import { CREATED_AT, OBSERVATION_ID, RECEIPT, RUN_ID, SESSION_ID, turnIdFor } from "./fixtures.js";

/**
 * TOOL_RESULT schema V3 - the bounded preparation-failure fact.
 *
 * V1 recorded a Tool result with no images. V2 added image references. V3 adds one optional fact
 * that exists only for a call the Preparer refused, so the resource layer can recognise a repeated
 * schema mistake without reading the text the model was shown. Older rows must decode exactly as
 * they did, and the model must never see the new fact.
 */

const FACT: ToolPreparationFailureFact = Object.freeze({
  kind: "PREPARATION_REJECTED" as const,
  code: "TOOL_ARGUMENT_ERROR",
  issues: Object.freeze([
    Object.freeze({ keyword: "required", property: "patch" }),
    Object.freeze({ keyword: "additionalProperties", property: "input" }),
  ]),
  disposition: "SAFE_FAILURE" as const,
  classifierVersion: 1 as const,
});

function message(
  overrides: {
    readonly observationBacked?: boolean;
    readonly preparationFailure?: ToolPreparationFailureFact;
  } = {},
): AgentToolResultMessage {
  return createAgentToolResultMessage(
    createAgentMessageBase({
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-0000000000aa" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      createdAt: CREATED_AT as never,
      source: { kind: "TOOL", detail: "fixture" } as never,
      audience: { model: true, transcript: false, debug: true },
    }),
    {
      toolCallId: "call_1",
      toolName: "apply_patch",
      observation:
        overrides.observationBacked === false
          ? { kind: "NO_OBSERVATION" as const }
          : { kind: "OBSERVATION" as const, observationId: OBSERVATION_ID as never },
      isError: true,
      projectedContent: "Arguments for apply_patch do not match its declared input schema.",
      projection: RECEIPT,
      ...(overrides.preparationFailure === undefined
        ? {}
        : { preparationFailure: overrides.preparationFailure }),
    },
  );
}

function recordFor(
  value: AgentToolResultMessage,
  data: AgentMessageRecord["data"],
  schemaVersion: number,
): AgentMessageRecord {
  return {
    messageId: value.id,
    runId: value.runId,
    sessionId: value.sessionId,
    sequence: 7,
    conversationTurnId: value.conversationTurnId,
    messageType: "TOOL_RESULT",
    schemaVersion,
    sourceStepId: value.sourceStepId,
    createdAt: value.createdAt,
    source: value.source,
    audience: value.audience,
    data,
  };
}

describe("TOOL_RESULT schema V3 preparation-failure facts", () => {
  it("round-trips the fact without changing the model-visible text", () => {
    const original = message({ observationBacked: false, preparationFailure: FACT });
    const encoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.encode(original);
    const decoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.decode(recordFor(original, encoded, 3));

    expect(decoded.preparationFailure).toEqual(FACT);
    expect(decoded.projectedContent).toBe(original.projectedContent);
    // The model projection is still exactly the stored text.
    const projection = AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1.project(decoded);
    expect(JSON.stringify(projection)).toContain(original.projectedContent);
    expect(JSON.stringify(projection)).not.toContain("TOOL_ARGUMENT_ERROR");
    // The transcript never carries internal failure metadata.
    const transcript = AGENT_TOOL_RESULT_MESSAGE_TRANSCRIPT_PROJECTOR.project({
      sequence: 7,
      schemaVersion: 3,
      message: decoded,
    });
    expect(JSON.stringify(transcript)).not.toContain("PREPARATION_REJECTED");
    expect(JSON.stringify(transcript)).not.toContain("classifierVersion");
  });

  it("keeps V1 and V2 rows decoding exactly as before", () => {
    const v1Message = message();
    const v1 = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode(
      recordFor(v1Message, AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(v1Message), 1),
    );
    expect(v1.preparationFailure).toBeUndefined();
    expect(v1.attachmentReferences).toEqual([]);

    const v2Message = message();
    const v2 = AGENT_TOOL_RESULT_MESSAGE_CODEC_V2.decode(
      recordFor(v2Message, AGENT_TOOL_RESULT_MESSAGE_CODEC_V2.encode(v2Message), 2),
    );
    expect(v2.preparationFailure).toBeUndefined();
    expect(v2.projectedContent).toBe(v2Message.projectedContent);
  });

  it("refuses an unknown schema version instead of guessing", () => {
    const value = message();
    expect(() =>
      AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.decode(
        recordFor(value, AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.encode(value), 4),
      ),
    ).toThrow(AgentMessageCodecError);
  });

  it("refuses a fact on a call that actually executed", () => {
    expect(() => message({ preparationFailure: FACT })).toThrow(
      /cannot carry a preparation failure/,
    );
  });

  it("round-trips a malformed-argument fact and refuses a mismatched classifier version", () => {
    // A request whose arguments never formed an object is a different fact from a schema rejection,
    // and its own classifier version pins that meaning. It must survive the durable round trip, and a
    // record that claims the wrong version for its kind must be refused rather than reinterpreted.
    const parsingFact: ToolPreparationFailureFact = Object.freeze({
      kind: "MODEL_ARGUMENT_PARSING" as const,
      code: "TOOL_ARGUMENTS_REJECTED",
      issues: Object.freeze([Object.freeze({ keyword: "MALFORMED_JSON" })]),
      disposition: "SAFE_FAILURE" as const,
      classifierVersion: 2 as const,
    });
    const original = message({ observationBacked: false, preparationFailure: parsingFact });
    const encoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.encode(original);
    const decoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.decode(recordFor(original, encoded, 3));

    expect(decoded.preparationFailure).toEqual(parsingFact);
    expect(() =>
      AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.decode(
        recordFor(
          original,
          { ...encoded, preparationFailure: { ...parsingFact, classifierVersion: 1 } },
          3,
        ),
      ),
    ).toThrow(AgentMessageCodecError);
  });

  it("refuses an unbounded or malformed fact", () => {
    const original = message({ observationBacked: false, preparationFailure: FACT });
    const encoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.encode(original);
    const tampered = {
      ...encoded,
      preparationFailure: { ...FACT, issues: new Array(9).fill(FACT.issues[0]) },
    };
    expect(() =>
      AGENT_TOOL_RESULT_MESSAGE_CODEC_V3.decode(recordFor(original, tampered, 3)),
    ).toThrow(AgentMessageCodecError);
  });
});
