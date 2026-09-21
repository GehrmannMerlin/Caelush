import { RuntimeError, RuntimeInvariantError } from "@caelush/runtime";
import type {
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
} from "@caelush/runtime";

import type { AgentToolExecutionResult as AgentToolResult } from "@caelush/agent";
import type { ToolSecurityFacts } from "../security/security-facts.js";
import type { ToolEffect } from "../effects/effects.js";
import type { ToolEffectProjector } from "../effects/effect-projectors.js";
import type { CodingToolEffectProjector } from "../security-metadata.js";
import type { JsonObject } from "@caelush/ai";

/**
 * The Coding builtin result helpers.
 *
 * ```text
 * errorResult(code, message)         a safe, model-recoverable Tool failure
 * successResult(content, details)    a successful Tool result
 * positiveBoundedInteger(...)        a bounded positive integer argument
 * runtimeErrorToResult(error)        a known Runtime operational failure -> a safe result
 * ```
 *
 * ## What deliberately is not here
 *
 * The legacy module this replaces also owned `withRuntimeScope`, `RuntimeResolver`,
 * `RuntimeWorkspaceScope` and the runtime resolution. None of that belongs in a Coding builtin any
 * more: a builtin receives a narrow Operations port and a locator, and the workspace opening happens
 * inside `tools/operations/runtime-adapters/`.
 *
 * What is left is genuinely Tool-side business: shaping a result, validating an argument against the
 * Tool's own declared bounds, and deciding which Runtime failures the model is allowed to see.
 *
 * ## The error boundary
 *
 * `runtimeErrorToResult` converts a **known** Runtime operational failure into a safe
 * `isError: true` result whose `content` names only the Runtime's stable machine code. It never leaks
 * a path, a stack, a raw message or a captured stderr line, because the model-facing string is built
 * from the code alone.
 *
 * It deliberately does not accept everything. Three classes must keep propagating:
 *
 * ```text
 * RuntimeInvariantError        the Runtime's own guarantees were violated — a defect, not an outcome
 * uncertain process/patch      the side effect is unprovable, and the model must not be invited to retry
 * anything unrecognized        a Tool may not invent a safe message for a failure it does not understand
 * ```
 */

export const READ_FILE_DEFAULT_LIMIT = 400;
export const READ_FILE_MAX_LIMIT = 2000;
export const LIST_DIRECTORY_DEFAULT_LIMIT = 200;
export const LIST_DIRECTORY_MAX_LIMIT = 500;
export const FIND_FILES_DEFAULT_LIMIT = 100;
export const FIND_FILES_MAX_LIMIT = 500;
export const SEARCH_TEXT_DEFAULT_LIMIT = 100;
export const SEARCH_TEXT_MAX_LIMIT = 200;
export const MAX_FIND_PATTERN_BYTES = 2048;
export const MAX_SEARCH_GLOB_BYTES = 2048;
export const MAX_SEARCH_MATCH_CHARS = 1000;

/**
 * The details schema the read-only filesystem Tools share.
 *
 * This becomes `AgentTool.resultDetailsSchema`. It describes the **details** object only: `content` and
 * `isError` are the canonical `AgentToolResult` envelope and are never part of a details schema.
 */
export const READ_ONLY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    path: { type: "string" },
    pattern: { type: "string" },
    offset: { type: "integer" },
    count: { type: "integer" },
    linesReturned: { type: "integer" },
    bytesReturned: { type: "integer" },
    truncated: { type: "boolean" },
    nextOffset: { type: "integer" },
    utf8Bom: { type: "boolean" },
    files: { type: "array", items: { type: "string" } },
    entries: { type: "array", items: { type: "object" } },
    matches: { type: "array", items: { type: "object" } },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

/** The details schema the exec and stdin Tools share. */
export const EXEC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    status: { type: "string", enum: ["RUNNING", "EXITED"] },
    sessionId: { type: "string" },
    exitCode: { type: "integer" },
    signal: { type: "string" },
    totalOutputBytes: { type: "integer", minimum: 0 },
    omittedBytes: { type: "integer", minimum: 0 },
    tty: { type: "boolean" },
    workdir: { type: "string" },
    durationMs: { type: "integer", minimum: 0 },
    charsAcceptedBytes: { type: "integer", minimum: 0 },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

/**
 * A safe, model-recoverable Tool failure.
 *
 * The `error` code is a stable machine code; the `content` is the sentence the model reads. Both are
 * built from constants the Tool author wrote, never from a caught exception.
 */
export function errorResult(code: string, message: string): AgentToolResult<JsonObject> {
  return { content: message, details: { ok: false, error: code }, isError: true };
}

/** A successful Tool result, with `ok: true` folded into the details. */
export function successResult(content: string, details: JsonObject): AgentToolResult<JsonObject> {
  return { content, details: { ok: true, ...details }, isError: false };
}

/**
 * A bounded positive safe integer argument.
 *
 * `maximum` is the Tool's own declared ceiling, which the input schema also advertises. The value is
 * validated **after** the canonical Preparer has already checked the schema, because a schema cannot
 * express "this is a safe integer that also fits the ceiling the Tool will enforce".
 *
 * A value outside the range throws `INVALID_RANGE`; the caller catches it and returns the
 * corresponding safe result, so the Tool's failure vocabulary stays its own.
 */
export function positiveBoundedInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > maximum
  ) {
    throw new Error("INVALID_RANGE");
  }
  return result;
}

/** The one safe sentence a Runtime failure may produce. It names the code and nothing else. */
export function safeRuntimeMessage(error: RuntimeError): string {
  return `Tool operation failed: ${error.code}.`;
}

/**
 * Convert a known Runtime operational failure into a safe Tool result.
 *
 * Returns `undefined` when the error is not something a Tool may describe, so the caller's
 * `?? throw` keeps the exception travelling. That shape is deliberate: a helper that returned a result
 * for every input would be exactly the `catch { return isError }` anti-pattern the freeze forbids.
 */
export function runtimeErrorToResult(error: unknown): AgentToolResult<JsonObject> | undefined {
  if (error instanceof RuntimeInvariantError) return undefined;
  if (error instanceof RuntimeError) return errorResult(error.code, safeRuntimeMessage(error));
  return undefined;
}

/** Re-exported so a builtin can narrow the two uncertain process errors without a second import. */
export type UncertainProcessError = RuntimeProcessStaleSessionError | RuntimeProcessUncertainError;

/**
 * The security facts projector, in the general overlay contract's vocabulary.
 *
 * `ToolSecurityFacts` is a named-field interface and therefore not assignable to the `JsonObject`
 * constraint the overlay's generic carries — TypeScript requires an index signature, which an
 * interface of named `readonly` fields does not have. The two types describe the same JSON value; they
 * differ only in how they are declared, and this is the boundary where they meet.
 *
 * The cast cannot change behaviour: the value is produced here, stored in the catalog, and consumed by
 * the Security implementation, which types it against the Coding vocabulary. Nothing in between reads it.
 */
export function asOverlaySecurityFactsProjector(
  projector: (args: Readonly<JsonObject>) => ToolSecurityFacts,
): (args: Readonly<JsonObject>) => JsonObject {
  return projector as unknown as (args: Readonly<JsonObject>) => JsonObject;
}

/**
 * The effect projector, in the general overlay contract's vocabulary.
 *
 * `CodingToolEffectProjector` defaults its request type to the generic `JsonObject`, while the Coding
 * effect vocabulary needs the concrete projection input — it reads the durable `invocationId` to build
 * `SHELL_STARTED` / `SHELL_COMPLETED`. This adapter pins the contract's generics to that concrete input,
 * so the projector is accepted without the contract having to name a Coding type.
 *
 * It is an identity function. The value the settlement bridge supplies *is* that input: the bridge
 * assembles `{ request: { runId, stepId, invocationId, externalCallId, args, environment }, result, now }`
 * from the durable invocation, so the caller already provides exactly what the projector declares.
 */
export function asOverlayEffectProjector<TRequest, TResultDetails extends JsonObject, TEffect>(
  projector: ToolEffectProjector,
): CodingToolEffectProjector<TRequest, TResultDetails, TEffect> {
  return projector as unknown as CodingToolEffectProjector<TRequest, TResultDetails, TEffect>;
}

/**
 * The execution-result contract, under the name a builtin reads.
 *
 * `@caelush/agent` exports **two** different `AgentToolResult` types: the frozen Phase 3 Tool-turn
 * result, which describes what the *model* is told, and the Tool System's execution result, which
 * describes what a Tool *returns*. The package root publishes the Phase 3 one under the plain name and
 * aliases the execution one, so a builtin that imported `AgentToolResult` from the root would silently
 * receive the wrong type — one with `externalCallId` instead of `details`.
 *
 * Every builtin imports the name from here instead, where it already denotes the execution contract.
 */
export type { AgentToolResult };

/** Re-exported so a builtin declares its effect dependency without a second import. */
export type { ToolEffect, ToolSecurityFacts };
