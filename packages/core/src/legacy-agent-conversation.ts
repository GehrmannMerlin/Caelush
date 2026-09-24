import type { AIMessage, AIToolResultMessage, AIUserMessage } from "@caelush/ai";
import type { AgentRun, StepId } from "@caelush/protocol";
import {
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentTextPart,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createAgentConversationSnapshot,
  createConversationTurn,
  fingerprintProjection,
  modelMessageSource,
  NO_TOOL_RESULT_OBSERVATION,
  STRUCTURAL_TOKEN_ESTIMATOR,
  toolFeedbackPolicySnapshot,
  toolMessageSource,
  userMessageSource,
  createDeterministicConversationTurnIdFactory,
  type AgentConversationSnapshot,
  type AgentTurnInput,
  type AgentToolCallsDecision,
  type StoredAgentMessage,
} from "@caelush/agent";

/**
 * Compatibility-only input accepted by the retired Core facade.
 *
 * Production Run execution never constructs this shape. The facade is still public for old hosts,
 * so it translates its legacy LLM values into the Phase 5D durable-reference contract at this one
 * boundary instead of widening the Agent Kernel again.
 */
export type LegacyFacadeTurnInput =
  | { readonly kind: "USER_INPUT"; readonly messages: readonly AIUserMessage[] }
  | {
      readonly kind: "TOOL_RESULTS";
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      readonly results: readonly AIToolResultMessage[];
    }
  | {
      readonly kind: "CONTINUATION";
      readonly reason: "VERIFICATION_REPAIR" | "STEERING";
      readonly messages?: readonly AIUserMessage[];
    };

export interface LegacyFacadeConversationInput {
  readonly conversation: AgentConversationSnapshot;
  readonly input: AgentTurnInput;
}

/** Translate one legacy facade attempt into a semantic snapshot and durable ID references. */
export function createLegacyFacadeConversation(input: {
  readonly run: AgentRun;
  readonly history: readonly AIMessage[];
  readonly appendPrefix: readonly AIMessage[];
  readonly turnInput: LegacyFacadeTurnInput;
}): LegacyFacadeConversationInput {
  const turns = createDeterministicConversationTurnIdFactory();
  const factory = createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => input.run.createdAt,
    turns,
  });
  const aiMessages = [...input.history, ...input.appendPrefix]
    .filter(
      (message): message is Exclude<AIMessage, { role: "system" }> => message.role !== "system",
    );
  const messages: StoredAgentMessage[] = [];
  let sequence = 1;
  for (const [index, message] of aiMessages.entries()) {
    const created = createStoredMessage(
      factory,
      input.run,
      message,
      index,
      input.turnInput.kind === "TOOL_RESULTS" ? input.turnInput.sourceStepId : undefined,
    );
    messages.push(
      Object.freeze({
        sequence,
        schemaVersion: 1,
        modelProjectionVersion: 1,
        message: created,
      }),
    );
    sequence += 1;
  }
  const status =
    input.run.status === "COMPLETED" ||
    input.run.status === "FAILED" ||
    input.run.status === "CANCELLED" ||
    input.run.status === "TIMEOUT" ||
    input.run.status === "MAX_STEPS_REACHED" ||
    input.run.status === "BUDGET_EXCEEDED"
      ? "CLOSED"
      : "OPEN";
  const turn =
    status === "CLOSED"
      ? createConversationTurn({
          id: turns.forRun(input.run.id),
          sessionId: input.run.sessionId,
          runId: input.run.id,
          status,
          openedAt: input.run.createdAt,
          closedAt: input.run.finishedAt ?? input.run.createdAt,
          messages,
        })
      : createConversationTurn({
          id: turns.forRun(input.run.id),
          sessionId: input.run.sessionId,
          runId: input.run.id,
          status,
          openedAt: input.run.createdAt,
          messages,
        });
  const conversation = createAgentConversationSnapshot({
    sessionId: input.run.sessionId,
    currentRunId: input.run.id,
    currentTurnId: turn.id,
    turns: [turn],
  });
  return { conversation, input: durableInput(input.turnInput, messages) };
}

function createStoredMessage(
  factory: ReturnType<typeof createAgentMessageFactory>,
  run: AgentRun,
  message: Exclude<AIMessage, { role: "system" }>,
  index: number,
  sourceStepId?: StepId,
) {
  const turn = createDeterministicConversationTurnIdFactory().forRun(run.id);
  switch (message.role) {
    case "user":
      return factory.createUser({
        runId: run.id,
        sessionId: run.sessionId,
        conversationTurnId: turn,
        source: userMessageSource("GOAL"),
        content: [agentTextPart(message.content)],
      });
    case "assistant":
      return factory.createAssistant({
        runId: run.id,
        sessionId: run.sessionId,
        conversationTurnId: turn,
        source: modelMessageSource(`legacy_facade_${String(index)}`),
        ...(sourceStepId === undefined ? {} : { sourceStepId }),
        content: message.content.map((part) =>
          part.type === "text"
            ? agentAssistantTextPart(part.text)
            : agentAssistantToolCallPart({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              }),
        ),
        model: {
          kind: "MODEL_TURN",
          callId: `legacy_facade_${String(index)}`,
          model: { provider: run.model.provider, model: run.model.model },
          finishReason: "OTHER",
        },
      });
    case "tool": {
      const projection = {
        policy: toolFeedbackPolicySnapshot({
          maxSingleObservationTokens: STRUCTURAL_TOKEN_ESTIMATOR.estimateMessages([message]),
          maxObservationBatchTokens: STRUCTURAL_TOKEN_ESTIMATOR.estimateMessages([message]),
        }),
        fingerprint: fingerprintProjection([message]),
        version: 1 as const,
      };
      return factory.createToolResult({
        runId: run.id,
        sessionId: run.sessionId,
        conversationTurnId: turn,
        source: toolMessageSource(),
        ...(sourceStepId === undefined ? {} : { sourceStepId }),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        observation: NO_TOOL_RESULT_OBSERVATION,
        isError: message.isError,
        projectedContent: message.content,
        projection,
      });
    }
  }
}

function durableInput(
  input: LegacyFacadeTurnInput,
  messages: readonly StoredAgentMessage[],
): AgentTurnInput {
  if (input.kind === "USER_INPUT") {
    const user = [...messages].reverse().find((entry) => entry.message.type === "USER");
    if (user === undefined) throw new Error("Legacy facade USER_INPUT has no durable user record.");
    return { kind: "USER_INPUT", userMessageId: user.message.id };
  }
  if (input.kind === "TOOL_RESULTS") {
    const results = messages
      .filter(
        (
          entry,
        ): entry is StoredAgentMessage & {
          message: Extract<StoredAgentMessage["message"], { type: "TOOL_RESULT" }>;
        } => entry.message.type === "TOOL_RESULT",
      )
      .slice(-input.results.length)
      .map((entry) => entry.message.id);
    return {
      kind: "TOOL_RESULTS",
      sourceStepId: input.sourceStepId,
      pendingDecision: input.pendingDecision,
      toolResultMessageIds: results,
    };
  }
  const ids = (input.messages ?? [])
    .map((message) => message.content)
    .flatMap((content) =>
      messages
        .filter(
          (entry) =>
            entry.message.type === "USER" &&
            entry.message.content.some((part) => part.type === "TEXT" && part.text === content),
        )
        .map((entry) => entry.message.id),
    );
  return {
    kind: "CONTINUATION",
    reason: input.reason,
    ...(ids.length === 0 ? {} : { messageIds: ids }),
  };
}
