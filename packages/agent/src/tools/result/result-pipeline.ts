import type { TimestampMs, ToolInvocation } from "@caelush/protocol";
import type { JsonObject } from "@caelush/ai";

import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import { canonicalJsonString, jsonUtf8ByteLength } from "../schema/json-canonical.js";
import type { AgentToolResult } from "../types/tool-result.js";
import {
  DEFAULT_TOOL_RESULT_LIMITS,
  validateToolResultLimits,
  type ToolResultLimits,
  type ToolSettlementExtension,
  type ToolSettlementExtensionProjector,
} from "./result-policy.js";
import {
  IDENTITY_TOOL_RESULT_SANITIZER,
  ToolResultValidationError,
  type ToolResultSanitizerPort,
  type ToolResultSanitizationRefusalReason,
  type ValidatedToolResult,
} from "./result-sanitizer-port.js";
import { readSanitizedResultShape, validateToolResult } from "./result-validator.js";
import type {
  MaterializedToolFailure,
  ToolResultProcessingOutcome,
} from "./tool-result-processing-outcome.js";

/**
 * The processed result a settlement may commit.
 *
 * ```ts
 * export interface PreparedToolSettlement {
 *   readonly result: AgentToolResult;
 *   readonly effects?: ToolSettlementExtension;
 * }
 * ```
 *
 * `result` has already been shape-validated, schema-validated, sanitized, re-validated, bounded and
 * frozen. `effects` is an opaque pass-through: the general layer neither understands nor branches on
 * its `kind`.
 */
export interface PreparedToolSettlement {
  readonly result: AgentToolResult;
  readonly effects?: ToolSettlementExtension | undefined;
}

/**
 * The canonical Tool result pipeline.
 *
 * ```ts
 * export interface ToolResultPipeline {
 *   process(input: {
 *     readonly call: PreparedToolCall;
 *     readonly invocation: ToolInvocation;
 *     readonly rawResult: AgentToolResult;
 *     readonly now: TimestampMs;
 *   }): ToolResultProcessingOutcome;
 * }
 * ```
 *
 * `process` is synchronous and total over expected result-contract failures. It cannot reach
 * storage, an event bus, a model, a context engine, an approval store or a budget ledger, because
 * nothing of the sort is in its options or its arguments.
 *
 * The frozen internal order, which later rounds must not reorder:
 *
 * ```text
 * ① exact result shape validation
 * ② details is a JSON object
 * ③ details byte budget
 * ④ resultDetailsSchema validation
 * ⑤ defensive copy / freeze
 * ⑥ sanitize
 * ⑦ exact result shape re-validation
 * ⑧ sanitized details byte budget
 * ⑨ resultDetailsSchema re-validation
 * ⑩ bound content to maxDurableContentBytes
 * ⑪ project the optional settlement extension
 * ⑫ return an ACCEPTED settlement or bounded FAILED feedback
 * ```
 *
 * Steps ⑦–⑨ exist because a sanitizer is not a trusted transform: it can drop a required field,
 * introduce an extra one, or return details that no longer satisfy the Tool's own schema. Re-running
 * the full contract — not merely "does content exist" — is what keeps a broken sanitizer from
 * producing a durable observation that violates the Tool's declared contract.
 */
export interface ToolResultPipeline {
  process(input: {
    readonly call: PreparedToolCall;
    readonly invocation: ToolInvocation;
    readonly rawResult: AgentToolResult;
    readonly now: TimestampMs;
  }): ToolResultProcessingOutcome;
}

export interface ToolResultPipelineOptions {
  readonly sanitizer?: ToolResultSanitizerPort | undefined;
  readonly limits?: ToolResultLimits | undefined;
  /** Optional opaque settlement extension projector. Its throw produces TOOL_OUTCOME_UNKNOWN. */
  readonly settlementExtension?: ToolSettlementExtensionProjector | undefined;
}

export function createToolResultPipeline(
  options: ToolResultPipelineOptions = {},
): ToolResultPipeline {
  const sanitizer = options.sanitizer ?? IDENTITY_TOOL_RESULT_SANITIZER;
  const limits = validateToolResultLimits(options.limits ?? DEFAULT_TOOL_RESULT_LIMITS);
  const settlementExtension = options.settlementExtension;

  return {
    process(input): ToolResultProcessingOutcome {
      // ①–⑤  the raw producer value never leaves this function unfrozen or unvalidated.
      let validated: ValidatedToolResult;
      try {
        validated = validateToolResult({
          value: input.rawResult,
          resolved: input.call.resolved,
          limits,
        });
      } catch (error) {
        if (error instanceof ToolResultValidationError) return outputFailure();
        throw error;
      }

      // ⑥  a refusal or throw becomes safe output feedback; raw and partial values never leave here.
      let sanitizedValue: unknown;
      try {
        const sanitizerOutcome: unknown = sanitizer.sanitize({
          toolName: input.call.resolved.tool.name,
          result: validated as AgentToolResult,
          invocation: input.invocation,
        });
        if (typeof sanitizerOutcome !== "object" || sanitizerOutcome === null) {
          return outputFailure();
        }
        const kind = (sanitizerOutcome as { readonly kind?: unknown }).kind;
        if (kind === "REFUSED") {
          const reason = (sanitizerOutcome as { readonly reason?: unknown }).reason;
          return outputFailure(isRefusalReason(reason) ? reason : undefined);
        }
        if (kind !== "SANITIZED") return outputFailure();
        sanitizedValue = (sanitizerOutcome as { readonly result?: unknown }).result;
      } catch {
        return outputFailure();
      }

      // ⑦–⑩  full re-validation of what the sanitizer produced, then the durable bound.
      let sanitized: ValidatedToolResult;
      try {
        sanitized = revalidateSanitized({
          value: sanitizedValue,
          call: input.call,
          limits,
        });
      } catch (error) {
        if (error instanceof ToolResultValidationError) return outputFailure();
        throw error;
      }

      const result: AgentToolResult = Object.freeze({
        content: sanitized.content,
        details: sanitized.details,
        isError: sanitized.isError,
      });

      // ⑪  the extension sees only a safe, final result.
      if (settlementExtension === undefined) {
        return Object.freeze({
          kind: "ACCEPTED",
          settlement: Object.freeze({ result }),
        });
      }
      let extension: ToolSettlementExtension | undefined;
      try {
        extension = settlementExtension({ call: input.call, result, now: input.now });
      } catch {
        return unknownOutcomeFailure();
      }

      // ⑫  immutable settlement.
      return Object.freeze({
        kind: "ACCEPTED",
        settlement: Object.freeze(
          extension === undefined ? { result } : { result, effects: Object.freeze(extension) },
        ),
      });
    },
  };
}

const OUTPUT_FAILURE_CONTENT =
  "The tool output could not be safely validated. Use a narrower request or a different approach.";
const UNKNOWN_OUTCOME_CONTENT =
  "The tool's effects could not be confirmed. Do not repeat this call automatically; inspect the workspace before deciding what to do next.";

function outputFailure(reason?: ToolResultSanitizationRefusalReason): ToolResultProcessingOutcome {
  const details: JsonObject = reason === undefined ? {} : { reason };
  const failure: MaterializedToolFailure = {
    error: {
      code: "TOOL_OUTPUT_ERROR",
      phase: "TOOL",
      message: "Tool output could not be safely processed.",
    },
    feedback: {
      code: "TOOL_OUTPUT_ERROR",
      content: OUTPUT_FAILURE_CONTENT,
      details,
      disposition: "SAFE_FAILURE",
    },
  };
  return Object.freeze({ kind: "FAILED", failure: Object.freeze(failure) });
}

function isRefusalReason(value: unknown): value is ToolResultSanitizationRefusalReason {
  return value === "SCAN_NODE_LIMIT" || value === "SCAN_DEPTH_LIMIT" || value === "TEXT_LIMIT";
}

function unknownOutcomeFailure(): ToolResultProcessingOutcome {
  const details: JsonObject = { executionDisposition: "UNCERTAIN_SIDE_EFFECT" };
  const failure: MaterializedToolFailure = {
    error: {
      code: "TOOL_OUTCOME_UNKNOWN",
      phase: "RUNTIME",
      message: "Tool outcome could not be confirmed.",
    },
    feedback: {
      code: "TOOL_OUTCOME_UNKNOWN",
      content: UNKNOWN_OUTCOME_CONTENT,
      details,
      disposition: "UNCERTAIN_SIDE_EFFECT",
      blockToolFailures: true,
    },
    errorDetails: details,
  };
  return Object.freeze({ kind: "FAILED", failure: Object.freeze(failure) });
}

function revalidateSanitized(input: {
  readonly value: unknown;
  readonly call: PreparedToolCall;
  readonly limits: ToolResultLimits;
}): ValidatedToolResult {
  const sanitizedShape = readSanitizedResultShape(input.value);
  if (
    jsonUtf8ByteLength(canonicalJsonString(sanitizedShape.details)) > input.limits.maxDetailsBytes
  ) {
    throw new ToolResultValidationError("DETAILS_BUDGET");
  }
  if (!input.call.resolved.resultValidator.validate(sanitizedShape.details).valid) {
    throw new ToolResultValidationError("DETAILS_SCHEMA");
  }
  // The bounded, frozen, copied value — the same contract the raw pass produced.
  return validateToolResult({
    value: {
      content: sanitizedShape.content,
      details: sanitizedShape.details,
      isError: sanitizedShape.isError,
    },
    resolved: input.call.resolved,
    limits: input.limits,
  });
}
