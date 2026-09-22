import type { AIFinishReason, AIProviderOpaqueState, ModelRef, ModelUsage } from "@caelush/ai";
import type { StepId } from "@caelush/protocol";

import type { AgentAssistantContentPart } from "./content.js";
import { assertAgentAssistantContent } from "./content.js";
import type { AgentMessageBase } from "./message-base.js";

/**
 * How an assistant message came to exist.
 *
 * ```text
 * MODEL_TURN          a settled model turn produced it, and the turn is identifiable
 * LEGACY_MODEL_TURN   it was migrated, and the only surviving pointer is a Step
 * ```
 *
 * ## The canonical types are the AI ones
 *
 * `ModelRef`, `AIFinishReason` and `ModelUsage` are reused from `@caelush/ai` rather
 * than restated here. A `MessageModelRef` / `MessageFinishReason` / `MessageUsage` trio
 * would be a second declaration of three contracts that must agree byte for byte with
 * the ones a provider turn produces, and the only way to keep two declarations in
 * agreement is to remember to.
 *
 * ## The legacy arm is not a factory's business
 *
 * `LEGACY_MODEL_TURN` exists so Phase 5B's backfill can represent a migrated message
 * whose provenance no longer includes a call id, finish reason or usage. It carries a
 * step pointer and nothing else, because inventing a finish reason or a usage snapshot
 * for a row that never recorded one would be fabricating history. The Message Factory
 * cannot produce this arm: it takes the `MODEL_TURN` inputs and nothing else.
 */
export type AgentAssistantModelProvenance =
  | {
      readonly kind: "MODEL_TURN";

      readonly callId: string;

      readonly model: ModelRef;

      readonly finishReason: AIFinishReason;

      readonly usage?: ModelUsage;
    }
  | {
      readonly kind: "LEGACY_MODEL_TURN";

      readonly sourceStepId?: StepId;
    };

/**
 * A model's turn.
 *
 * ```text
 * content        one or more parts, in the model's own order
 * model          how the turn came to exist
 * providerState  provider-opaque continuity data, when a provider required one
 * ```
 *
 * ## Order is preserved, never normalized
 *
 * A `TEXT` part followed by a `TOOL_CALL` part means the model narrated before it acted.
 * A projection that reordered them would change what the model said, so the projection
 * layer copies the parts in order and Phase 5A tests that it does.
 *
 * ## `providerState` is carried, never interpreted
 *
 * The AI contract owns the shape; this message stores it and the projection layer hands
 * it back unchanged. Nothing in `@caelush/agent` may read `payload`, and an assistant
 * message whose state belongs to a different provider or API is still a perfectly valid
 * message — the state is ignored by a non-matching translator, and the semantic content
 * survives.
 */
export interface AgentAssistantMessage extends AgentMessageBase {
  readonly type: "ASSISTANT";

  readonly content: readonly AgentAssistantContentPart[];

  readonly model: AgentAssistantModelProvenance;

  readonly providerState?: AIProviderOpaqueState;
}

/** Create a frozen assistant message. */
export function createAgentAssistantMessage(
  base: AgentMessageBase,
  content: readonly AgentAssistantContentPart[],
  model: AgentAssistantModelProvenance,
  providerState?: AIProviderOpaqueState | undefined,
): AgentAssistantMessage {
  assertAgentAssistantContent(content);
  return Object.freeze({
    ...base,
    type: "ASSISTANT" as const,
    content: Object.freeze([...content]),
    model: Object.freeze({ ...model }),
    ...(providerState === undefined ? {} : { providerState }),
  });
}
