import type { JsonObject } from "@caelush/ai";

/**
 * The raw result of one Tool execution.
 *
 * ```ts
 * export interface AgentToolResult<TDetails extends JsonObject = JsonObject> {
 *   readonly content: string;
 *   readonly details: TDetails;
 *   readonly isError: boolean;
 * }
 * ```
 *
 * ```text
 * content   model-facing text
 * details   structured runtime/UI data, validated against the Tool's resultDetailsSchema
 * isError   true when the handler returned a model-visible Tool failure
 * ```
 *
 * This is **not** a durable observation, not a UI event and not an AI message. Four result shapes
 * exist in Tool System V2 and never collapse into one:
 *
 * ```text
 * AgentToolResult          what a Tool returned
 * DurableToolObservation   what was validated, sanitized and durably committed
 * ToolPresentation         what a UI shows
 * AIToolResultMessage      what the model is told next turn
 * ```
 *
 * `isError` records what the Tool handler returned. The Result Pipeline separately materializes
 * expected output-contract or sanitizer failures as bounded durable failure feedback; it never
 * forwards an invalid or unsanitized handler result. Unknown side effects remain distinguishable
 * from ordinary output failures and are not automatically replayed.
 *
 * ## Name collision with the frozen Phase 3 Tool turn contract
 *
 * Phase 3 already froze and root-exports an unrelated `AgentToolResult` from
 * `./run/ports/tool-turn.js`: the **model-visible** result of a Tool turn
 * (`externalCallId`, `toolName`, `content`, `isError`). Tool System V2 also names its raw execution
 * result `AgentToolResult`. Both names are frozen, so the Agent root keeps the Phase 3 declaration
 * and its name untouched and publishes this one as `AgentToolExecutionResult`:
 *
 * ```ts
 * export type { AgentToolResult as AgentToolExecutionResult } from "./tools/types/tool-result.js";
 * ```
 *
 * This interface is the single declaration of the execution result shape. The alias is an export
 * mapping, not a third DTO: nothing redeclares the structure, and neither type grows the other's
 * fields.
 */
export interface AgentToolResult<TDetails extends JsonObject = JsonObject> {
  readonly content: string;
  readonly details: TDetails;
  readonly isError: boolean;
}
