import type { AIFinishReason, AIProviderOpaqueState, ModelRef, ModelUsage } from "@caelush/ai";
import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

import type { AgentMessageSource } from "./source.js";
import {
  AGENT_ASSISTANT_MESSAGE_AUDIENCE,
  AGENT_TOOL_RESULT_MESSAGE_AUDIENCE,
  AGENT_USER_MESSAGE_AUDIENCE,
} from "./audience.js";
import type { AgentAssistantContentPart, AgentUserContentPart } from "./content.js";
import type { AgentMessageIdFactory, ConversationTurnId } from "./ids.js";
import { createAgentMessageBase } from "./message-base.js";
import type { AgentAssistantModelProvenance } from "./assistant-message.js";
import { createAgentAssistantMessage } from "./assistant-message.js";
import { createAgentToolResultMessage } from "./tool-result-message.js";
import type { ToolFeedbackProjectionReceipt } from "./tool-result-message.js";
import type { ToolResultObservationRef } from "./tool-result-observation.js";
import { createAgentUserMessage } from "./user-message.js";
import type { AgentAssistantMessage } from "./assistant-message.js";
import type { AgentToolResultMessage } from "./tool-result-message.js";
import type { AgentUserMessage } from "./user-message.js";

/**
 * The one authority that creates Agent messages.
 *
 * ```text
 * createUser         a user turn
 * createAssistant    a model turn
 * createToolResult   a Tool's answer
 * ```
 *
 * ## What it owns
 *
 * ```text
 * id                   minted before anything durable is attempted
 * createdAt            read from the injected clock, exactly once per message
 * audience defaults    from the per-kind constants, never restated
 * base invariants      identity, scope and provenance consistency
 * ```
 *
 * ## What it deliberately does not own
 *
 * ```text
 * storage         it writes nothing and knows no schema
 * runtime         it reads no clock it was not handed and holds no process state
 * providers       it never calls a model and never interprets provider state
 * tools           it never executes, prepares or projects a Tool result
 * context         it selects nothing and renders no prompt
 * transcript      it produces no user-facing view
 * ```
 *
 * Every one of those is a separate authority with its own contract, and a factory that
 * reached into any of them would make message creation depend on a subsystem that is
 * supposed to depend on messages.
 *
 * ## Scope is checked here, once
 *
 * `runId`, `sessionId` and `conversationTurnId` are supplied by the caller because the
 * Run Layer owns Run identity and the turn factory derives turn identity. The Factory
 * refuses an empty value for any of them rather than writing a message whose scope is a
 * blank string, because an unscoped durable message is one no query will ever find.
 */
export interface AgentMessageFactory {
  createUser(input: CreateAgentUserMessageInput): AgentUserMessage;

  createAssistant(input: CreateAgentAssistantMessageInput): AgentAssistantMessage;

  createToolResult(input: CreateAgentToolResultMessageInput): AgentToolResultMessage;
}

/** What every message creation needs: which conversation, and where in it. */
export interface AgentMessageScope {
  readonly runId: RunId;

  readonly sessionId: SessionId;

  readonly conversationTurnId: ConversationTurnId;

  readonly sourceStepId?: StepId | undefined;
}

export interface CreateAgentUserMessageInput extends AgentMessageScope {
  readonly source: AgentMessageSource;

  readonly content: readonly AgentUserContentPart[];
}

export interface CreateAgentAssistantMessageInput extends AgentMessageScope {
  readonly source: AgentMessageSource;

  readonly content: readonly AgentAssistantContentPart[];

  /**
   * The settled model turn this message came from.
   *
   * A `LEGACY_MODEL_TURN` provenance is refused: this factory creates new messages, and a
   * new message was not migrated from a pre-V2 row. The legacy arm belongs to Phase 5B's
   * backfill, which decodes existing rows rather than creating fresh ones.
   */
  readonly model: Extract<AgentAssistantModelProvenance, { kind: "MODEL_TURN" }>;

  readonly providerState?: AIProviderOpaqueState | undefined;
}

export interface CreateAgentToolResultMessageInput extends AgentMessageScope {
  readonly source: AgentMessageSource;

  readonly toolCallId: string;

  readonly toolName: string;

  /**
   * Whether a real execution observation exists behind this feedback.
   *
   * Both arms are accepted. The Tool System legitimately produces model-visible feedback for calls
   * that never executed — a rejected call, a skipped trailing call, a synthetic replan result — and
   * those results state `NO_OBSERVATION` rather than being refused or given a fabricated identity.
   */
  readonly observation: ToolResultObservationRef;

  readonly isError: boolean;

  /** The exact text the model was shown. Copied verbatim; never re-derived. */
  readonly projectedContent: string;

  /**
   * The projection receipt.
   *
   * Its `policy` must be a `SNAPSHOT`. A `LEGACY_UNKNOWN` policy is refused: this factory creates
   * *new* messages, and a new message was created under a policy that was known at the time. The
   * unknown arm exists for a migration describing a row whose policy really was never recorded.
   */
  readonly projection: ToolFeedbackProjectionReceipt;
}

export interface AgentMessageFactoryDependencies {
  /** The message identity authority. Storage is never one. */
  readonly ids: AgentMessageIdFactory;

  /** The clock. Injected so a deterministic test can produce a deterministic message. */
  readonly now: () => TimestampMs;

  /**
   * An optional cross-check for the turn identity.
   *
   * When supplied, every message is verified to belong to the turn that the Run derives.
   * A mismatch means the caller assembled a scope out of two different conversations, and
   * that is worth failing on rather than storing: the message would be unreachable by the
   * turn it claims, or reachable by one it does not.
   */
  readonly turns?: { forRun(runId: RunId): ConversationTurnId } | undefined;
}

/**
 * Build the canonical Message Factory.
 *
 * Stateless apart from its injected identity and clock, so two calls with the same
 * scripted ids and the same fixed clock produce byte-identical messages.
 */
export function createAgentMessageFactory(
  dependencies: AgentMessageFactoryDependencies,
): AgentMessageFactory {
  const { ids, now, turns } = dependencies;

  function base(
    input: AgentMessageScope,
    source: AgentMessageSource,
    audienceKind: "USER" | "ASSISTANT" | "TOOL_RESULT",
  ) {
    assertScope(input);
    assertSourceConsistency(source, audienceKind);
    if (turns !== undefined) {
      const derived = turns.forRun(input.runId);
      if (derived !== input.conversationTurnId) {
        throw new TypeError(
          "Agent message conversationTurnId does not match the turn derived from its Run.",
        );
      }
    }
    const audience =
      audienceKind === "USER"
        ? AGENT_USER_MESSAGE_AUDIENCE
        : audienceKind === "ASSISTANT"
          ? AGENT_ASSISTANT_MESSAGE_AUDIENCE
          : AGENT_TOOL_RESULT_MESSAGE_AUDIENCE;
    return createAgentMessageBase({
      id: ids.create(),
      runId: input.runId,
      sessionId: input.sessionId,
      conversationTurnId: input.conversationTurnId,
      createdAt: now(),
      sourceStepId: input.sourceStepId,
      source,
      audience,
    });
  }

  return {
    createUser(input: CreateAgentUserMessageInput): AgentUserMessage {
      return createAgentUserMessage(base(input, input.source, "USER"), input.content);
    },

    createAssistant(input: CreateAgentAssistantMessageInput): AgentAssistantMessage {
      if (input.model.kind !== "MODEL_TURN") {
        // A structural refusal, not a comment: the factory cannot express "migrated".
        throw new TypeError(
          "Agent message factory creates MODEL_TURN provenance only; LEGACY_MODEL_TURN belongs to migration.",
        );
      }
      assertModelTurn(input.model);
      return createAgentAssistantMessage(
        base(input, input.source, "ASSISTANT"),
        input.content,
        {
          kind: "MODEL_TURN",
          callId: input.model.callId,
          model: input.model.model,
          finishReason: input.model.finishReason,
          ...(input.model.usage === undefined ? {} : { usage: input.model.usage }),
        },
        input.providerState,
      );
    },

    createToolResult(input: CreateAgentToolResultMessageInput): AgentToolResultMessage {
      if (input.projection.policy.kind === "LEGACY_UNKNOWN") {
        // A structural refusal, not a comment: a new message was created under a policy that was
        // known at the time, so "the historical policy is not recoverable" is a claim this factory
        // cannot truthfully make. Only a migration describing a real unrecorded policy may.
        throw new TypeError(
          "Agent message factory creates SNAPSHOT projection policies only; LEGACY_UNKNOWN belongs to migration.",
        );
      }
      return createAgentToolResultMessage(base(input, input.source, "TOOL_RESULT"), {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        observation: input.observation,
        isError: input.isError,
        projectedContent: input.projectedContent,
        projection: input.projection,
      });
    },
  };
}

/* ------------------------------------------------------------------------------- checks */

/**
 * Refuse a scope that cannot identify a conversation position.
 *
 * The `conversationTurnId` brand already makes a bare string a compile error; this is the
 * runtime half, for a value that arrived from decoded JSON or from a caller that cast.
 */
function assertScope(scope: AgentMessageScope): void {
  for (const [field, value] of [
    ["runId", scope.runId],
    ["sessionId", scope.sessionId],
    ["conversationTurnId", scope.conversationTurnId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Agent message ${field} must be a non-empty string.`);
    }
  }
  if (scope.sourceStepId !== undefined && scope.sourceStepId.length === 0) {
    throw new TypeError("Agent message sourceStepId must be a non-empty string when present.");
  }
}

/**
 * Refuse a provenance that disagrees with the message kind.
 *
 * ```text
 * USER          must not claim MODEL or TOOL provenance
 * ASSISTANT     must claim MODEL provenance
 * TOOL_RESULT   must claim TOOL provenance, and name the observation it came from
 * ```
 *
 * These are consistency rules rather than authorization. Their value is that a message
 * whose source contradicts its kind cannot be stored at all, so a later reader never has
 * to decide which of the two to believe.
 */
function assertSourceConsistency(
  source: AgentMessageSource,
  kind: "USER" | "ASSISTANT" | "TOOL_RESULT",
): void {
  if (source.kind === "LEGACY") {
    throw new TypeError("Agent message factory must not create a LEGACY source.");
  }
  switch (kind) {
    case "USER":
      if (source.kind !== "USER") {
        throw new TypeError("An agent user message must carry a USER source.");
      }
      return;
    case "ASSISTANT":
      if (source.kind !== "MODEL") {
        throw new TypeError("An agent assistant message must carry a MODEL source.");
      }
      return;
    case "TOOL_RESULT":
      if (source.kind !== "TOOL") {
        throw new TypeError("An agent tool result message must carry a TOOL source.");
      }
      return;
  }
}

/** Refuse a model-turn provenance that cannot identify the turn it describes. */
function assertModelTurn(model: {
  readonly callId: string;
  readonly model: ModelRef;
  readonly finishReason: AIFinishReason;
  readonly usage?: ModelUsage | undefined;
}): void {
  if (typeof model.callId !== "string" || model.callId.length === 0) {
    throw new TypeError("Agent assistant message model callId must be a non-empty string.");
  }
  if (typeof model.model !== "object" || model.model === null) {
    throw new TypeError("Agent assistant message model must be a model reference.");
  }
  if (model.model.provider.length === 0 || model.model.model.length === 0) {
    throw new TypeError("Agent assistant message model must name a provider and a model.");
  }
}
