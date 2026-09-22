import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_TOKEN_ESTIMATOR,
  assertAgentMessageAudience,
  assertAgentMessageProjectionVersion,
  assertAgentMessageSchemaVersion,
  assertAgentMessageSequence,
  assertAgentMessageSource,
  assertAgentUserContent,
  assertJsonSafePayload,
  createAgentConversationSnapshot,
  createAgentConversationValidator,
  createAgentMessageCodecRegistryBuilder,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createAgentMessageProjectorRegistry,
  createConversationSelector,
  createConversationTurn,
  createDeterministicConversationTurnIdFactory,
  createSingleTurnConversationSnapshot,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  digestJsonObject,
  isAgentMessageId,
  isConversationTurnId,
  projectionVersionTable,
  toolMessageSource,
  toolResultObservation,
  AgentMessageCodecError,
  AGENT_ASSISTANT_MESSAGE_CODEC_V1,
  AGENT_USER_MESSAGE_CODEC_V1,
} from "@caelush/agent";
import type { TimestampMs } from "@caelush/protocol";
import type {
  AgentAssistantMessage,
  AgentConversationSnapshot,
  AgentMessageRecord,
  AgentToolResultMessage,
  StoredAgentMessage,
} from "@caelush/agent";

/**
 * Phase 5A — the Message System V2 *independent-use* proof. Freeze §148.
 *
 * ```text
 * create a User message
 * encode it
 * construct a fake stored record
 * decode it
 * project it to an AIUserMessage
 * construct a ConversationTurn
 * validate the snapshot
 * select a conversation
 * ```
 *
 * The whole pipeline, using **only** `@caelush/agent`, `@caelush/ai` and `@caelush/protocol`.
 * Nothing here starts a daemon, opens a database, resolves a Runtime, composes a
 * `CodingAgent`, reads the filesystem or touches the network. That is the point: a Message
 * Domain that could only be exercised through a host would be a Message Domain whose
 * boundaries are decorative.
 */

const RUN_ID = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
const SESSION_ID = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b";
const OBSERVATION_ID = "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
const STEP_ID = "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d";

describe("Phase 5A independent use — the whole Message Domain with no host", () => {
  it("runs create → encode → store → decode → project → turn → validate → select", () => {
    /* ------------------------------------------------------------------ 1. create */

    const turns = createDeterministicConversationTurnIdFactory();
    const conversationTurnId = turns.forRun(RUN_ID as never);
    expect(isConversationTurnId(conversationTurnId)).toBe(true);

    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => 1_700_000_000_000 as TimestampMs,
      turns,
    });

    const user = factory.createUser({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId,
      sourceStepId: STEP_ID as never,
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "summarize the change" }],
    });
    expect(user.type).toBe("USER");
    expect(isAgentMessageId(user.id)).toBe(true);

    const assistant = factory.createAssistant({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId,
      sourceStepId: STEP_ID as never,
      source: { kind: "MODEL", callId: "llm_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9e" },
      content: [{ type: "TEXT", text: "let me check" }],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9e",
        model: { provider: "example-provider", model: "example-model" },
        finishReason: "STOP",
      },
    });

    /* ------------------------------------------------------------------ 2. encode */

    const projectors = createStandardAgentMessageProjectorRegistry();
    const codecs = createStandardAgentMessageCodecRegistry((type) =>
      projectors.currentVersion(type),
    );

    const userDraft = codecs.encode(user);
    const assistantDraft = codecs.encode(assistant);
    expect(userDraft.schemaVersion).toBe(1);
    // Every model-visible message records the projector version that produced its model view.
    expect(userDraft.modelProjectionVersion).toBe(projectors.currentVersion("USER"));
    expect(assistantDraft.modelProjectionVersion).toBe(projectors.currentVersion("ASSISTANT"));

    /* ------------------------------------------------- 3. construct a fake stored record */

    // A record as Phase 5B will write one: the envelope carries identity, scope and audience;
    // `data` carries only the type-specific payload. One authority per fact.
    const userRecord: AgentMessageRecord = {
      messageId: user.id,
      runId: user.runId,
      sessionId: user.sessionId,
      sequence: 1,
      conversationTurnId: user.conversationTurnId,
      messageType: user.type,
      schemaVersion: userDraft.schemaVersion,
      modelProjectionVersion: userDraft.modelProjectionVersion as number,
      sourceStepId: user.sourceStepId as never,
      createdAt: user.createdAt,
      source: user.source,
      audience: user.audience,
      data: AGENT_USER_MESSAGE_CODEC_V1.encode(user),
    };
    const assistantRecord: AgentMessageRecord = {
      messageId: assistant.id,
      runId: assistant.runId,
      sessionId: assistant.sessionId,
      sequence: 2,
      conversationTurnId: assistant.conversationTurnId,
      messageType: assistant.type,
      schemaVersion: assistantDraft.schemaVersion,
      modelProjectionVersion: assistantDraft.modelProjectionVersion as number,
      sourceStepId: assistant.sourceStepId as never,
      createdAt: assistant.createdAt,
      source: assistant.source,
      audience: assistant.audience,
      data: AGENT_ASSISTANT_MESSAGE_CODEC_V1.encode(assistant),
    };

    /* ------------------------------------------------------------------ 4. decode */

    const decodedUser = codecs.decode(userRecord);
    expect(decodedUser).toEqual(user);
    const decodedAssistant = codecs.decode(assistantRecord);
    expect(decodedAssistant).toEqual(assistant);

    /* ------------------------------------------------ 5. project to an AIUserMessage */

    const storedMessages: StoredAgentMessage[] = [
      {
        sequence: 1,
        schemaVersion: userRecord.schemaVersion,
        // Present because the message is model-visible: the codec registry guarantees a
        // projection version for one, so the stored record always carries it.
        modelProjectionVersion: userRecord.modelProjectionVersion as number,
        message: decodedUser,
      },
      {
        sequence: 2,
        schemaVersion: assistantRecord.schemaVersion,
        modelProjectionVersion: assistantRecord.modelProjectionVersion as number,
        message: decodedAssistant,
      },
    ];

    const userProjection = projectors.project(storedMessages[0] as StoredAgentMessage);
    expect(userProjection.messages).toEqual([{ role: "user", content: "summarize the change" }]);
    expect(userProjection.messages[0]?.role).toBe("user");
    const assistantProjection = projectors.project(storedMessages[1] as StoredAgentMessage);
    expect(assistantProjection.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "let me check" }] },
    ]);

    /* --------------------------------------------- 6. construct a ConversationTurn */

    const turn = createConversationTurn({
      id: conversationTurnId,
      sessionId: SESSION_ID as never,
      runId: RUN_ID as never,
      status: "OPEN",
      openedAt: user.createdAt as never,
      messages: storedMessages,
    });
    expect(turn.messages).toHaveLength(2);

    const conversation: AgentConversationSnapshot = createSingleTurnConversationSnapshot({
      sessionId: SESSION_ID as never,
      runId: RUN_ID as never,
      turn,
    });

    /* ------------------------------------------------- 7. validate the snapshot */

    createAgentConversationValidator().validate(conversation);

    /* ------------------------------------------------- 8. select a conversation */

    const selector = createConversationSelector({ projector: projectors });
    const selected = selector.select({
      conversation,
      maxTokens: 1_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(selected.droppedMessageIds).toEqual([]);
    expect(selected.selectedMessageIds).toEqual([user.id, assistant.id]);
    expect(selected.requiresCompaction).toBe(false);
    expect(selected.estimatedTokens).toBeGreaterThan(0);

    // And the selected conversation still projects to something a provider could be sent.
    const projected = selected.turns.flatMap((selectedTurn) =>
      selectedTurn.messages.flatMap((entry) =>
        projectors.project(entry).messages.map((message) => message.role),
      ),
    );
    expect(projected).toEqual(["user", "assistant"]);
  });

  it("runs the same pipeline for a Tool exchange with no host services", () => {
    const turns = createDeterministicConversationTurnIdFactory();
    const conversationTurnId = turns.forRun(RUN_ID as never);
    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => 1_700_000_000_000 as TimestampMs,
      turns,
    });

    const assistant = factory.createAssistant({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId,
      source: { kind: "MODEL", callId: "llm_tool_turn" },
      content: [
        {
          type: "TOOL_CALL",
          toolCallId: "call_1",
          toolName: "read_file",
          input: { path: "src/index.ts" },
        },
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_tool_turn",
        model: { provider: "example-provider", model: "example-model" },
        finishReason: "TOOL_CALLS",
      },
    });

    // The Tool result message carries what the model was shown. No observation is loaded:
    // the text is the historical truth, and the observation reference is a pointer of record.
    const toolResult = factory.createToolResult({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId,
      source: toolMessageSource(),
      toolCallId: "call_1",
      toolName: "read_file",
      observation: toolResultObservation(OBSERVATION_ID as never),
      isError: false,
      projectedContent: "export const answer = 42;",
      projection: {
        policy: {
          kind: "SNAPSHOT",
          snapshot: { maxSingleObservationTokens: 512, maxObservationBatchTokens: 2048 },
        },
        fingerprint: digestJsonObject({ content: "export const answer = 42;" }),
        version: 1,
      },
    });
    expect(toolResult.projectedContent).toBe("export const answer = 42;");

    const projectors = createStandardAgentMessageProjectorRegistry();
    const codecs = createStandardAgentMessageCodecRegistry((type) =>
      projectors.currentVersion(type),
    );

    // A real round trip through the durable encoding, so the Tool pipeline is proved end to
    // end rather than only in its in-memory shape.
    const assistantDraft = codecs.encode(assistant);
    const toolDraft = codecs.encode(toolResult);
    // `encode` returns a *draft*: the versioned `data` payload plus the versions to store.
    // The envelope is supplied by whoever owns the ledger — here, the test.
    expect(assistantDraft.message).not.toHaveProperty("messageId");
    expect(assistantDraft.schemaVersion).toBe(1);

    const recordFor = (
      message: AgentAssistantMessage | AgentToolResultMessage,
      data: Record<string, unknown>,
      sequence: number,
    ) =>
      ({
        messageId: message.id,
        runId: message.runId,
        sessionId: message.sessionId,
        sequence,
        conversationTurnId: message.conversationTurnId,
        messageType: message.type,
        schemaVersion: 1,
        modelProjectionVersion: 1,
        createdAt: message.createdAt,
        source: message.source,
        audience: message.audience,
        data,
      }) as never;

    const decodedAssistant = codecs.decode(
      recordFor(assistant, assistantDraft.message as never, 1),
    );
    const decodedToolResult = codecs.decode(recordFor(toolResult, toolDraft.message as never, 2));
    expect(decodedAssistant).toEqual(assistant);
    expect(decodedToolResult).toEqual(toolResult);

    const turn = createConversationTurn({
      id: conversationTurnId,
      sessionId: SESSION_ID as never,
      runId: RUN_ID as never,
      status: "OPEN",
      openedAt: assistant.createdAt as never,
      messages: [
        { sequence: 1, schemaVersion: 1, modelProjectionVersion: 1, message: decodedAssistant },
        { sequence: 2, schemaVersion: 1, modelProjectionVersion: 1, message: decodedToolResult },
      ],
    });
    const conversation = createAgentConversationSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
      currentTurnId: conversationTurnId,
      turns: [turn],
    });
    createAgentConversationValidator().validate(conversation);

    const selected = createConversationSelector({ projector: projectors }).select({
      conversation,
      maxTokens: 10_000,
      estimator: STRUCTURAL_TOKEN_ESTIMATOR,
    });
    expect(selected.selectedMessageIds).toEqual([assistant.id, toolResult.id]);

    const projected = projectors.project(turn.messages[1] as never);
    expect(projected.messages).toEqual([
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "export const answer = 42;",
        isError: false,
      },
    ]);
  });

  it("refuses an undecodable record without needing a store to notice", () => {
    const codecs = createStandardAgentMessageCodecRegistry();
    try {
      codecs.decode({
        messageId: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
        runId: RUN_ID as never,
        sessionId: SESSION_ID as never,
        sequence: 1,
        conversationTurnId: "cturn_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
        messageType: "FROM_THE_FUTURE",
        schemaVersion: 1,
        createdAt: 1_700_000_000_000 as never,
        source: { kind: "AGENT", producer: "future" },
        audience: { model: true, transcript: true, debug: true },
        data: {},
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMessageCodecError);
      expect((error as AgentMessageCodecError).reason).toBe("CODEC_UNAVAILABLE");
    }
  });

  it("exercises every exported guard without a host", () => {
    expect(() => {
      assertAgentMessageAudience({ model: true, transcript: false, debug: true });
      assertAgentMessageSource({ kind: "USER", origin: "STEERING" });
      assertAgentUserContent([{ type: "TEXT", text: "x" }]);
      assertAgentMessageSchemaVersion(1);
      assertAgentMessageProjectionVersion(1);
      assertAgentMessageSequence(1);
      assertJsonSafePayload({ a: 1 }, "USER");
    }).not.toThrow();

    expect(() => assertAgentMessageAudience({ model: "yes" })).toThrow(TypeError);
    expect(() => assertAgentMessageSchemaVersion(0)).toThrow(TypeError);
    expect(() => assertAgentMessageProjectionVersion(0)).toThrow(TypeError);
    expect(() => assertAgentMessageSequence(0)).toThrow(TypeError);
    expect(() => assertJsonSafePayload([], "USER")).toThrow();
  });

  it("builds a custom registry generation with no host either", () => {
    const builder = createAgentMessageCodecRegistryBuilder(
      projectionVersionTable({ USER: 1, ASSISTANT: 1, TOOL_RESULT: 1 }),
    );
    const registry = builder
      .register(AGENT_USER_MESSAGE_CODEC_V1)
      .register(AGENT_ASSISTANT_MESSAGE_CODEC_V1)
      .build();
    expect(registry.has("USER", 1)).toBe(true);
    expect(registry.has("TOOL_RESULT", 1)).toBe(false);

    const projectors = createAgentMessageProjectorRegistry({
      projectors: [
        {
          type: "USER",
          version: 1,
          project: () => ({ messages: [{ role: "user", content: "custom" }], fingerprint: "f" }),
        },
      ],
    });
    expect(projectors.has("USER", 1)).toBe(true);
  });
});
