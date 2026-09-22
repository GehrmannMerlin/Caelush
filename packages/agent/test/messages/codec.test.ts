import { describe, expect, it } from "vitest";

import {
  AgentMessageCodecError,
  AgentMessageCodecRegistryError,
  createAgentMessageCodecRegistry,
  createAgentMessageCodecRegistryBuilder,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  AGENT_ASSISTANT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  AGENT_USER_MESSAGE_CODEC_V1,
  STANDARD_AGENT_MESSAGE_CODECS,
} from "@caelush/agent";
import type {
  AgentMessageCodec,
  AgentMessageDraft,
  AgentMessageRecord,
  AgentMessageSchemaVersion,
} from "@caelush/agent";

import {
  CREATED_AT,
  RECEIPT,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  codecs,
  projectionVersions,
  rawAssistantMessage,
  rawToolResultMessage,
  rawUserMessage,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5A — the versioned durable codecs and their registry. Freeze §137 to §139, §73, §74,
 * §77, §78 to §83.
 */

/** The envelope of a record, from a message plus explicit storage facts. */
function recordFor(
  message:
    | ReturnType<typeof userMessage>["message"]
    | ReturnType<typeof assistantMessage>["message"]
    | ReturnType<typeof toolResultMessage>["message"],
  data: AgentMessageRecord["data"],
  overrides: Partial<AgentMessageRecord> = {},
): AgentMessageRecord {
  return {
    messageId: message.id,
    runId: message.runId,
    sessionId: message.sessionId,
    sequence: 1,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: 1,
    modelProjectionVersion: 1,
    // The envelope is the authority for the step pointer too: it is not in `data`.
    ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data,
    ...overrides,
  };
}

describe("Phase 5A codec — three standard codecs exist and declare their identity", () => {
  it("registers one codec per canonical type at version 1", () => {
    expect(STANDARD_AGENT_MESSAGE_CODECS).toHaveLength(3);
    expect(AGENT_USER_MESSAGE_CODEC_V1.type).toBe("USER");
    expect(AGENT_ASSISTANT_MESSAGE_CODEC_V1.type).toBe("ASSISTANT");
    expect(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.type).toBe("TOOL_RESULT");
    for (const codec of STANDARD_AGENT_MESSAGE_CODECS) {
      expect(codec.currentVersion).toBe(1);
      expect(codec.canDecode(1)).toBe(true);
      expect(codec.canDecode(2)).toBe(false);
      expect(codec.canDecode(0)).toBe(false);
    }
  });
});

describe("Phase 5A codec — USER round trip", () => {
  it("round-trips a text user message", () => {
    const original = userMessage({ text: "explain the patch" }).message;
    const draft = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_USER_MESSAGE_CODEC_V1.decode(recordFor(original, draft));
    expect(decoded).toEqual(original);
  });

  it("round-trips an attachment reference, preserving present fields only", () => {
    const original = userMessage({ withAttachment: true }).message;
    const draft = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_USER_MESSAGE_CODEC_V1.decode(recordFor(original, draft));
    expect(decoded.content).toEqual(original.content);
  });

  it("writes only content into data, never the envelope", () => {
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(userMessage().message);
    expect(Object.keys(data)).toEqual(["content"]);
    for (const envelopeField of [
      "runId",
      "sessionId",
      "conversationTurnId",
      "audience",
      "source",
      "createdAt",
      "sequence",
      "messageId",
      "sourceStepId",
    ]) {
      expect(data[envelopeField], envelopeField).toBeUndefined();
    }
  });

  it("produces semantically identical JSON for the same message", () => {
    // Deterministic encode: no clock, no randomness, no environment (freeze §74).
    const message = userMessage().message;
    const first = AGENT_USER_MESSAGE_CODEC_V1.encode(message);
    const second = AGENT_USER_MESSAGE_CODEC_V1.encode(message);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect([...Object.keys(second)]).toEqual([...Object.keys(first)]);
  });
});

describe("Phase 5A codec — ASSISTANT round trip", () => {
  it("round-trips text, tool calls, order, model provenance and provider state", () => {
    const original = assistantMessage({
      text: "let me look",
      toolCalls: ["call_1", "call_2"],
      callId: "llm_77",
      providerState: {
        providerId: "provider-alpha",
        api: "alpha-messages",
        version: 1,
        payload: { signature: "opaque-blob", nested: { list: [1, 2, 3] } },
      },
    }).message;

    const draft = AGENT_ASSISTANT_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_ASSISTANT_MESSAGE_CODEC_V1.decode(recordFor(original, draft));

    expect(decoded.content).toEqual(original.content);
    expect(decoded.content.map((part) => part.type)).toEqual(["TEXT", "TOOL_CALL", "TOOL_CALL"]);
    expect(decoded.model).toEqual(original.model);
    expect(decoded.providerState).toEqual(original.providerState);
    expect(decoded).toEqual(original);
  });

  it("omits providerState rather than writing null when there is none", () => {
    const message = assistantMessage({ text: "hi" }).message;
    const data = AGENT_ASSISTANT_MESSAGE_CODEC_V1.encode(message);
    expect(Object.keys(data).sort()).toEqual(["content", "model"]);
    expect(data["providerState"]).toBeUndefined();
    const decoded = AGENT_ASSISTANT_MESSAGE_CODEC_V1.decode(recordFor(message, data));
    expect("providerState" in decoded).toBe(false);
  });

  it("preserves a LEGACY_MODEL_TURN provenance on decode without inventing fields", () => {
    // 5B backfill reads rows that have no call id, finish reason or usage. The codec must
    // represent them honestly rather than fabricating history.
    const original = rawAssistantMessage([{ type: "TEXT", text: "migrated" }]);
    const data = AGENT_ASSISTANT_MESSAGE_CODEC_V1.encode(original);
    const legacyData = {
      ...data,
      model: {
        kind: "LEGACY_MODEL_TURN",
        sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e01",
      },
    };
    const decoded = AGENT_ASSISTANT_MESSAGE_CODEC_V1.decode(recordFor(original, legacyData));
    expect(decoded.model).toEqual({
      kind: "LEGACY_MODEL_TURN",
      sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e01",
    });
  });

  it("preserves usage counters when present and omits the field when absent", () => {
    const original = rawAssistantMessage([{ type: "TEXT", text: "hi" }]);
    const base = AGENT_ASSISTANT_MESSAGE_CODEC_V1.encode(original);
    const withUsage = {
      ...base,
      model: {
        kind: "MODEL_TURN",
        callId: "llm_fixture",
        model: { provider: "example-provider", model: "example-model" },
        finishReason: "TOOL_CALLS",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2 },
      },
    };
    const decoded = AGENT_ASSISTANT_MESSAGE_CODEC_V1.decode(recordFor(original, withUsage));
    if (decoded.model.kind !== "MODEL_TURN") throw new Error("unreachable");
    expect(decoded.model.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 2,
    });
  });
});

describe("Phase 5A codec — TOOL_RESULT round trip", () => {
  it("round-trips every field and the projection receipt", () => {
    const original = toolResultMessage({
      isError: true,
      projectedContent: "boom\n[output truncated to fit the model budget]",
    }).message;
    const draft = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode(recordFor(original, draft));
    expect(decoded).toEqual(original);
    expect(decoded.projectedContent).toBe(original.projectedContent);
    expect(decoded.projection).toEqual(RECEIPT);
  });

  it("writes the six Tool fields and no envelope field", () => {
    const data = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(toolResultMessage().message);
    expect(Object.keys(data).sort()).toEqual([
      "isError",
      "observation",
      "projectedContent",
      "projection",
      "toolCallId",
      "toolName",
    ]);
  });
});

describe("Phase 5A codec — decode identity and version validation", () => {
  it("refuses a record whose messageType belongs to another codec", () => {
    // The codec's own identity obligation: decoding a foreign row would build a message
    // whose type disagrees with the row it came from.
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const foreign = recordFor(original, data, { messageType: "ASSISTANT" });
    expect(() => AGENT_USER_MESSAGE_CODEC_V1.decode(foreign)).toThrow(AgentMessageCodecError);
    try {
      AGENT_USER_MESSAGE_CODEC_V1.decode(foreign);
    } catch (error) {
      expect((error as AgentMessageCodecError).reason).toBe("IDENTITY_MISMATCH");
    }
  });

  it("refuses an unsupported schema version rather than falling forward", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const future = recordFor(original, data, { schemaVersion: 2 as AgentMessageSchemaVersion });
    expect(() => AGENT_USER_MESSAGE_CODEC_V1.decode(future)).toThrow(AgentMessageCodecError);
    try {
      AGENT_USER_MESSAGE_CODEC_V1.decode(future);
    } catch (error) {
      expect((error as AgentMessageCodecError).reason).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }
  });

  it("refuses an invalid envelope field", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    for (const broken of [
      { runId: "" },
      { sessionId: "" },
      { conversationTurnId: "" },
      { messageId: "" },
      { createdAt: -1 },
      { sourceStepId: "" },
      { audience: { model: true, transcript: true } },
      { source: { kind: "NOPE" } },
      { source: { kind: "USER", origin: "NOPE" } },
      { source: { kind: "LEGACY", legacyRole: "nope" } },
    ]) {
      expect(() =>
        AGENT_USER_MESSAGE_CODEC_V1.decode(recordFor(original, data, broken as never)),
      ).toThrow(AgentMessageCodecError);
    }
  });

  it("does not validate the storage sequence, which is not a codec concern", () => {
    // `sequence` is storage-assigned ordering, not part of a message and not part of the
    // durable encoding. The codec decodes the message; whoever owns the ledger enforces its
    // ordering. Asserting this keeps the responsibility boundary explicit rather than
    // accidental.
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_USER_MESSAGE_CODEC_V1.decode(recordFor(original, data, { sequence: 0 }));
    expect(decoded).toEqual(original);
  });

  it("refuses invalid data", () => {
    const original = userMessage().message;
    for (const data of [
      {},
      { content: [] },
      { content: [{ type: "TEXT", text: 1 }] },
      { content: [{ type: "NOPE" }] },
      { content: [{ type: "ATTACHMENT_REF", artifactId: "" }] },
    ]) {
      expect(() => AGENT_USER_MESSAGE_CODEC_V1.decode(recordFor(original, data as never))).toThrow(
        AgentMessageCodecError,
      );
    }
  });

  it("preserves audience and source through the envelope", () => {
    // Audience is not in `data`, so this proves the envelope is the authority for it.
    const original = toolResultMessage().message;
    const data = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.encode(original);
    const decoded = AGENT_TOOL_RESULT_MESSAGE_CODEC_V1.decode(recordFor(original, data));
    expect(decoded.audience).toEqual({ model: true, transcript: false, debug: true });
    expect(decoded.source).toEqual({ kind: "TOOL" });
    expect(decoded.runId).toBe(RUN_ID);
    expect(decoded.sessionId).toBe(SESSION_ID);
    expect(decoded.conversationTurnId).toBe(turnIdFor());
    expect(decoded.createdAt).toBe(CREATED_AT);
  });

  it("preserves a non-default audience through the envelope", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const hidden = recordFor(original, data, {
      audience: { model: false, transcript: true, debug: false },
    });
    const decoded = AGENT_USER_MESSAGE_CODEC_V1.decode(hidden);
    expect(decoded.audience).toEqual({ model: false, transcript: true, debug: false });
  });
});

describe("Phase 5A codec registry — lookup and registration", () => {
  it("answers has/get for an exact type and version", () => {
    expect(codecs.has("USER", 1)).toBe(true);
    expect(codecs.get("USER", 1)).toBe(AGENT_USER_MESSAGE_CODEC_V1);
    expect(codecs.has("USER", 2)).toBe(false);
    expect(codecs.get("USER", 2)).toBeUndefined();
    expect(codecs.has("NOPE", 1)).toBe(false);
    expect(codecs.get("NOPE", 1)).toBeUndefined();
  });

  it("refuses a duplicate type and version", () => {
    const builder = createAgentMessageCodecRegistryBuilder();
    builder.register(AGENT_USER_MESSAGE_CODEC_V1);
    expect(() => builder.register(AGENT_USER_MESSAGE_CODEC_V1)).toThrow(
      AgentMessageCodecRegistryError,
    );
  });

  it("refuses an invalid declared version", () => {
    for (const version of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const builder = createAgentMessageCodecRegistryBuilder();
      const broken: AgentMessageCodec = { ...AGENT_USER_MESSAGE_CODEC_V1, currentVersion: version };
      expect(() => builder.register(broken)).toThrow(AgentMessageCodecRegistryError);
    }
  });

  it("builds an immutable generation", () => {
    const builder = createAgentMessageCodecRegistryBuilder();
    builder.register(AGENT_USER_MESSAGE_CODEC_V1);
    const built = builder.build();
    // A second build is refused rather than producing a second generation from one builder.
    expect(() => builder.build()).toThrow(AgentMessageCodecRegistryError);
    // Registering after build cannot change the registry that was handed out.
    expect(() => builder.register(AGENT_ASSISTANT_MESSAGE_CODEC_V1)).toThrow(
      AgentMessageCodecRegistryError,
    );
    expect(built.has("ASSISTANT", 1)).toBe(false);
    expect(built.has("USER", 1)).toBe(true);
  });
});

describe("Phase 5A codec registry — encode and decode versioning", () => {
  it("encodes with the current schema version", () => {
    const draft: AgentMessageDraft = codecs.encode(userMessage().message);
    expect(draft.schemaVersion).toBe(1);
    expect(draft.message.type).toBe("USER");
    // The payload travels with the draft. Phase 5B's errata added it because the storage round must
    // write exactly these bytes and re-encoding at the repository would re-choose the version.
    expect(draft.data).toEqual({ content: [{ type: "TEXT", text: "hello" }] });
    expect(AGENT_USER_MESSAGE_CODEC_V1.encode(draft.message as never)).toEqual(draft.data);
  });

  it("decodes with the version the record carries, not the current one", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const decoded = codecs.decode(recordFor(original, data, { schemaVersion: 1 }));
    expect(decoded).toEqual(original);
  });

  it("fails closed on an unknown type with CODEC_UNAVAILABLE", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const unknown = recordFor(original, data, { messageType: "CUSTOM_THING" });
    try {
      codecs.decode(unknown);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMessageCodecError);
      expect((error as AgentMessageCodecError).reason).toBe("CODEC_UNAVAILABLE");
    }
  });

  it("fails closed on an unknown version with UNSUPPORTED_SCHEMA_VERSION", () => {
    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    const future = recordFor(original, data, { schemaVersion: 9 });
    try {
      codecs.decode(future);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMessageCodecError);
      expect((error as AgentMessageCodecError).reason).toBe("UNSUPPORTED_SCHEMA_VERSION");
      // The refusal carries schema metadata only, never the payload (freeze §82 / §73).
      expect(JSON.stringify(error)).not.toContain("explain the patch");
    }
  });

  it("never guesses a version and never silently decodes with the latest", () => {
    // A registry with two versions registered must still refuse a third.
    const v2: AgentMessageCodec = { ...AGENT_USER_MESSAGE_CODEC_V1, currentVersion: 2 };
    const registry = createAgentMessageCodecRegistry({
      codecs: [AGENT_USER_MESSAGE_CODEC_V1, v2],
      projectionVersionOf: projectionVersions,
    });
    expect(registry.has("USER", 1)).toBe(true);
    expect(registry.has("USER", 2)).toBe(true);
    expect(registry.has("USER", 3)).toBe(false);

    const original = userMessage().message;
    const data = AGENT_USER_MESSAGE_CODEC_V1.encode(original);
    expect(() => registry.decode(recordFor(original, data, { schemaVersion: 3 }))).toThrow(
      AgentMessageCodecError,
    );
    // And encode writes the newest registered version, never the oldest.
    expect(registry.encode(original).schemaVersion).toBe(2);
  });
});

describe("Phase 5A codec registry — projection version authority (freeze §78–§80)", () => {
  it("records the projection version for a model-visible message", () => {
    const draft = codecs.encode(userMessage().message);
    expect(draft.modelProjectionVersion).toBe(1);
  });

  it("leaves the projection version absent for a message the model never sees", () => {
    // No model view exists, so recording a projector version would claim a projection that
    // never happens.
    const hidden = userMessage().message;
    const draft = codecs.encode({ ...hidden, audience: { ...hidden.audience, model: false } });
    expect("modelProjectionVersion" in draft).toBe(false);
    expect(draft.schemaVersion).toBe(1);
  });

  it("fails closed for a model-visible message when no version authority is injected", () => {
    const unversioned = createStandardAgentMessageCodecRegistry();
    expect(() => unversioned.encode(userMessage().message)).toThrow(AgentMessageCodecRegistryError);
    try {
      unversioned.encode(userMessage().message);
    } catch (error) {
      expect((error as AgentMessageCodecRegistryError).reason).toBe(
        "PROJECTION_VERSION_UNAVAILABLE",
      );
    }
  });

  it("still encodes a non-model-visible message with no version authority", () => {
    const unversioned = createStandardAgentMessageCodecRegistry();
    const hidden = toolResultMessage().message;
    const draft = unversioned.encode({
      ...hidden,
      audience: { ...hidden.audience, model: false },
    });
    expect("modelProjectionVersion" in draft).toBe(false);
  });

  it("takes the version from the projector registry, so there is one authority", () => {
    // The production wiring: the codec registry asks the projector registry for the current
    // version rather than restating it. Nothing here hardcodes a version.
    const projectors = createStandardAgentMessageProjectorRegistry();
    const wired = createAgentMessageCodecRegistry({
      codecs: [...STANDARD_AGENT_MESSAGE_CODECS],
      projectionVersionOf: (type) => projectors.currentVersion(type),
    });

    for (const type of ["USER", "ASSISTANT", "TOOL_RESULT"] as const) {
      expect(wired.encode(messageOfType(type)).modelProjectionVersion).toBe(
        projectors.currentVersion(type),
      );
    }
    // An unknown type has no projector, so an encode of one cannot be versioned either.
    expect(projectors.currentVersion("USER")).toBe(1);
    expect(projectors.currentVersion("CUSTOM_THING")).toBeUndefined();
  });

  it("fails closed when the projector registry has no version for the type", () => {
    const empty = createAgentMessageCodecRegistry({
      codecs: [...STANDARD_AGENT_MESSAGE_CODECS],
      projectionVersionOf: () => undefined,
    });
    expect(() => empty.encode(userMessage().message)).toThrow(AgentMessageCodecRegistryError);
  });
});

function messageOfType(type: "USER" | "ASSISTANT" | "TOOL_RESULT") {
  switch (type) {
    case "USER":
      return rawUserMessage();
    case "ASSISTANT":
      return rawAssistantMessage([{ type: "TEXT", text: "hi" }]);
    case "TOOL_RESULT":
      return rawToolResultMessage();
  }
}
