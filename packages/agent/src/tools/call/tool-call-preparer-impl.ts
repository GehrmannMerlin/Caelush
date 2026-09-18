import type { JsonObject } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import type { AgentToolRegistry, ResolvedAgentTool } from "../registry/registry.js";
import {
  canonicalJsonString,
  cloneJsonValue,
  deepFreezeJson,
  isJsonObject,
  jsonUtf8ByteLength,
} from "../schema/json-canonical.js";
import {
  ToolArgumentPreparationError,
  ToolPreparationInfrastructureError,
} from "../types/errors.js";
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import type {
  PreparedToolCall,
  ToolCallPreparationOutcome,
  ToolCallPreparer,
  ToolCallRequest,
} from "./tool-call-preparer.js";

/** Model-facing codes a rejection may carry. They are stable and never localized. */
export const TOOL_CALL_REJECTION_CODES = {
  UNKNOWN_TOOL: "TOOL_UNAVAILABLE",
  INVALID_ARGUMENTS: "TOOL_ARGUMENT_ERROR",
  OVERSIZED_ARGUMENTS: "TOOL_ARGUMENTS_TOO_LARGE",
  OVERSIZED_CALL_ID: "TOOL_CALL_ID_TOO_LARGE",
} as const;

/** The bound applied to a model tool-call id, matching the durable invocation limit. */
export const DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES = 512;

/** The bound applied to the raw arguments a model sends for one call. */
export const DEFAULT_MAX_INVOCATION_ARGS_BYTES = 256 * 1024;

/**
 * Optional per-Tool argument normalization applied *inside* the Preparer.
 *
 * A Tool's own `prepareArguments` hook runs here. `normalizeValue` exists for hosts that must keep a
 * compatibility normalization for Tools registered through a legacy definition: the hook still
 * belongs to the Tool, and the algorithm still has exactly one implementation — it is simply
 * supplied by the registration adapter instead of written inline in a second validator.
 *
 * A normalization must be pure, deterministic, bounded and side-effect free, exactly like
 * `prepareArguments` itself, because this is the same stage of the same pipeline.
 */
export interface ToolArgumentNormalization {
  readonly normalizeValue: (
    args: Readonly<JsonObject>,
    tool: ResolvedAgentTool,
  ) => Readonly<JsonObject>;
}

export interface ToolCallPreparerOptions {
  readonly maxExternalCallIdBytes?: number | undefined;
  readonly maxInvocationArgsBytes?: number | undefined;
  /** Registration-level compatibility normalization. Absent means generic Tools get none. */
  readonly normalization?: ToolArgumentNormalization | undefined;
}

/**
 * The 4A-era Preparer is stateless: the only state is the registry it resolves against and the two
 * bounds. It has no clock, no id factory, no store and no notifier, which is what makes "preparation
 * creates nothing durable" checkable by reading its constructor.
 */
export function createToolCallPreparer(
  registry: AgentToolRegistry,
  options: ToolCallPreparerOptions = {},
): ToolCallPreparer {
  const maxExternalCallIdBytes =
    options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES;
  const maxInvocationArgsBytes =
    options.maxInvocationArgsBytes ?? DEFAULT_MAX_INVOCATION_ARGS_BYTES;
  const normalization = options.normalization;

  return {
    prepare(value: ToolCallRequest): ToolCallPreparationOutcome {
      const request = assertCallBoundary(value, maxExternalCallIdBytes);
      const resolved = registry.resolve(request.toolName);
      if (resolved === undefined) {
        return {
          kind: "REJECTED",
          request,
          feedback: safeFeedback(
            TOOL_CALL_REJECTION_CODES.UNKNOWN_TOOL,
            `Tool "${request.toolName}" is not available.`,
          ),
        };
      }

      // Bound and copy the raw payload before any Tool-authored code sees it.
      const rawBytes = jsonUtf8ByteLength(canonicalJsonString(request.args));
      if (rawBytes > maxInvocationArgsBytes) {
        return {
          kind: "REJECTED",
          request,
          feedback: oversizedFeedback(),
        };
      }
      const rawArgs = cloneJsonValue(request.args) as JsonObject;

      let preparedArgs: JsonObject;
      try {
        preparedArgs = runArgumentPreparation(resolved, rawArgs, normalization);
      } catch (error) {
        if (error instanceof ToolArgumentPreparationError) {
          return { kind: "REJECTED", request, feedback: error.feedback };
        }
        throw error;
      }

      const preparedBytes = jsonUtf8ByteLength(canonicalJsonString(preparedArgs));
      if (preparedBytes > maxInvocationArgsBytes) {
        return {
          kind: "REJECTED",
          request,
          feedback: oversizedFeedback(),
        };
      }

      // Validation runs on what preparation produced, never on what arrived.
      const validation = resolved.inputValidator.validate(preparedArgs);
      if (!validation.valid) {
        return {
          kind: "REJECTED",
          request,
          feedback: schemaFeedback(resolved.tool.name, validation.issues),
        };
      }

      const call: PreparedToolCall = Object.freeze({
        request,
        resolved,
        args: deepFreezeJson(preparedArgs) as JsonObject,
      });
      return { kind: "READY", call };
    },
  };
}

/**
 * The raw-call boundary.
 *
 * An unknown *shape* is a programming error on the caller's side — the argument arrived from the
 * Tool Layer's own request type, not from a model — so it is refused rather than classified as model
 * feedback. An oversized **call id** is model-adjacent data and is safe feedback.
 */
function assertCallBoundary(
  value: ToolCallRequest,
  maxExternalCallIdBytes: number,
): ToolCallRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolPreparationInfrastructureError("Tool call request is not an object.");
  }
  if (typeof value.externalCallId !== "string" || value.externalCallId.length === 0) {
    throw new ToolPreparationInfrastructureError(
      "Tool call request has no external call identity.",
    );
  }
  if (typeof value.toolName !== "string" || value.toolName.length === 0) {
    throw new ToolPreparationInfrastructureError("Tool call request has no tool name.");
  }
  if (!isJsonObject(value.args)) {
    throw new ToolPreparationInfrastructureError(
      "Tool call request arguments are not a JSON object.",
    );
  }
  if (jsonUtf8ByteLength(value.externalCallId) > maxExternalCallIdBytes) {
    throw new ToolPreparationInfrastructureError(
      "Tool call request external call identity exceeds its byte limit.",
      { toolName: value.toolName },
    );
  }
  return Object.freeze({
    externalCallId: value.externalCallId,
    toolName: value.toolName,
    args: value.args,
  });
}

/**
 * Run the Tool's own normalization, if it has one.
 *
 * ```text
 * ToolArgumentPreparationError   the Tool author declared this safe to explain: REJECTED
 * any other throw                a framework/Tool bug: infrastructure failure
 * a promise / non-object result  a contract violation: infrastructure failure
 * ```
 *
 * The distinction is the whole point of the explicit error class. A Tool that wants a model to see
 * its argument problem says so; a Tool that throws a `TypeError` has a bug, and a bug must not be
 * turned into a plausible-sounding instruction to the model.
 */
function runArgumentPreparation(
  resolved: ResolvedAgentTool,
  rawArgs: JsonObject,
  normalization: ToolArgumentNormalization | undefined,
): JsonObject {
  const hooks: ((args: Readonly<JsonObject>) => Readonly<JsonObject>)[] = [];
  if (resolved.tool.prepareArguments !== undefined) {
    const hook = resolved.tool.prepareArguments;
    hooks.push((args) => hook(args) as Readonly<JsonObject>);
  }
  if (normalization !== undefined) {
    const { normalizeValue } = normalization;
    hooks.push((args) => normalizeValue(args, resolved));
  }

  let current: JsonObject = rawArgs;
  for (const hook of hooks) {
    let produced: unknown;
    try {
      produced = hook(current);
    } catch (error) {
      if (error instanceof ToolArgumentPreparationError) {
        throw error;
      }
      throw new ToolPreparationInfrastructureError(
        "Tool argument preparation failed unexpectedly.",
        { cause: error, toolName: resolved.tool.name },
      );
    }
    if (!isJsonObject(produced)) {
      throw new ToolPreparationInfrastructureError(
        "Tool argument preparation returned a value that is not a JSON object.",
        { toolName: resolved.tool.name },
      );
    }
    current = produced as JsonObject;
  }
  return current;
}

function safeFeedback(code: string, content: string): ToolFailureFeedback {
  return Object.freeze({
    code,
    content,
    details: Object.freeze({}),
    disposition: "SAFE_FAILURE",
  });
}

function oversizedFeedback(): ToolFailureFeedback {
  return safeFeedback(
    TOOL_CALL_REJECTION_CODES.OVERSIZED_ARGUMENTS,
    "The tool arguments exceed the size this call allows. Send fewer or smaller arguments.",
  );
}

/**
 * Schema feedback is built from issue paths, keywords and the sanitized validator message.
 *
 * The validator message is safe by construction — AJV reports "must be number", "must have required
 * property 'cmd'" and similar structural statements — but it is still never handed to a model on its
 * own: the model receives the fixed actionable content, and the structured issues stay in `details`
 * for a caller that wants to render its own bounded text. That is how a legacy-facing adapter can
 * keep its existing message format without this layer printing raw validation output.
 */
function schemaFeedback(
  toolName: ToolName,
  issues: readonly {
    readonly instancePath: string;
    readonly keyword: string;
    readonly message: string;
  }[],
): ToolFailureFeedback {
  const summarized = issues.slice(0, 16).map((issue) => ({
    path: normalizeInstancePath(issue.instancePath),
    keyword: issue.keyword,
    message: issue.message,
  }));
  return Object.freeze({
    code: TOOL_CALL_REJECTION_CODES.INVALID_ARGUMENTS,
    content: `Arguments for "${toolName}" do not match its input schema. Correct the reported fields and call it again.`,
    details: Object.freeze({
      issues: Object.freeze(summarized.map((issue) => Object.freeze(issue))),
    }),
    disposition: "SAFE_FAILURE",
  });
}

/** Turn a JSON Pointer instance path into a readable dotted field path. */
export function normalizeInstancePath(instancePath: string): string {
  return instancePath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}
