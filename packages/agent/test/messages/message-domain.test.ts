import { describe, expect, it } from "vitest";

import {
  agentAttachmentRefPart,
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentMessageId,
  agentTextPart,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createConversationTurnIdFactory,
  createScriptedAgentMessageIdFactory,
  createSeededConversationTurnIdFactory,
  isAgentMessageId,
  isConversationTurnId,
  legacyMessageSource,
  modelMessageSource,
  toolMessageSource,
  userMessageSource,
  AGENT_ASSISTANT_MESSAGE_AUDIENCE,
  AGENT_MESSAGE_ID_PREFIX,
  AGENT_TOOL_RESULT_MESSAGE_AUDIENCE,
  AGENT_USER_MESSAGE_AUDIENCE,
  CONVERSATION_TURN_ID_PREFIX,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
} from "@caelush/agent";
import type { AgentAssistantModelProvenance } from "@caelush/agent";

import {
  CREATED_AT,
  OBSERVATION_ID,
  OTHER_RUN_ID,
  RECEIPT,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  factory,
  liveFactory,
  toolResultMessage,
  turnIdFor,
  turns,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5A — Message Domain identity, audience, source, the three canonical messages and the
 * Message Factory. Freeze §133 to §136.
 */

describe("Phase 5A ids — AgentMessageId", () => {
  it("mints well-formed ids and recognises them", () => {
    const ids = createAgentMessageIdFactory();
    const first = ids.create();
    const second = ids.create();
    expect(isAgentMessageId(first)).toBe(true);
    expect(isAgentMessageId(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.startsWith(AGENT_MESSAGE_ID_PREFIX)).toBe(true);
  });

  it("rejects anything that is not exactly the minted shape", () => {
    for (const value of [
      "",
      "amsg_",
      "amsg_not-a-uuid",
      "0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      // version nibble is 4, not 7
      "amsg_0192f5b1-4d3a-4c2e-8a91-3f0b6c7d8e9a",
      // variant nibble is outside 8..b
      "amsg_0192f5b1-4d3a-7c2e-0a91-3f0b6c7d8e9a",
      null,
      42,
    ]) {
      expect(isAgentMessageId(value), String(value)).toBe(false);
    }
  });

  it("reads an already-trusted string through the single brand cast", () => {
    const id = agentMessageId("amsg_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a");
    expect(isAgentMessageId(id)).toBe(true);
  });

  it("exhausts a scripted factory rather than repeating an id", () => {
    const scripted = createScriptedAgentMessageIdFactory([
      "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001",
    ]);
    expect(isAgentMessageId(scripted.create())).toBe(true);
    expect(() => scripted.create()).toThrow(RangeError);
  });

  it("refuses a scripted id that is malformed", () => {
    const scripted = createScriptedAgentMessageIdFactory(["not-an-id"]);
    expect(() => scripted.create()).toThrow(TypeError);
  });
});

describe("Phase 5A ids — ConversationTurnId determinism", () => {
  it("derives the same turn id for the same Run from independent factories", () => {
    const first = createDeterministicConversationTurnIdFactory();
    const second = createDeterministicConversationTurnIdFactory();
    expect(first.forRun(RUN_ID as never)).toBe(second.forRun(RUN_ID as never));
  });

  it("derives different turn ids for different Runs", () => {
    const deterministic = createDeterministicConversationTurnIdFactory();
    expect(deterministic.forRun(RUN_ID as never)).not.toBe(
      deterministic.forRun(OTHER_RUN_ID as never),
    );
    // Runs differing only in their final character must still produce unrelated ids, and no
    // region of the identifier may be a constant shared by every turn of a Session.
    const nearMisses = [`${RUN_ID.slice(0, -1)}b`, `${RUN_ID.slice(0, -1)}c`, `${RUN_ID}x`];
    const ids = nearMisses.map((runId) => deterministic.forRun(runId as never));
    expect(new Set(ids).size).toBe(ids.length);

    const hex = ids.map((id) => id.slice(CONVERSATION_TURN_ID_PREFIX.length).replaceAll("-", ""));
    // The leading four bytes are a function of the Run rather than a fixed zero region.
    expect(new Set(hex.map((value) => value.slice(0, 8))).size).toBe(hex.length);
    // The trailing twelve bytes are too, so two Runs do not share a body.
    expect(new Set(hex.map((value) => value.slice(8))).size).toBe(hex.length);
  });

  it("mints a well-formed turn id", () => {
    expect(isConversationTurnId(turns.forRun(RUN_ID as never))).toBe(true);
    expect(turns.forRun(RUN_ID as never).startsWith(CONVERSATION_TURN_ID_PREFIX)).toBe(true);
  });

  it("is stable within the default factory and reproducible across seeded factories", () => {
    const defaultFactory = createConversationTurnIdFactory();
    expect(defaultFactory.forRun(RUN_ID as never)).toBe(defaultFactory.forRun(RUN_ID as never));

    const seeded = createSeededConversationTurnIdFactory(1_700_000_000_000);
    const again = createSeededConversationTurnIdFactory(1_700_000_000_000);
    expect(seeded.forRun(RUN_ID as never)).toBe(again.forRun(RUN_ID as never));
  });

  it("accepts a RunId but not an arbitrary string as a turn id", () => {
    expect(isConversationTurnId("cturn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a")).toBe(true);
    expect(isConversationTurnId("amsg_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a")).toBe(false);
  });
});

describe("Phase 5A audience — the three frozen default triples", () => {
  it("defaults a user message to model, transcript and debug", () => {
    expect(userMessage().message.audience).toEqual({
      model: true,
      transcript: true,
      debug: true,
    });
    expect(AGENT_USER_MESSAGE_AUDIENCE).toEqual({ model: true, transcript: true, debug: true });
  });

  it("defaults an assistant message to model, transcript and debug", () => {
    expect(assistantMessage({ text: "hi" }).message.audience).toEqual({
      model: true,
      transcript: true,
      debug: true,
    });
    expect(AGENT_ASSISTANT_MESSAGE_AUDIENCE).toEqual({
      model: true,
      transcript: true,
      debug: true,
    });
  });

  it("defaults a Tool result to model and debug but NOT transcript", () => {
    // A Tool result is the model's own feedback channel; rendering it as user-facing
    // conversation would show the user output they were never meant to read.
    expect(toolResultMessage().message.audience).toEqual({
      model: true,
      transcript: false,
      debug: true,
    });
    expect(AGENT_TOOL_RESULT_MESSAGE_AUDIENCE).toEqual({
      model: true,
      transcript: false,
      debug: true,
    });
  });

  it("freezes the default objects so no caller can mutate a shared default", () => {
    expect(Object.isFrozen(AGENT_USER_MESSAGE_AUDIENCE)).toBe(true);
    expect(Object.isFrozen(AGENT_ASSISTANT_MESSAGE_AUDIENCE)).toBe(true);
    expect(Object.isFrozen(AGENT_TOOL_RESULT_MESSAGE_AUDIENCE)).toBe(true);
  });
});

describe("Phase 5A source provenance", () => {
  it("accepts every frozen user origin", () => {
    for (const origin of ["GOAL", "FOLLOW_UP", "STEERING"] as const) {
      const message = userMessage({ origin }).message;
      expect(message.source).toEqual({ kind: "USER", origin });
    }
  });

  it("records model and Tool provenance with the producing identity", () => {
    const assistant = assistantMessage({ text: "hi", callId: "llm_42" }).message;
    expect(assistant.source).toEqual({ kind: "MODEL", callId: "llm_42" });

    const toolResult = toolResultMessage().message;
    expect(toolResult.source).toEqual({ kind: "TOOL", observationId: OBSERVATION_ID });
  });

  it("refuses a LEGACY source on a newly created message (freeze §32)", () => {
    // The legacy arm exists for 5B/5F migration. A new message must not claim one.
    const factoryInstance = factory();
    expect(() =>
      factoryInstance.createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: legacyMessageSource("user"),
        content: [agentTextPart("migrated")],
      }),
    ).toThrow(TypeError);
  });

  it("refuses a source that contradicts the message kind", () => {
    const factoryInstance = factory();
    expect(() =>
      factoryInstance.createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: modelMessageSource("llm_1"),
        content: [agentTextPart("hello")],
      }),
    ).toThrow(TypeError);

    expect(() =>
      factoryInstance.createToolResult({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: userMessageSource("GOAL"),
        toolCallId: "call_1",
        toolName: "tool_0",
        observationId: OBSERVATION_ID as never,
        isError: false,
        projectedContent: "x",
        projection: RECEIPT,
      }),
    ).toThrow(TypeError);
  });
});

describe("Phase 5A user message", () => {
  const factoryInstance = () => factory();

  it("accepts text only", () => {
    const message = userMessage().message;
    expect(message.type).toBe("USER");
    expect(message.content).toEqual([{ type: "TEXT", text: "hello" }]);
  });

  it("accepts an attachment reference only", () => {
    const message = factoryInstance().createUser({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      source: userMessageSource("GOAL"),
      content: [agentAttachmentRefPart({ artifactId: "art_1" })],
    });
    expect(message.content).toEqual([{ type: "ATTACHMENT_REF", artifactId: "art_1" }]);
  });

  it("accepts text and an attachment together, in order", () => {
    const message = userMessage({ withAttachment: true }).message;
    expect(message.content).toHaveLength(2);
    expect(message.content[0]?.type).toBe("TEXT");
    expect(message.content[1]).toEqual({
      type: "ATTACHMENT_REF",
      artifactId: "art_1",
      label: "diagram",
      mediaType: "image/png",
    });
  });

  it("omits absent optional attachment fields rather than writing empty strings", () => {
    const part = agentAttachmentRefPart({ artifactId: "art_1" });
    expect(Object.keys(part).sort()).toEqual(["artifactId", "type"]);
  });

  it("refuses empty content", () => {
    expect(() =>
      factoryInstance().createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: userMessageSource("GOAL"),
        content: [],
      }),
    ).toThrow(TypeError);
  });

  it("refuses content that is only empty text", () => {
    expect(() =>
      factoryInstance().createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: userMessageSource("GOAL"),
        content: [agentTextPart("")],
      }),
    ).toThrow(TypeError);
  });

  it("refuses an attachment reference with no artifact", () => {
    expect(() =>
      factoryInstance().createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: userMessageSource("GOAL"),
        content: [{ type: "ATTACHMENT_REF", artifactId: "" }],
      }),
    ).toThrow(TypeError);
  });
});

describe("Phase 5A assistant message", () => {
  const factoryInstance = () => factory();

  it("accepts text only", () => {
    const message = assistantMessage({ text: "thinking" }).message;
    expect(message.type).toBe("ASSISTANT");
    expect(message.content).toEqual([{ type: "TEXT", text: "thinking" }]);
  });

  it("accepts tool calls only", () => {
    const message = assistantMessage({ toolCalls: ["call_1"] }).message;
    expect(message.content).toEqual([
      { type: "TOOL_CALL", toolCallId: "call_1", toolName: "tool_0", input: { index: 0 } },
    ]);
  });

  it("accepts text and tool calls together and preserves the model's order", () => {
    const message = assistantMessage({
      text: "let me look",
      toolCalls: ["call_1", "call_2"],
    }).message;
    expect(message.content.map((part) => part.type)).toEqual(["TEXT", "TOOL_CALL", "TOOL_CALL"]);
    expect(message.content[1]).toMatchObject({ toolCallId: "call_1", toolName: "tool_0" });
    expect(message.content[2]).toMatchObject({ toolCallId: "call_2", toolName: "tool_1" });
  });

  it("refuses a duplicate toolCallId inside one message (freeze §42)", () => {
    expect(() =>
      factoryInstance().createAssistant({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: modelMessageSource("llm_1"),
        content: [
          agentAssistantToolCallPart({ toolCallId: "call_1", toolName: "a", input: {} }),
          agentAssistantToolCallPart({ toolCallId: "call_1", toolName: "b", input: {} }),
        ],
        model: {
          kind: "MODEL_TURN",
          callId: "llm_1",
          model: { provider: "p", model: "m" },
          finishReason: "STOP",
        },
      }),
    ).toThrow(TypeError);
  });

  it("refuses empty content", () => {
    expect(() =>
      factoryInstance().createAssistant({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: modelMessageSource("llm_1"),
        content: [],
        model: {
          kind: "MODEL_TURN",
          callId: "llm_1",
          model: { provider: "p", model: "m" },
          finishReason: "STOP",
        },
      }),
    ).toThrow(TypeError);
  });

  it("creates MODEL_TURN provenance with the AI canonical types", () => {
    const message = assistantMessage({ text: "hi" }).message;
    expect(message.model.kind).toBe("MODEL_TURN");
    const model: AgentAssistantModelProvenance = message.model;
    if (model.kind !== "MODEL_TURN") throw new Error("unreachable");
    expect(model.callId).toBe("llm_1");
    expect(model.model).toEqual({ provider: "example-provider", model: "example-model" });
    expect(model.finishReason).toBe("STOP");
  });

  it("refuses to create LEGACY_MODEL_TURN provenance (freeze §46)", () => {
    expect(() =>
      factoryInstance().createAssistant({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: modelMessageSource("llm_1"),
        content: [agentAssistantTextPart("migrated")],
        // The factory's input type excludes this arm; the cast models a caller that
        // bypassed the type system from decoded JSON.
        model: { kind: "LEGACY_MODEL_TURN" } as never,
      }),
    ).toThrow(TypeError);
  });

  it("carries an optional provider state and omits it when absent", () => {
    const withState = assistantMessage({
      text: "hi",
      providerState: {
        providerId: "provider-alpha",
        api: "alpha-messages",
        version: 1,
        payload: { signature: "opaque" },
      },
    }).message;
    expect(withState.providerState).toEqual({
      providerId: "provider-alpha",
      api: "alpha-messages",
      version: 1,
      payload: { signature: "opaque" },
    });

    const withoutState = assistantMessage({ text: "hi" }).message;
    expect("providerState" in withoutState).toBe(false);
  });

  it("freezes the message and its content array", () => {
    const message = assistantMessage({ text: "hi", toolCalls: ["call_1"] }).message;
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(Object.isFrozen(message.model)).toBe(true);
  });
});

describe("Phase 5A tool result message", () => {
  it("carries identity, error flag and the exact projected content", () => {
    const message = toolResultMessage().message;
    expect(message.type).toBe("TOOL_RESULT");
    expect(message.toolCallId).toBe("call_1");
    expect(message.toolName).toBe("tool_0");
    expect(message.observationId).toBe(OBSERVATION_ID);
    expect(message.isError).toBe(false);
    expect(message.projectedContent).toBe("tool output");
  });

  it("supports both isError values", () => {
    expect(toolResultMessage({ isError: true }).message.isError).toBe(true);
    expect(toolResultMessage({ isError: false }).message.isError).toBe(false);
  });

  it("preserves projectedContent exactly, including whitespace and markers", () => {
    const content = "line 1\n  line 2\n\n[output truncated to fit the model budget]\t";
    expect(toolResultMessage({ projectedContent: content }).message.projectedContent).toBe(content);
  });

  it("carries the projection receipt with the frozen version", () => {
    const message = toolResultMessage().message;
    expect(TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION).toBe(1);
    expect(message.projection.version).toBe(1);
    expect(message.projection.policy).toEqual({
      maxSingleObservationTokens: 1000,
      maxObservationBatchTokens: 4000,
    });
    expect(message.projection.fingerprint).toBe("fixture-fingerprint");
  });

  it("refuses a receipt with an unknown version", () => {
    expect(() =>
      factory().createToolResult({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: toolMessageSource(OBSERVATION_ID as never),
        toolCallId: "call_1",
        toolName: "tool_0",
        observationId: OBSERVATION_ID as never,
        isError: false,
        projectedContent: "x",
        projection: { ...RECEIPT, version: 2 as never },
      }),
    ).toThrow(TypeError);
  });

  it("refuses an unnamed call or tool", () => {
    for (const broken of [{ toolCallId: "" }, { toolName: "" }]) {
      expect(() =>
        factory().createToolResult({
          runId: RUN_ID as never,
          sessionId: SESSION_ID as never,
          conversationTurnId: turnIdFor(),
          source: toolMessageSource(OBSERVATION_ID as never),
          toolCallId: "call_1",
          toolName: "tool_0",
          observationId: OBSERVATION_ID as never,
          isError: false,
          projectedContent: "x",
          projection: RECEIPT,
          ...broken,
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("Phase 5A Message Factory — identity, scope and determinism", () => {
  it("mints identity before anything durable is attempted", () => {
    // A scripted factory that refuses to mint is proof the id came from the injected
    // authority rather than from a store: the message cannot exist without it.
    const exhausted = createScriptedAgentMessageIdFactory([]);
    const factoryInstance = createAgentMessageFactory({
      ids: exhausted,
      now: () => CREATED_AT,
      turns,
    });
    expect(() =>
      factoryInstance.createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        conversationTurnId: turnIdFor(),
        source: userMessageSource("GOAL"),
        content: [agentTextPart("hello")],
      }),
    ).toThrow(RangeError);
  });

  it("produces byte-identical messages from scripted ids and a fixed clock", () => {
    // Determinism is a property of the *factory*, not of the fixtures: two factories given the
    // same identity script and the same clock must produce the same message, and a factory
    // must never read a clock it was not handed.
    const input = {
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      source: userMessageSource("GOAL" as const),
      content: [agentTextPart("hello")],
    };
    const first = factory().createUser(input);
    const second = factory().createUser(input);
    expect(second).toEqual(first);
    expect(first.createdAt).toBe(CREATED_AT);
    expect(isAgentMessageId(first.id)).toBe(true);
  });

  it("gives two messages distinct identities from the live factory", () => {
    const factoryInstance = liveFactory();
    const first = factoryInstance.createUser({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      source: userMessageSource("GOAL"),
      content: [agentTextPart("a")],
    });
    const second = factoryInstance.createUser({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      source: userMessageSource("GOAL"),
      content: [agentTextPart("b")],
    });
    expect(first.id).not.toBe(second.id);
    expect(isAgentMessageId(first.id)).toBe(true);
  });

  it("refuses an empty scope rather than writing an unscoped message", () => {
    const factoryInstance = factory();
    const scope = {
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
    };
    // Each blanked member in turn, so the refusal is proved per field rather than once.
    for (const blanked of ["runId", "sessionId", "conversationTurnId"] as const) {
      expect(() =>
        factoryInstance.createUser({
          ...scope,
          [blanked]: "",
          source: userMessageSource("GOAL"),
          content: [agentTextPart("x")],
        }),
      ).toThrow(TypeError);
    }
  });

  it("cross-checks the turn identity against the Run when a turn factory is injected", () => {
    const factoryInstance = factory();
    expect(() =>
      factoryInstance.createUser({
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        // A turn belonging to a different Run.
        conversationTurnId: turnIdFor(OTHER_RUN_ID),
        source: userMessageSource("GOAL"),
        content: [agentTextPart("x")],
      }),
    ).toThrow(TypeError);
  });

  it("keeps sourceStepId optional and copies it when present", () => {
    expect(userMessage().message.sourceStepId).toBe("stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e01");
  });
});
