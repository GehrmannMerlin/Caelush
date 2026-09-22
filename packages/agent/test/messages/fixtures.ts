import type { AIFinishReason, ModelRef } from "@caelush/ai";
import type { TimestampMs } from "@caelush/protocol";

import {
  STRUCTURAL_TOKEN_ESTIMATOR,
  agentAttachmentRefPart,
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentTextPart,
  createAgentAssistantMessage,
  createAgentConversationSnapshot,
  createAgentMessageBase,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createAgentToolResultMessage,
  createAgentUserMessage,
  createConversationTurn,
  createDeterministicConversationTurnIdFactory,
  createScriptedAgentMessageIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  conversationTurnStatus,
  legacyMessageSource,
  modelMessageSource,
  projectionVersionTable,
  toolMessageSource,
  toolResultObservation,
  userMessageSource,
  NO_TOOL_RESULT_OBSERVATION,
} from "@caelush/agent";
import type {
  AgentAssistantMessage,
  AgentConversationSnapshot,
  AgentMessageAudience,
  AgentToolResultMessage,
  AgentUserMessage,
  ConversationTurn,
  StoredAgentMessage,
  ToolFeedbackProjectionReceipt,
  ToolResultObservationRef,
} from "@caelush/agent";

/**
 * Fixtures for the Phase 5A Message Domain tests.
 *
 * They are typed against the **package root** on purpose, exactly as a consumer would be: a
 * fixture that reached into `@caelush/agent/src/messages/...` would prove a deep import works,
 * which is the one thing the public surface must not require.
 *
 * Everything here is deterministic — scripted ids, a fixed clock, a fixed turn derivation — so
 * a failure names a rule rather than a race.
 */

export const RUN_ID = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a";
export const OTHER_RUN_ID = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
export const SESSION_ID = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b";
export const OBSERVATION_ID = "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d";
/** A fixed millisecond clock, branded so a fixture can pass it wherever a timestamp is required. */
export const CREATED_AT = 1_700_000_000_000 as TimestampMs;

const MODEL: ModelRef = { provider: "example-provider", model: "example-model" };

const FINISH_REASON: AIFinishReason = "STOP";

export const turns = createDeterministicConversationTurnIdFactory();

export function turnIdFor(runId: string = RUN_ID) {
  return turns.forRun(runId as never);
}

/** A scripted message-id factory over sequential, well-formed ids. */
export function scriptedIds(count = 512) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    ids.push(`amsg_0192f5b1-4d3a-7c2e-8a91-${suffix}`);
  }
  return createScriptedAgentMessageIdFactory(ids);
}

/**
 * The one shared deterministic factory the fixture helpers draw from.
 *
 * It is shared, rather than recreated per message, for the same reason a real factory is: two
 * messages must never share an id, and a per-call factory would hand every message the same
 * scripted sequence. Tests that need their own identity sequence call {@link factory}.
 */
const sharedFactory = createAgentMessageFactory({
  ids: scriptedIds(),
  now: () => CREATED_AT,
  turns,
});

/** A Message Factory with its own scripted identity sequence and the fixed clock. */
export function factory(count = 64) {
  return createAgentMessageFactory({
    ids: scriptedIds(count),
    now: () => CREATED_AT,
    turns,
  });
}

/** A real (non-deterministic) factory, for id-shape tests. */
export function liveFactory() {
  return createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => CREATED_AT,
    turns,
  });
}

export const projectors = createStandardAgentMessageProjectorRegistry();

export const projectionVersions = projectionVersionTable({
  USER: 1,
  ASSISTANT: 1,
  TOOL_RESULT: 1,
});

export const codecs = createStandardAgentMessageCodecRegistry(projectionVersions);

export const RECEIPT: ToolFeedbackProjectionReceipt = {
  policy: {
    kind: "SNAPSHOT",
    snapshot: { maxSingleObservationTokens: 1000, maxObservationBatchTokens: 4000 },
  },
  fingerprint: "fixture-fingerprint",
  version: 1,
};

/**
 * The migration-only receipt.
 *
 * A migrated legacy row preserved what the model saw but not the policy it was projected under, so
 * this is what its receipt carries. It is never produced by the normal Message Factory.
 */
export const LEGACY_RECEIPT: ToolFeedbackProjectionReceipt = {
  policy: { kind: "LEGACY_UNKNOWN" },
  fingerprint: "fixture-fingerprint",
  version: 1,
};

/* ------------------------------------------------------------------------------ messages */

export function userMessage(
  options: {
    readonly messageFactory?: ReturnType<typeof factory>;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly turnId?: ReturnType<typeof turnIdFor>;
    readonly origin?: "GOAL" | "FOLLOW_UP" | "STEERING";
    readonly text?: string;
    readonly withAttachment?: boolean;
    readonly sequence?: number;
    readonly modelVisible?: boolean;
  } = {},
): StoredAgentMessage<AgentUserMessage> {
  const runId = options.runId ?? RUN_ID;
  const sessionId = options.sessionId ?? SESSION_ID;
  const conversationTurnId = options.turnId ?? turnIdFor(runId);
  const messageFactory = options.messageFactory ?? sharedFactory;
  const message = messageFactory.createUser({
    runId: runId as never,
    sessionId: sessionId as never,
    conversationTurnId,
    sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e01" as never,
    source: userMessageSource(options.origin ?? "GOAL"),
    content: [
      agentTextPart(options.text ?? "hello"),
      ...(options.withAttachment === true
        ? [
            agentAttachmentRefPart({
              artifactId: "art_1",
              label: "diagram",
              mediaType: "image/png",
            }),
          ]
        : []),
    ],
  });
  return stored(message, options.sequence ?? 1, options.modelVisible);
}

export function assistantMessage(
  options: {
    readonly messageFactory?: ReturnType<typeof factory>;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly turnId?: ReturnType<typeof turnIdFor>;
    readonly text?: string;
    readonly toolCalls?: readonly string[];
    readonly callId?: string;
    readonly sequence?: number;
    readonly modelVisible?: boolean;
    readonly providerState?: AgentAssistantMessage["providerState"];
  } = {},
): StoredAgentMessage<AgentAssistantMessage> {
  const runId = options.runId ?? RUN_ID;
  const sessionId = options.sessionId ?? SESSION_ID;
  const conversationTurnId = options.turnId ?? turnIdFor(runId);
  const messageFactory = options.messageFactory ?? sharedFactory;
  const toolCalls = options.toolCalls ?? [];
  const message = messageFactory.createAssistant({
    runId: runId as never,
    sessionId: sessionId as never,
    conversationTurnId,
    sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e02" as never,
    source: modelMessageSource(options.callId ?? "llm_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e03"),
    content: [
      ...(options.text === undefined ? [] : [agentAssistantTextPart(options.text)]),
      ...toolCalls.map((toolCallId, index) =>
        agentAssistantToolCallPart({
          toolCallId,
          toolName: `tool_${String(index)}`,
          input: { index },
        }),
      ),
    ],
    model: {
      kind: "MODEL_TURN",
      callId: options.callId ?? "llm_1",
      model: MODEL,
      finishReason: FINISH_REASON,
    },
    providerState: options.providerState,
  });
  return stored(message, options.sequence ?? 2, options.modelVisible);
}

export function toolResultMessage(
  options: {
    readonly messageFactory?: ReturnType<typeof factory>;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly turnId?: ReturnType<typeof turnIdFor>;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly projectedContent?: string;
    readonly sequence?: number;
    readonly modelVisible?: boolean;
    /**
     * Whether a real execution observation stands behind this feedback.
     *
     * Defaults to observation-backed, which is the executed-Tool case. `false` models the Tool
     * System's other legitimate producer: a rejected or skipped call, which reaches the model as
     * feedback but has no execution to point at.
     */
    readonly observationBacked?: boolean;
    /** The projection receipt. Defaults to a known policy; a migration supplies the unknown arm. */
    readonly projection?: ToolFeedbackProjectionReceipt;
  } = {},
): StoredAgentMessage<AgentToolResultMessage> {
  const runId = options.runId ?? RUN_ID;
  const sessionId = options.sessionId ?? SESSION_ID;
  const conversationTurnId = options.turnId ?? turnIdFor(runId);
  const messageFactory = options.messageFactory ?? sharedFactory;
  const message = messageFactory.createToolResult({
    runId: runId as never,
    sessionId: sessionId as never,
    conversationTurnId,
    sourceStepId: "stp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e02" as never,
    source: toolMessageSource(),
    toolCallId: options.toolCallId ?? "call_1",
    toolName: options.toolName ?? "tool_0",
    observation:
      options.observationBacked === false
        ? NO_TOOL_RESULT_OBSERVATION
        : toolResultObservation(OBSERVATION_ID as never),
    isError: options.isError ?? false,
    projectedContent: options.projectedContent ?? "tool output",
    projection: options.projection ?? RECEIPT,
  });
  return stored(message, options.sequence ?? 3, options.modelVisible);
}

/**
 * Wrap a message in its stored form.
 *
 * `modelVisible: false` narrows only the `model` flag, which is what the audience tests need:
 * a message that is durable and transcript-visible but invisible to the model.
 */
export function stored<
  TMessage extends AgentUserMessage | AgentAssistantMessage | AgentToolResultMessage,
>(message: TMessage, sequence: number, modelVisible?: boolean): StoredAgentMessage<TMessage> {
  const audience: AgentMessageAudience =
    modelVisible === undefined ? message.audience : { ...message.audience, model: modelVisible };
  return {
    sequence,
    schemaVersion: 1,
    modelProjectionVersion: 1,
    message: modelVisible === undefined ? message : ({ ...message, audience } as TMessage),
  };
}

/* --------------------------------------------------------------------------------- turns */

export function turn(
  messages: readonly StoredAgentMessage[],
  options: {
    readonly runId?: string;
    readonly sessionId?: string;
    readonly status?: "OPEN" | "CLOSED";
    readonly openedAt?: number;
  } = {},
): ConversationTurn {
  const runId = options.runId ?? RUN_ID;
  const status = options.status ?? "OPEN";
  return createConversationTurn({
    id: turnIdFor(runId),
    sessionId: (options.sessionId ?? SESSION_ID) as never,
    runId: runId as never,
    status,
    openedAt: (options.openedAt ?? 1) as never,
    ...(status === "CLOSED" ? { closedAt: 2 as never } : {}),
    messages,
  });
}

export function snapshot(
  turnsList: readonly ConversationTurn[],
  options: { readonly runId?: string; readonly sessionId?: string } = {},
): AgentConversationSnapshot {
  const runId = options.runId ?? RUN_ID;
  return createAgentConversationSnapshot({
    sessionId: (options.sessionId ?? SESSION_ID) as never,
    currentRunId: runId as never,
    currentTurnId: turnIdFor(runId),
    turns: turnsList,
  });
}

/* ------------------------------------------------------------------------------- re-exports */

/**
 * Bare, unstored messages, for tests that need to construct a message directly rather than
 * through the factory — the codec and projection suites in particular.
 */
export function rawUserMessage(text = "hello"): AgentUserMessage {
  return createAgentUserMessage(
    createAgentMessageBase({
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      createdAt: CREATED_AT as never,
      source: userMessageSource("GOAL"),
      audience: { model: true, transcript: true, debug: true },
    }),
    [agentTextPart(text)],
  );
}

export function rawAssistantMessage(
  content: readonly ReturnType<typeof agentAssistantTextPart | typeof agentAssistantToolCallPart>[],
  providerState?: AgentAssistantMessage["providerState"],
): AgentAssistantMessage {
  return createAgentAssistantMessage(
    createAgentMessageBase({
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000002" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(),
      createdAt: CREATED_AT as never,
      source: modelMessageSource("llm_fixture"),
      audience: { model: true, transcript: true, debug: true },
    }),
    content,
    { kind: "MODEL_TURN", callId: "llm_fixture", model: MODEL, finishReason: FINISH_REASON },
    providerState,
  );
}

export function rawToolResultMessage(
  projectedContent = "tool output",
  observation: ToolResultObservationRef = toolResultObservation(OBSERVATION_ID as never),
  projection: ToolFeedbackProjectionReceipt = RECEIPT,
): AgentToolResultMessage {
  return createAgentToolResultMessage(
    createAgentMessageBase({
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000003" as never,
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
      observation,
      isError: false,
      projectedContent,
      projection,
    },
  );
}

export {
  NO_TOOL_RESULT_OBSERVATION,
  STRUCTURAL_TOKEN_ESTIMATOR,
  conversationTurnStatus,
  legacyMessageSource,
  modelMessageSource,
  toolMessageSource,
  toolResultObservation,
  userMessageSource,
};
