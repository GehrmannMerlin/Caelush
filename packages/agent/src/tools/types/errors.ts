import type { ToolName } from "@caelush/protocol";

import type { ToolFailureFeedback } from "./tool-feedback.js";

/**
 * Why a registration was refused.
 *
 * These are build-time configuration errors, not model-facing failures: a registry that cannot be
 * built is a programming error in the host, and it fails loudly at composition rather than at the
 * first Tool call.
 */
export type AgentToolRegistrationErrorReason =
  | "INVALID_DEFINITION"
  | "DUPLICATE_TOOL_NAME"
  | "EMPTY_DESCRIPTION"
  | "INVALID_INPUT_SCHEMA"
  | "INVALID_RESULT_SCHEMA"
  | "INPUT_SCHEMA_NOT_OBJECT"
  | "RESULT_SCHEMA_NOT_OBJECT"
  | "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "RESULT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "TOOL_SCHEMA_TOO_LARGE"
  | "TOOL_DESCRIPTION_TOO_LARGE"
  | "TOOL_CATALOG_TOO_LARGE"
  | "TOOL_LIMIT_EXCEEDED"
  | "BUILDER_FINALIZED"
  | "INVALID_REGISTRY_OPTION";

export type AgentToolSchemaKind = "input" | "result";

export interface AgentToolRegistrationErrorMetadata {
  readonly reason: AgentToolRegistrationErrorReason;
  readonly toolName?: ToolName | undefined;
  readonly schemaKind?: AgentToolSchemaKind | undefined;
}

/** A Tool or Tool registry definition was refused. */
export class AgentToolRegistrationError extends Error {
  readonly reason: AgentToolRegistrationErrorReason;
  readonly toolName: ToolName | undefined;
  readonly schemaKind: AgentToolSchemaKind | undefined;

  constructor(message: string, metadata: AgentToolRegistrationErrorMetadata) {
    super(message);
    this.name = "AgentToolRegistrationError";
    this.reason = metadata.reason;
    this.toolName = metadata.toolName;
    this.schemaKind = metadata.schemaKind;
  }
}

/** A Tool schema could not be compiled. */
export class AgentToolSchemaCompileError extends AgentToolRegistrationError {
  constructor(message: string, metadata: AgentToolRegistrationErrorMetadata) {
    super(message, metadata);
    this.name = "AgentToolSchemaCompileError";
  }
}

/** The registry builder was mutated after it was finalized. */
export class AgentToolRegistryStateError extends AgentToolRegistrationError {
  constructor(message: string, metadata: AgentToolRegistrationErrorMetadata) {
    super(message, metadata);
    this.name = "AgentToolRegistryStateError";
  }
}

/** A Tool declared an argument problem it considers safe to explain to the model. */
export class ToolArgumentPreparationError extends Error {
  readonly feedback: ToolFailureFeedback;

  constructor(feedback: ToolFailureFeedback, options?: { readonly cause?: unknown }) {
    super(feedback.content, options);
    this.name = "ToolArgumentPreparationError";
    this.feedback = feedback;
  }
}

export type ToolExecutionInfrastructurePhase =
  "PREPARATION" | "ADMISSION" | "EXECUTION" | "RESULT_PIPELINE" | "SETTLEMENT" | "RECOVERY";

/**
 * A failure that must not be disguised as an ordinary `isError: true` Tool result.
 *
 * Storage commit failure, invocation revision conflict, a broken sanitizer, a registry invariant, a
 * schema runtime that cannot compile a schema it already accepted: these leave the Tool boundary as
 * failures and reach the Run execution layer, because a model told "the tool failed" would retry a
 * call whose durable truth is unknown. Later rounds extend this class for their own phase.
 */
export class ToolExecutionInfrastructureError extends Error {
  readonly phase: ToolExecutionInfrastructurePhase;

  constructor(
    phase: ToolExecutionInfrastructurePhase,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ToolExecutionInfrastructureError";
    this.phase = phase;
  }
}

/**
 * The Preparer's own infrastructure failure.
 *
 * ```text
 * registry corruption
 * schema runtime invariant violation
 * an unexpected exception from prepareArguments
 * an unexpected non-synchronous prepareArguments result
 * ```
 *
 * It is thrown, never returned as `REJECTED`: `REJECTED` means "the model can fix this", and none of
 * these is something a model can fix. The message carries no raw arguments, no host paths and no
 * stack text — only the reason category, with the original error attached as `cause` for the host's
 * own diagnostics.
 */
export class ToolPreparationInfrastructureError extends ToolExecutionInfrastructureError {
  readonly toolName: ToolName | undefined;

  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly toolName?: ToolName | undefined;
    },
  ) {
    super("PREPARATION", message, options);
    this.name = "ToolPreparationInfrastructureError";
    this.toolName = options?.toolName;
  }
}
