import { describe, expect, it } from "vitest";

import {
  AgentMessageProjectionError,
  NO_TOOL_RESULT_OBSERVATION,
  TOOL_FEEDBACK_PROJECTION_POLICY_KINDS,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
  TOOL_MESSAGE_SOURCE,
  TOOL_RESULT_OBSERVATION_REF_KINDS,
  AgentMessageCodecError,
  assertAgentMessageSource,
  assertToolFeedbackProjectionPolicy,
  assertToolResultObservationRef,
  createAgentConversationValidator,
  createAgentMessageBase,
  createAgentToolResultMessage,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  hasToolResultObservation,
  legacyMessageSource,
  projectionVersionTable,
  toolFeedbackPolicySnapshot,
  toolMessageSource,
  toolResultObservation,
  toolResultObservationId,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1,
  LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
  STRUCTURAL_TOKEN_ESTIMATOR,
  buildExecutionUnits,
} from "@caelush/agent";
import type {
  AgentMessageRecord,
  AgentMessageSource,
  AgentToolResultMessage,
  StoredAgentMessage,
  ToolFeedbackProjectionReceipt,
  ToolResultObservationRef,
} from "@caelush/agent";

import {
  CREATED_AT,
  OBSERVATION_ID,
  RECEIPT,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  codecs,
  factory,
  projectors,
  rawToolResultMessage,
  snapshot,
  toolResultMessage,
  turn,
  turnIdFor,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5B — the Message Interface Freeze Errata.
 *
 * ```text
 * ToolResultObservationRef      OBSERVATION | NO_OBSERVATION
 * ToolFeedbackProjectionPolicy  SNAPSHOT    | LEGACY_UNKNOWN
 * AgentMessageSource.TOOL       no observationId
 * ```
 *
 * The two unions are recorded, both are stored and projected without changing a byte of what the
 * model sees, and only a migration may write the legacy policy arm.
 */

/**
 * Build a stored Tool Result directly, bypassing the factory so a migration arm can be expressed.
 *
 * The factory is what refuses `LEGACY_UNKNOWN`, so a migration arm can only be built through
 * `createAgentToolResultMessage` — which is exactly the seam a migration uses.
 */
function legacyStoredToolResult(options: {
  readonly observation: ToolResultObservationRef;
  readonly projection: ToolFeedbackProjectionReceipt;
  readonly projectedContent?: string;
  readonly sequence?: number;
  readonly id?: string;
}): StoredAgentMessage<AgentToolResultMessage> {
  const message = createAgentToolResultMessage(
    createAgentMessageBase({
      id: (options.id ?? "amsg_0192f5b1-4d3a-7c2e-8a91-00000000000a") as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      createdAt: CREATED_AT as never,
      source: toolMessageSource(),
      audience: { model: true, transcript: false, debug: true },
    }),
    {
      toolCallId: "call_1",
      toolName: "tool_0",
      observation: options.observation,
      isError: false,
      projectedContent: options.projectedContent ?? "legacy tool output",
      projection: options.projection,
    },
  );
  return {
    sequence: options.sequence ?? 2,
    schemaVersion: 1,
    modelProjectionVersion: 1,
    message,
  };
}

const LEGACY_UNKNOWN_RECEIPT: ToolFeedbackProjectionReceipt = {
  policy: LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
  fingerprint: "legacy-fingerprint",
  version: 1,
};

/* ------------------------------------------------------------------- 1. the frozen contracts */

describe("Freeze errata — the corrected contracts exist exactly as frozen", () => {
  it("declares ToolResultObservationRef as a two-arm union", () => {
    expect([...TOOL_RESULT_OBSERVATION_REF_KINDS]).toEqual(["OBSERVATION", "NO_OBSERVATION"]);
    expect(toolResultObservation(OBSERVATION_ID as never)).toEqual({
      kind: "OBSERVATION",
      observationId: OBSERVATION_ID,
    });
    expect(NO_TOOL_RESULT_OBSERVATION).toEqual({ kind: "NO_OBSERVATION" });
  });

  it("declares ToolFeedbackProjectionPolicy as a two-arm union", () => {
    expect([...TOOL_FEEDBACK_PROJECTION_POLICY_KINDS]).toEqual(["SNAPSHOT", "LEGACY_UNKNOWN"]);
    expect(
      toolFeedbackPolicySnapshot({ maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 }),
    ).toEqual({
      kind: "SNAPSHOT",
      snapshot: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 },
    });
    expect(LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY).toEqual({ kind: "LEGACY_UNKNOWN" });
  });

  it("keeps the TOOL source arm free of observationId", () => {
    // One observation authority: the identity may not appear on both the envelope and the body,
    // because two appearances can disagree and nothing would arbitrate.
    expect(TOOL_MESSAGE_SOURCE).toEqual({ kind: "TOOL" });
    expect(toolMessageSource()).toEqual({ kind: "TOOL" });
    expect(Object.keys(TOOL_MESSAGE_SOURCE)).toEqual(["kind"]);
    expect(() => assertAgentMessageSource({ kind: "TOOL" })).not.toThrow();
  });

  it("carries the receipt version 1 unchanged", () => {
    expect(TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION).toBe(1);
    expect(RECEIPT.version).toBe(1);
  });

  it("reports the observation id through a helper that respects both arms", () => {
    expect(toolResultObservationId(rawToolResultMessage())).toBe(OBSERVATION_ID);
    expect(
      toolResultObservationId(rawToolResultMessage("x", NO_TOOL_RESULT_OBSERVATION)),
    ).toBeUndefined();
    expect(hasToolResultObservation(toolResultObservation(OBSERVATION_ID as never))).toBe(true);
    expect(hasToolResultObservation(NO_TOOL_RESULT_OBSERVATION)).toBe(false);
  });
});

/* --------------------------------------------------------------- 2. the four-state matrix */

describe("Freeze errata — the four canonical Tool Result states", () => {
  it("A. new observation-backed feedback: OBSERVATION + SNAPSHOT", () => {
    const message = toolResultMessage({ projectedContent: "observed output" }).message;
    expect(message.observation).toEqual({
      kind: "OBSERVATION",
      observationId: OBSERVATION_ID,
    });
    expect(message.projection.policy.kind).toBe("SNAPSHOT");
  });

  it("B. new non-observation feedback: NO_OBSERVATION + SNAPSHOT", () => {
    // A rejected or skipped call reaches the model as feedback with no execution behind it.
    const message = toolResultMessage({
      observationBacked: false,
      projectedContent: "call refused before execution",
    }).message;
    expect(message.observation).toEqual({ kind: "NO_OBSERVATION" });
    expect(message.projection.policy.kind).toBe("SNAPSHOT");
  });

  it("C. legacy row with a recoverable observation: OBSERVATION + LEGACY_UNKNOWN", () => {
    const entry = legacyStoredToolResult({
      observation: toolResultObservation(OBSERVATION_ID as never),
      projection: LEGACY_UNKNOWN_RECEIPT,
    });
    expect(entry.message.observation.kind).toBe("OBSERVATION");
    expect(entry.message.projection.policy.kind).toBe("LEGACY_UNKNOWN");
  });

  it("D. legacy row without an observation: NO_OBSERVATION + LEGACY_UNKNOWN", () => {
    const entry = legacyStoredToolResult({
      observation: NO_TOOL_RESULT_OBSERVATION,
      projection: LEGACY_UNKNOWN_RECEIPT,
    });
    expect(entry.message.observation.kind).toBe("NO_OBSERVATION");
    expect(entry.message.projection.policy.kind).toBe("LEGACY_UNKNOWN");
  });

  it("round-trips all four states through the standard codec", () => {
    const states: readonly StoredAgentMessage<AgentToolResultMessage>[] = [
      toolResultMessage({ projectedContent: "A", sequence: 1 }),
      toolResultMessage({ observationBacked: false, projectedContent: "B", sequence: 1 }),
      legacyStoredToolResult({
        observation: toolResultObservation(OBSERVATION_ID as never),
        projection: LEGACY_UNKNOWN_RECEIPT,
        projectedContent: "C",
        sequence: 1,
      }),
      legacyStoredToolResult({
        observation: NO_TOOL_RESULT_OBSERVATION,
        projection: LEGACY_UNKNOWN_RECEIPT,
        projectedContent: "D",
        sequence: 1,
      }),
    ];

    for (const [index, entry] of states.entries()) {
      const data = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(entry.message);
      const record: AgentMessageRecord = {
        messageId: entry.message.id,
        runId: entry.message.runId,
        sessionId: entry.message.sessionId,
        sequence: entry.sequence,
        conversationTurnId: entry.message.conversationTurnId,
        messageType: "TOOL_RESULT",
        schemaVersion: 1,
        modelProjectionVersion: 1,
        // The envelope is the authority for the step pointer, so it travels with the record rather
        // than inside `data`.
        ...(entry.message.sourceStepId === undefined
          ? {}
          : { sourceStepId: entry.message.sourceStepId }),
        createdAt: entry.message.createdAt,
        source: entry.message.source,
        audience: entry.message.audience,
        data,
      };
      const decoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode(record);
      expect(decoded, `state ${String(index)}`).toEqual(entry.message);
      expect(decoded.observation).toEqual(entry.message.observation);
      expect(decoded.projection.policy).toEqual(entry.message.projection.policy);
    }
  });

  it("projects all four states to the identical model view for identical content", () => {
    // This is what makes recording an unknown policy safe: the provenance arms carry no
    // model-visible meaning, so historical replay cannot differ because a policy is unknown.
    const content = "the exact text the model was shown";
    const projections = [
      rawToolResultMessage(content),
      rawToolResultMessage(content, NO_TOOL_RESULT_OBSERVATION),
      rawToolResultMessage(
        content,
        toolResultObservation(OBSERVATION_ID as never),
        LEGACY_UNKNOWN_RECEIPT,
      ),
      rawToolResultMessage(content, NO_TOOL_RESULT_OBSERVATION, LEGACY_UNKNOWN_RECEIPT),
    ].map((message) => AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1.project(message));

    for (const projection of projections) {
      expect(projection.messages).toEqual([
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "tool_0",
          content,
          isError: false,
        },
      ]);
    }
    // Identical content and identity means one fingerprint, regardless of provenance.
    expect(new Set(projections.map((projection) => projection.fingerprint)).size).toBe(1);
  });

  it("keeps the encoder payload shape corrected for every state", () => {
    const observed = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(rawToolResultMessage("a"));
    expect(Object.keys(observed).sort()).toEqual([
      "isError",
      "observation",
      "projectedContent",
      "projection",
      "toolCallId",
      "toolName",
    ]);
    expect(observed["observationId"]).toBeUndefined();
    expect(observed["observation"]).toEqual({
      kind: "OBSERVATION",
      observationId: OBSERVATION_ID,
    });

    const unobserved = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(
      rawToolResultMessage("a", NO_TOOL_RESULT_OBSERVATION),
    );
    expect(unobserved["observation"]).toEqual({ kind: "NO_OBSERVATION" });

    const legacy = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(
      rawToolResultMessage("a", NO_TOOL_RESULT_OBSERVATION, LEGACY_UNKNOWN_RECEIPT),
    );
    expect(legacy["projection"]).toEqual({
      policy: { kind: "LEGACY_UNKNOWN" },
      fingerprint: "legacy-fingerprint",
      version: 1,
    });
  });
});

/* --------------------------------------------------------- 3. tool linkage without observation */

describe("Freeze errata — Tool linkage never depends on observation existence", () => {
  it("lets a NO_OBSERVATION result answer a Tool call for the validator", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_1",
        toolName: "tool_0",
        observationBacked: false,
        sequence: 3,
      }),
    ];
    expect(() => validator.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("lets a NO_OBSERVATION result close an ExecutionUnit", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_1",
        toolName: "tool_0",
        observationBacked: false,
        sequence: 3,
      }),
    ];
    const units = executionUnitsOf(turn(messages));
    expect(units).toHaveLength(1);
    expect(units[0]?.status).toBe("CLOSED");
  });

  it("also closes a unit whose result carries the legacy unknown policy", () => {
    const entry = legacyStoredToolResult({
      observation: NO_TOOL_RESULT_OBSERVATION,
      projection: LEGACY_UNKNOWN_RECEIPT,
      sequence: 3,
      // Distinct from the fixture helper's own id, because a duplicate message id is a violation
      // this test is not about.
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-0000000000e1",
    });
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      entry,
    ];
    const units = executionUnitsOf(turn(messages));
    expect(units[0]?.status).toBe("CLOSED");
    expect(() => validator.validate(snapshot([turn(messages)]))).not.toThrow();
  });
  it("still refuses a genuinely unanswered call", () => {
    const messages: readonly StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      assistantMessage({ text: "carrying on", sequence: 3 }),
    ];
    expect(() => validator.validate(snapshot([turn(messages)]))).toThrow();
  });
});

/* -------------------------------------------------------------- 4. LEGACY_UNKNOWN is a producer rule */

describe("Freeze errata — LEGACY_UNKNOWN is migration-only", () => {
  it("refuses LEGACY_UNKNOWN from the normal factory", () => {
    let thrown: unknown;
    try {
      factory().createToolResult({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: toolMessageSource(),
        toolCallId: "call_1",
        toolName: "tool_0",
        observation: NO_TOOL_RESULT_OBSERVATION,
        isError: false,
        projectedContent: "x",
        projection: LEGACY_UNKNOWN_RECEIPT,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).toContain("LEGACY_UNKNOWN belongs to migration");
  });

  it("accepts LEGACY_UNKNOWN through the decode path, because a reader must read what was written", () => {
    // The refusal is a *creation* rule. A migration writes the arm; every reader must decode it.
    const decoded = codecs.decode({
      messageId: "amsg_0192f5b1-4d3a-7c2e-8a91-00000000000b" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      sequence: 1,
      conversationTurnId: turnIdFor(),
      messageType: "TOOL_RESULT",
      schemaVersion: 1,
      modelProjectionVersion: 1,
      createdAt: CREATED_AT as never,
      source: toolMessageSource(),
      audience: { model: true, transcript: false, debug: true },
      data: {
        toolCallId: "call_1",
        toolName: "tool_0",
        observation: { kind: "NO_OBSERVATION" },
        isError: false,
        projectedContent: "migrated",
        projection: {
          policy: { kind: "LEGACY_UNKNOWN" },
          fingerprint: "f",
          version: 1,
        },
      },
    });
    expect(decoded.type).toBe("TOOL_RESULT");
    if (decoded.type !== "TOOL_RESULT") throw new Error("unreachable");
    expect(decoded.observation.kind).toBe("NO_OBSERVATION");
    expect(decoded.projection.policy.kind).toBe("LEGACY_UNKNOWN");
  });

  it("still requires a SNAPSHOT from the normal factory", () => {
    const message = toolResultMessage().message;
    expect(message.projection.policy.kind).toBe("SNAPSHOT");
  });

  it("refuses a source that contradicts the message kind", () => {
    expect(() =>
      factory().createToolResult({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: legacyMessageSource("tool"),
        toolCallId: "call_1",
        toolName: "tool_0",
        observation: NO_TOOL_RESULT_OBSERVATION,
        isError: false,
        projectedContent: "x",
        projection: RECEIPT,
      }),
    ).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------------------- 5. negative */

describe("Freeze errata — negative cases are refused", () => {
  it("refuses an unnamed call or tool", () => {
    for (const broken of [{ toolCallId: "" }, { toolName: "" }]) {
      expect(() =>
        factory().createToolResult({
          runId: RUN_ID as never,
          sessionId: SESSION_ID as never,
          conversationTurnId: turnIdFor(),
          source: toolMessageSource(),
          toolCallId: "call_1",
          toolName: "tool_0",
          observation: NO_TOOL_RESULT_OBSERVATION,
          isError: false,
          projectedContent: "x",
          projection: RECEIPT,
          ...broken,
        }),
      ).toThrow(TypeError);
    }
  });

  it("refuses an invalid observation kind and an OBSERVATION without an id", () => {
    for (const broken of [
      { kind: "SOMETHING_ELSE" },
      { kind: "OBSERVATION" },
      { kind: "OBSERVATION", observationId: "" },
      {},
      null,
      "OBSERVATION",
    ]) {
      expect(() => assertToolResultObservationRef(broken), JSON.stringify(broken)).toThrow(
        TypeError,
      );
    }
  });

  it("refuses an unknown policy kind and a SNAPSHOT without a snapshot", () => {
    const broken: unknown[] = [
      { kind: "DEFAULT" },
      { kind: "SNAPSHOT" },
      { kind: "SNAPSHOT", snapshot: {} },
      {
        kind: "SNAPSHOT",
        snapshot: { maxSingleObservationTokens: 0, maxObservationBatchTokens: 1 },
      },
      {
        kind: "SNAPSHOT",
        snapshot: { maxSingleObservationTokens: 1, maxObservationBatchTokens: -1 },
      },
      {
        kind: "SNAPSHOT",
        snapshot: { maxSingleObservationTokens: 1.5, maxObservationBatchTokens: 1 },
      },
      {},
      null,
    ];
    for (const value of broken) {
      expect(() => assertToolFeedbackProjectionPolicy(value), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a malformed observation or policy in a stored record", () => {
    const base = {
      messageId: "amsg_0192f5b1-4d3a-7c2e-8a91-00000000000c" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      sequence: 1,
      conversationTurnId: turnIdFor(),
      messageType: "TOOL_RESULT",
      schemaVersion: 1,
      modelProjectionVersion: 1,
      createdAt: CREATED_AT as never,
      source: toolMessageSource(),
      audience: { model: true, transcript: false, debug: true },
    };
    const data = (observation: unknown, policy: unknown): Record<string, unknown> => ({
      toolCallId: "call_1",
      toolName: "tool_0",
      observation,
      isError: false,
      projectedContent: "x",
      projection: { policy, fingerprint: "f", version: 1 },
    });

    for (const [observation, policy] of [
      [
        { kind: "MAYBE" },
        {
          kind: "SNAPSHOT",
          snapshot: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 1 },
        },
      ],
      [
        { kind: "OBSERVATION" },
        {
          kind: "SNAPSHOT",
          snapshot: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 1 },
        },
      ],
      [{ kind: "NO_OBSERVATION" }, { kind: "UNKNOWN" }],
      [{ kind: "NO_OBSERVATION" }, { kind: "SNAPSHOT" }],
      [undefined, { kind: "LEGACY_UNKNOWN" }],
    ] as const) {
      expect(() =>
        AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode({
          ...base,
          data: data(observation, policy) as never,
        }),
      ).toThrow(AgentMessageCodecError);
    }
  });

  it("never infers NO_OBSERVATION from a missing field", () => {
    // A missing field is exactly the ambiguity the union exists to remove, so it is refused rather
    // than defaulted. Treating absence as "no observation" would silently re-create the defect.
    expect(() =>
      AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode({
        messageId: "amsg_0192f5b1-4d3a-7c2e-8a91-00000000000d" as never,
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        sequence: 1,
        conversationTurnId: turnIdFor(),
        messageType: "TOOL_RESULT",
        schemaVersion: 1,
        modelProjectionVersion: 1,
        createdAt: CREATED_AT as never,
        source: toolMessageSource(),
        audience: { model: true, transcript: false, debug: true },
        data: {
          toolCallId: "call_1",
          toolName: "tool_0",
          isError: false,
          projectedContent: "x",
          projection: {
            policy: { kind: "LEGACY_UNKNOWN" },
            fingerprint: "f",
            version: 1,
          },
        } as never,
      }),
    ).toThrow(AgentMessageCodecError);
  });
});

/* ------------------------------------------------------------------------ 6. registry behaviour */

describe("Freeze errata — the registries carry the corrected contract", () => {
  it("keeps TOOL_RESULT at schema version 1 and projection version 1", () => {
    // No durable V2 row was ever written, so v1 never became an external persisted contract, and
    // the AI projection output did not change — only receipt metadata did.
    expect(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.currentVersion).toBe(1);
    expect(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.canDecode(1)).toBe(true);
    expect(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.canDecode(2)).toBe(false);
    expect(AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1.version).toBe(1);
    expect(projectors.currentVersion("TOOL_RESULT")).toBe(1);
    expect(
      createStandardAgentMessageCodecRegistry(projectionVersionTable({ TOOL_RESULT: 1 })).has(
        "TOOL_RESULT",
        1,
      ),
    ).toBe(true);
  });

  it("still fails closed when a model-visible message has no projection version", () => {
    const entry: StoredAgentMessage = {
      sequence: 1,
      schemaVersion: 1,
      message: rawToolResultMessage("x", NO_TOOL_RESULT_OBSERVATION),
    };
    try {
      projectors.project(entry);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMessageProjectionError);
      expect((error as AgentMessageProjectionError).code).toBe("PROJECTION_VERSION_UNAVAILABLE");
    }
  });

  it("projects a migrated message under its stored version, not the latest", () => {
    const entry = legacyStoredToolResult({
      observation: NO_TOOL_RESULT_OBSERVATION,
      projection: LEGACY_UNKNOWN_RECEIPT,
    });
    const projection = createStandardAgentMessageProjectorRegistry().project(entry);
    expect(projection.messages).toHaveLength(1);
  });

  it("keeps the projection registry free of any provenance branching", () => {
    const projection = AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1.project(
      legacyStoredToolResult({
        observation: NO_TOOL_RESULT_OBSERVATION,
        projection: LEGACY_UNKNOWN_RECEIPT,
        projectedContent: "legacy exact text",
      }).message,
    );
    expect(projection.messages).toEqual([
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "tool_0",
        content: "legacy exact text",
        isError: false,
      },
    ]);
  });

  it("keeps the other three message types untouched by the errata", () => {
    const user = userMessage().message;
    expect(user.type).toBe("USER");
    const assistant = assistantMessage({ text: "hi" }).message;
    expect(assistant.type).toBe("ASSISTANT");
    const source: AgentMessageSource = assistant.source;
    expect(source.kind).toBe("MODEL");
    expect(Object.keys(RECEIPT).sort()).toEqual(["fingerprint", "policy", "version"]);
  });
});

/* --------------------------------------------------------------------------------- helpers */

const validator = createAgentConversationValidator();

const executionUnitsOf = (conversationTurn: Parameters<typeof buildExecutionUnits>[0]) =>
  buildExecutionUnits(conversationTurn, STRUCTURAL_TOKEN_ESTIMATOR, projectors);
