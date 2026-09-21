/**
 * The canonical Tool batch and Tool result batch error vocabulary.
 *
 * ```text
 * ToolBatchInputError             the batch request itself was invalid
 * ToolBatchInfrastructureError    the Tool boundary failed rather than the call
 * AgentToolResultBatchError       a Tool result batch violated identity, shape or multiplicity
 * ```
 *
 * These three classes are declared **once**, here, and every other package re-exports the same
 * identity. That matters because `instanceof` is load-bearing in this system: the Run Layer decides
 * whether a failure is a model error or an infrastructure error by class, and two structurally equal
 * classes declared in two packages would silently send one of those decisions down the wrong branch.
 *
 * `@caelush/tools` re-exports `ToolBatchInputError` and `ToolBatchInfrastructureError`;
 * `@caelush/core` re-exports `AgentToolResultBatchError`. No caller needs to change its import to get
 * the same class object.
 */

/**
 * A Tool batch request is invalid.
 *
 * This is a statement about the *request*, never about a Tool call: it is raised before any budget
 * preflight, any preparation, any durable write and any execution, so a batch that throws this has had
 * zero side effects.
 *
 * The Run Layer classifies it as a `MODEL_ERROR` in the `LLM` phase, because the only way a caller can
 * produce one from a real Run is by handing the Tool Layer a malformed model decision.
 */
export class ToolBatchInputError extends Error {
  constructor(message = "Tool batch request is invalid.") {
    super(message);
    this.name = "ToolBatchInputError";
  }
}

/**
 * The Tool batch boundary failed in a way that is not a fact about any Tool call.
 *
 * ```text
 * a crashed store          a violated settlement invariant
 * a corrupt registry       an unexpected approval infrastructure failure
 * a batch internal invariant
 * ```
 *
 * The `cause` is retained for internal diagnostics and must never become model-facing text: a caller
 * that turned this into a Tool result would be telling the model that a call failed when the truth is
 * that the system could not establish what happened. The correct handling is to let it propagate to
 * the Run execution layer, where the existing sanitized Run failure path owns it.
 */
export class ToolBatchInfrastructureError extends Error {
  constructor(
    message = "Tool batch execution infrastructure failed.",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ToolBatchInfrastructureError";
  }
}

/**
 * Why a Tool result batch was refused.
 *
 * Every reason is a *structural* violation of the batch contract, not a Tool failure. They exist so a
 * caller can distinguish "the model produced a batch that cannot be reconciled with its own request"
 * from "the Tool returned an error", which are handled by entirely different authorities.
 */
export type AgentToolResultBatchErrorReason =
  | "DUPLICATE_REQUEST_ID"
  | "INVALID_RESULT"
  | "DUPLICATE_RESULT"
  | "UNEXPECTED_RESULT"
  | "MISSING_RESULT"
  | "TOOL_NAME_MISMATCH";

/**
 * Bounded, JSON-safe diagnostics about a refused result batch.
 *
 * Deliberately small: counts and one call identity. Raw Tool content, arguments and host paths must
 * never enter an error that can be logged or serialized into a Run failure.
 */
export interface AgentToolResultBatchErrorMetadata {
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly requestCount?: number | undefined;
  readonly resultCount?: number | undefined;
}

/**
 * A Tool result batch does not satisfy the frozen result contract.
 *
 * ```text
 * duplicate request ID     the same call was requested twice
 * invalid result           an entry is not a well-formed Tool result message
 * duplicate result         two results claim the same call
 * unexpected result        a result answers a call nobody requested
 * missing result           a requested call has no result
 * tool name mismatch       a result answers the right call with the wrong Tool name
 * ```
 *
 * This is an **integrity** failure, not a model-correctable Tool failure, so it must never be turned
 * into an `AIToolResultMessage` with `isError: true`. It propagates to the Run execution layer.
 */
export class AgentToolResultBatchError extends Error {
  readonly reason: AgentToolResultBatchErrorReason;
  readonly metadata: AgentToolResultBatchErrorMetadata;

  constructor(
    reason: AgentToolResultBatchErrorReason,
    metadata: AgentToolResultBatchErrorMetadata = {},
  ) {
    super(`Tool result batch is invalid: ${reason}.`);
    this.name = "AgentToolResultBatchError";
    this.reason = reason;
    this.metadata = metadata;
  }
}
