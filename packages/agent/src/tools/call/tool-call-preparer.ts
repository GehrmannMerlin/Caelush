import type { JsonObject } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import type { ResolvedAgentTool } from "../registry/registry.js";

/**
 * One provider-neutral Tool call, as it enters the Tool Layer.
 *
 * ```ts
 * export interface ToolCallRequest {
 *   readonly externalCallId: string;
 *   readonly toolName: ToolName;
 *   readonly args: JsonObject;
 * }
 * ```
 *
 * This is the `AIToolCall` a model produced, restated without any provider shape. The Tool Layer
 * never sees an OpenAI or Anthropic tool-call object, and the AI Layer never sees a `ToolCallRequest`
 * — the projection between the two belongs to the boundary that knows both.
 *
 * `externalCallId` is the model's call identity. It is carried through preparation unchanged: a
 * Preparer may not generate, rewrite or substitute it, because `(runId, sourceStepId,
 * externalCallId)` is the idempotency identity that decides whether a call has already run.
 */
export interface ToolCallRequest {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

/**
 * A Tool call that is ready to execute.
 *
 * ```text
 * request   the call as it arrived
 * resolved  the registered Tool and its compiled validators
 * args      the effective arguments
 * ```
 *
 * `args` has already passed through `prepareArguments` when the Tool declares one, and has already
 * validated against the Tool's input schema. That is the value every later stage uses: security
 * facts, approval identity and execution arguments are all projected from these arguments, never
 * from the raw ones, so a Security decision can never be made about a payload the Tool will not
 * receive.
 */
export interface PreparedToolCall {
  readonly request: ToolCallRequest;
  readonly resolved: ResolvedAgentTool;
  readonly args: JsonObject;
}

/**
 * What preparation produced.
 *
 * ```text
 * READY     resolve, prepare and validate all succeeded; `call` may execute
 * REJECTED  the model can fix this; `feedback` is safe to show it
 * ```
 *
 * There is no third arm, and in particular there is no "rejected but created something" arm.
 * **A pre-invocation rejection does not create a ToolInvocation.** An unknown Tool has no reliable
 * risk level to persist, and oversized or invalid arguments should not enter the durable invocation
 * ledger at all. The rejection still reaches the model — as safe feedback, and through the Run's own
 * conversation history — so the model can correct itself without a durable Tool row existing for a
 * call that never ran.
 *
 * An infrastructure failure is *not* an outcome arm either: those are thrown, because "the registry
 * is corrupt" and "the model sent a string" must not be the same value in the same union.
 */
export type ToolCallPreparationOutcome =
  | {
      readonly kind: "READY";
      readonly call: PreparedToolCall;
    }
  | {
      readonly kind: "REJECTED";
      readonly request: ToolCallRequest;
      readonly feedback: ToolFailureFeedback;
    };

/**
 * Resolve, prepare and validate one Tool call — and nothing else.
 *
 * ```ts
 * export interface ToolCallPreparer {
 *   prepare(request: ToolCallRequest): ToolCallPreparationOutcome;
 * }
 * ```
 *
 * `prepare` is **synchronous and total**. The formal path:
 *
 * ```text
 * validate the call boundary (identity and raw argument size)
 * → resolve the Tool
 * → bound the raw arguments
 * → defensive copy
 * → optional prepareArguments
 * → bound the prepared arguments
 * → strict input schema validation
 * → PreparedToolCall
 * ```
 *
 * What it must never do:
 *
 * ```text
 * read a file, execute a process, touch the network, call a model, access a database
 * invent a missing path, supply a missing command, or repair a business meaning
 * call execute()
 * create an Invocation, an Observation, an Approval or a durable event
 * generate or replace externalCallId
 * ```
 *
 * Argument preparation is a *compatibility normalization* performed by the Tool author, not a
 * validation bypass performed by the framework. The framework's part of the bargain is that it
 * bounds both the raw and the prepared payload, so a hook cannot be used to smuggle an oversized
 * payload past the boundary, and that it validates the schema **after** the hook rather than before.
 *
 * Both size limits exist for the same reason: a hook is arbitrary Tool-author code, and a bound that
 * only applies after the hook is a bound the hook can defeat.
 */
export interface ToolCallPreparer {
  prepare(request: ToolCallRequest): ToolCallPreparationOutcome;
}
