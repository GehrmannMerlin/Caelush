import type { AIAssistantMessage, AIFinishReason, ModelUsage } from "@caelush/ai";
import type { JsonObject, ToolName } from "@caelush/protocol";

/**
 * The frozen agent decision contract.
 *
 * This is where the general agent kernel states what the model decided, and it is
 * deliberately written entirely in `@caelush/ai` and `@caelush/protocol` types:
 *
 * ```text
 * assistant message   AIAssistantMessage      not LLMAssistantMessage
 * model identity      ModelDescriptor["ref"]  not the Protocol wire ModelRef
 * call identity       plain branded string    not Protocol LLMCallId (see below)
 * tool arguments      Protocol JsonObject     durable once a call is completed
 * ```
 *
 * The one identity that stays a plain string is `AgentModelTurn.callId`. The AI core
 * owns its own branded `LLMCallId` because it may not depend on `@caelush/protocol`,
 * and the two are the same `llm_<uuidv7>` value rather than two encodings of it. Keeping
 * the general decision free of either brand means the durable projection that re-brands
 * the identity lives in exactly one place: the Core compatibility boundary.
 */

/** One settled model turn, in the AI contract. */
export interface AgentModelTurn {
  /** The gateway-owned call identity, as an opaque `llm_<uuidv7>` string. */
  readonly callId: string;
  /** The resolved model authority for the turn. `provider + model` is the identity. */
  readonly model: import("@caelush/ai").ModelDescriptor["ref"];
  /** Why the model stopped, in the frozen AI finish-reason vocabulary. */
  readonly finishReason: AIFinishReason;
  /**
   * The durable-shaped assistant message.
   *
   * Reasoning summaries are absent by construction: a summary a provider produced for
   * display is never durable assistant content.
   */
  readonly assistantMessage: AIAssistantMessage;
  /**
   * The settled usage snapshot, when the provider reported one.
   *
   * `| undefined` is explicit because the durable continuation schema distinguishes
   * "absent" from "present but undefined" under `exactOptionalPropertyTypes`, and a turn
   * without usage must decode back into this shape unchanged.
   */
  readonly usage?: ModelUsage | undefined;
}

/** One tool invocation the model requested. */
export interface AgentToolRequest {
  /** The provider-issued tool call identity, unique within one turn. */
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

/** The model asked for tools, and the turn stops at the Tool boundary. */
export interface AgentToolCallsDecision {
  readonly type: "TOOL_CALLS_REQUESTED";
  readonly modelTurn: AgentModelTurn;
  readonly toolRequests: readonly AgentToolRequest[];
}

/**
 * The model produced an answer that may become completion.
 *
 * A final candidate is only a candidate. `FINAL_CANDIDATE` must move the Run toward
 * verification — never directly to `COMPLETED` — and no shape in the agent kernel can
 * express a completion decision in the first place.
 */
export interface AgentFinalCandidateDecision {
  readonly type: "FINAL_CANDIDATE";
  readonly modelTurn: AgentModelTurn;
  /**
   * The candidate text, taken from the settled turn rather than re-derived from the
   * assistant message.
   *
   * The assistant message is the durable conversation record; the candidate text is the
   * value the Completion Authority hashes into `candidateHash`. Keeping it explicit means
   * no caller ever reconstructs a security-relevant hash by re-rendering a message.
   */
  readonly candidateText: string;
}

/** One thing the model decided to do. */
export type AgentDecision = AgentToolCallsDecision | AgentFinalCandidateDecision;

/** Every frozen decision discriminator, in canonical order. */
export const AGENT_DECISION_TYPES = [
  "TOOL_CALLS_REQUESTED",
  "FINAL_CANDIDATE",
] as const satisfies readonly AgentDecision["type"][];
