import type { AgentTool, AgentToolRegistrationErrorReason } from "@caelush/agent";
import type { JsonObject } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import {
  ToolRegistrationError,
  ToolSchemaCompileError,
  type ToolRegistrationErrorMetadata,
  type ToolRegistrationErrorReason,
} from "./errors.js";

/**
 * The declared compatibility bridge between the legacy Tool System and the canonical one.
 *
 * ```text
 * @caelush/tools  (legacy public entry)  ──delegates──▶  @caelush/agent  (canonical implementation)
 * ```
 *
 * This module is where the two vocabularies meet and nothing else crosses. It owns two things:
 *
 * ```text
 * reason translation   an AgentToolRegistrationError reason -> the legacy ToolRegistrationError reason
 * error identity       so an existing caller's `catch` and `reason` assertions keep working
 * ```
 *
 * It deliberately owns **no** algorithm. There is no second schema compiler, no second registry
 * resolution and no second argument-validation rule here; the legacy entry points call the canonical
 * implementations and only re-shape the failure they can throw.
 */

const REASON_MAP: Readonly<Record<AgentToolRegistrationErrorReason, ToolRegistrationErrorReason>> =
  Object.freeze({
    INVALID_DEFINITION: "INVALID_DEFINITION",
    DUPLICATE_TOOL_NAME: "DUPLICATE_TOOL_NAME",
    EMPTY_DESCRIPTION: "EMPTY_DESCRIPTION",
    INVALID_INPUT_SCHEMA: "INVALID_INPUT_SCHEMA",
    INVALID_RESULT_SCHEMA: "INVALID_OUTPUT_SCHEMA",
    INPUT_SCHEMA_NOT_OBJECT: "INPUT_SCHEMA_NOT_OBJECT",
    RESULT_SCHEMA_NOT_OBJECT: "OUTPUT_SCHEMA_NOT_OBJECT",
    INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE: "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE",
    RESULT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE: "OUTPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE",
    TOOL_SCHEMA_TOO_LARGE: "TOOL_SCHEMA_TOO_LARGE",
    TOOL_DESCRIPTION_TOO_LARGE: "TOOL_DESCRIPTION_TOO_LARGE",
    TOOL_CATALOG_TOO_LARGE: "TOOL_CATALOG_TOO_LARGE",
    TOOL_LIMIT_EXCEEDED: "TOOL_LIMIT_EXCEEDED",
    BUILDER_FINALIZED: "BUILDER_FINALIZED",
    INVALID_REGISTRY_OPTION: "INVALID_REGISTRY_OPTION",
  });

/** The legacy reason a canonical reason projects to. Total by construction. */
export function toLegacyRegistrationReason(
  reason: AgentToolRegistrationErrorReason,
): ToolRegistrationErrorReason {
  return REASON_MAP[reason];
}

interface CanonicalRegistrationFailure {
  readonly name: string;
  readonly reason: AgentToolRegistrationErrorReason;
  readonly toolName?: ToolName | undefined;
  readonly schemaKind?: "input" | "result" | undefined;
}

const CANONICAL_ERROR_NAMES = new Set([
  "AgentToolRegistrationError",
  "AgentToolSchemaCompileError",
  "AgentToolRegistryStateError",
]);

function readCanonicalFailure(error: unknown): CanonicalRegistrationFailure | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as {
    readonly name?: unknown;
    readonly reason?: unknown;
    readonly toolName?: unknown;
    readonly schemaKind?: unknown;
  };
  if (typeof candidate.name !== "string" || !CANONICAL_ERROR_NAMES.has(candidate.name)) {
    return undefined;
  }
  if (typeof candidate.reason !== "string" || !Object.hasOwn(REASON_MAP, candidate.reason)) {
    return undefined;
  }
  return {
    name: candidate.name,
    reason: candidate.reason as AgentToolRegistrationErrorReason,
    toolName: typeof candidate.toolName === "string" ? (candidate.toolName as ToolName) : undefined,
    schemaKind:
      candidate.schemaKind === "input" || candidate.schemaKind === "result"
        ? candidate.schemaKind
        : undefined,
  };
}

/**
 * Re-shape a canonical registration failure as the legacy error a caller already catches.
 *
 * A failure this bridge does not recognize is rethrown unchanged: inventing a legacy reason for an
 * unknown error would hide a real bug behind a familiar-looking code.
 */
export function throwLegacyRegistrationError(error: unknown): never {
  const failure = readCanonicalFailure(error);
  if (failure === undefined) throw error;

  const metadata: ToolRegistrationErrorMetadata = {
    reason: toLegacyRegistrationReason(failure.reason),
    ...(failure.toolName === undefined ? {} : { toolName: failure.toolName }),
    ...(failure.schemaKind === undefined
      ? {}
      : { schemaKind: failure.schemaKind === "result" ? "output" : "input" }),
  };
  const message = error instanceof Error ? error.message : "Tool registration is invalid.";
  throw failure.name === "AgentToolSchemaCompileError"
    ? new ToolSchemaCompileError(message, metadata)
    : new ToolRegistrationError(message, metadata);
}

/**
 * The one compatibility normalization a legacy registration opts into.
 *
 * The algorithm itself lives in `@caelush/coding-agent`
 * (`tools/legacy-argument-normalization.ts`) so exactly one implementation exists and the general
 * `@caelush/agent` Preparer stays free of it. The Coding product layer is reached through a cached
 * dynamic import, which is how a legacy package consumes a target package without declaring a
 * static dependency edge back into it.
 */
type CodingAgentTools = Awaited<typeof import("@caelush/coding-agent")>;

let codingAgentTools: Promise<CodingAgentTools> | undefined;

export function loadCodingAgentTools(): Promise<CodingAgentTools> {
  codingAgentTools ??= import("@caelush/coding-agent");
  return codingAgentTools;
}

export async function createLegacyArgumentNormalization(): Promise<
  ReturnType<CodingAgentTools["createLegacyNumericArgumentNormalization"]>
> {
  const codingAgent = await loadCodingAgentTools();
  return codingAgent.createLegacyNumericArgumentNormalization();
}

/** Build the canonical Agent Tool a legacy definition and handler describe. */
export function createLegacyAgentTool(input: {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly resultDetailsSchema: JsonObject;
  readonly label: string;
  readonly execute: AgentTool["execute"];
  readonly prepareArguments?: AgentTool["prepareArguments"];
}): AgentTool {
  return Object.freeze({
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    label: input.label,
    resultDetailsSchema: input.resultDetailsSchema,
    executionMode: "SEQUENTIAL",
    ...(input.prepareArguments === undefined ? {} : { prepareArguments: input.prepareArguments }),
    execute: input.execute,
  });
}
