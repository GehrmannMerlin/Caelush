import type { TimestampMs, ToolInvocation } from "@caelush/protocol";

import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import { canonicalJsonString, jsonUtf8ByteLength } from "../schema/json-canonical.js";
import { ToolExecutionInfrastructureError } from "../types/errors.js";
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
  type ValidatedToolResult,
} from "./result-sanitizer-port.js";
import { readSanitizedResultShape, validateToolResult } from "./result-validator.js";

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
 *   }): PreparedToolSettlement;
 * }
 * ```
 *
 * `process` is synchronous and total over its declared input. It cannot reach storage, an event bus,
 * a model, a context engine, an approval store or a budget ledger, because nothing of the sort is in
 * its options or its arguments.
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
 * ⑫ return an immutable PreparedToolSettlement
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
  }): PreparedToolSettlement;
}

export interface ToolResultPipelineOptions {
  readonly sanitizer?: ToolResultSanitizerPort | undefined;
  readonly limits?: ToolResultLimits | undefined;
  /** Optional opaque settlement extension projector. Its throw is a RESULT_PIPELINE failure. */
  readonly settlementExtension?: ToolSettlementExtensionProjector | undefined;
}

export function createToolResultPipeline(
  options: ToolResultPipelineOptions = {},
): ToolResultPipeline {
  const sanitizer = options.sanitizer ?? IDENTITY_TOOL_RESULT_SANITIZER;
  const limits = validateToolResultLimits(options.limits ?? DEFAULT_TOOL_RESULT_LIMITS);
  const settlementExtension = options.settlementExtension;

  return {
    process(input): PreparedToolSettlement {
      // ①–⑤  the raw producer value never leaves this function unfrozen or unvalidated.
      const validated: ValidatedToolResult = validateToolResult({
        value: input.rawResult,
        resolved: input.call.resolved,
        limits,
      });

      // ⑥  sanitize. A result that cannot be sanitized has no defensible durable form: it is never
      // downgraded to `isError: true`, and the raw result is never forwarded as a fallback.
      let sanitizedValue: unknown;
      try {
        sanitizedValue = sanitizer.sanitize({
          toolName: input.call.resolved.tool.name,
          result: validated as AgentToolResult,
          invocation: input.invocation,
        });
      } catch (error) {
        throw new ToolExecutionInfrastructureError(
          "RESULT_PIPELINE",
          "Tool result sanitization failed.",
          { cause: error },
        );
      }

      // ⑦–⑩  full re-validation of what the sanitizer produced, then the durable bound.
      const sanitized = revalidateSanitized({
        value: sanitizedValue,
        call: input.call,
        limits,
      });

      const result: AgentToolResult = Object.freeze({
        content: sanitized.content,
        details: sanitized.details,
        isError: sanitized.isError,
      });

      // ⑪  the extension sees only a safe, final result.
      if (settlementExtension === undefined) {
        return Object.freeze({ result });
      }
      let extension: ToolSettlementExtension | undefined;
      try {
        extension = settlementExtension({ call: input.call, result, now: input.now });
      } catch (error) {
        throw new ToolExecutionInfrastructureError(
          "RESULT_PIPELINE",
          "Tool settlement extension projection failed.",
          { cause: error },
        );
      }

      // ⑫  immutable settlement.
      return Object.freeze(
        extension === undefined ? { result } : { result, effects: Object.freeze(extension) },
      );
    },
  };
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
