import type { JsonObject } from "@caelush/ai";
import type { ToolName } from "@caelush/protocol";

import { AgentToolRegistrationError } from "../types/errors.js";
import { canonicalJsonString, jsonUtf8ByteLength } from "./json-canonical.js";
import type { CompiledToolSchema, ToolSchemaRuntime } from "./schema-runtime.js";
import { containsForbiddenSchemaFeature } from "./schema-runtime.js";

/**
 * Tool schema and catalog policy.
 *
 * ## Two budgets, deliberately separate
 *
 * ```text
 * catalog budget   what the model sees: AIToolSpec only — name, description, inputSchema
 * schema budget    what the framework checks: inputSchema and resultDetailsSchema, each bounded
 * ```
 *
 * Only the first is a prompt budget. Coding metadata — risk level, required capabilities, runtime
 * requirements, effect and security projectors, presentation, prompt snippets — is **not** part of
 * `modelSpecs()` and therefore cannot inflate or exhaust the model's tool catalog allowance. A Tool
 * that becomes more carefully governed must not become more expensive to describe.
 *
 * ## Frozen defaults
 *
 * ```text
 * maxTools              64
 * maxDescriptionBytes   8192
 * maxInputSchemaBytes   5000
 * maxResultSchemaBytes  16384
 * maxCatalogBytes       262144
 * ```
 *
 * These are the limits the Tool System already enforced. `maxResultSchemaBytes` is the schema budget
 * formerly named `maxOutputSchemaBytes`; the value is unchanged and the rename follows the result
 * contract's own rename from `outputSchema` to `resultDetailsSchema`.
 */
export interface ToolRegistryOptions {
  readonly maxTools: number;
  readonly maxDescriptionBytes: number;
  readonly maxInputSchemaBytes: number;
  readonly maxResultSchemaBytes: number;
  readonly maxCatalogBytes: number;
}

export const DEFAULT_TOOL_REGISTRY_OPTIONS: ToolRegistryOptions = Object.freeze({
  maxTools: 64,
  maxDescriptionBytes: 8192,
  maxInputSchemaBytes: 5000,
  maxResultSchemaBytes: 16384,
  maxCatalogBytes: 256 * 1024,
});

export function validateToolRegistryOptions(options: ToolRegistryOptions): ToolRegistryOptions {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentToolRegistrationError(
        `Tool registry option ${name} must be a positive integer.`,
        { reason: "INVALID_REGISTRY_OPTION" },
      );
    }
  }
  return options;
}

/** The model-facing projection of a Tool: exactly three fields. */
export interface ToolModelSpecInput {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ValidatedToolSchemas {
  readonly input: CompiledToolSchema;
  readonly result: CompiledToolSchema;
}

type SchemaReason =
  | "INPUT_SCHEMA_NOT_OBJECT"
  | "RESULT_SCHEMA_NOT_OBJECT"
  | "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "RESULT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "INVALID_INPUT_SCHEMA"
  | "INVALID_RESULT_SCHEMA"
  | "TOOL_SCHEMA_TOO_LARGE"
  | "EMPTY_DESCRIPTION"
  | "TOOL_DESCRIPTION_TOO_LARGE";

function invalidTool(
  reason: SchemaReason,
  toolName: ToolName,
  schemaKind?: "input" | "result",
): never {
  throw new AgentToolRegistrationError(`Tool "${toolName}" is invalid (${reason}).`, {
    reason,
    toolName,
    ...(schemaKind === undefined ? {} : { schemaKind }),
  });
}

/**
 * A schema is refused when it cannot mean what a Tool contract needs.
 *
 * ```text
 * root type object                    an argument payload is always an object
 * additionalProperties false          a model may not invent fields the Tool ignores
 * no external $ref, no $async         the runtime cannot honor them
 * within its byte budget              oversized schemas fail registration, never get compacted
 * compiles under the frozen AJV policy
 * ```
 *
 * There is no lossy compaction: an oversized schema is refused rather than quietly trimmed, because
 * a trimmed schema changes a contract without telling the Tool that owns it.
 */
function compileSchema(
  schema: JsonObject,
  kind: "input" | "result",
  toolName: ToolName,
  maxBytes: number,
  runtime: ToolSchemaRuntime,
): CompiledToolSchema {
  const notObject: SchemaReason =
    kind === "input" ? "INPUT_SCHEMA_NOT_OBJECT" : "RESULT_SCHEMA_NOT_OBJECT";
  const notClosed: SchemaReason =
    kind === "input"
      ? "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
      : "RESULT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE";
  const uncompilable: SchemaReason =
    kind === "input" ? "INVALID_INPUT_SCHEMA" : "INVALID_RESULT_SCHEMA";

  if (schema.type !== "object") invalidTool(notObject, toolName, kind);
  if (schema.additionalProperties !== false) invalidTool(notClosed, toolName, kind);
  if (containsForbiddenSchemaFeature(schema)) invalidTool(uncompilable, toolName, kind);
  if (jsonUtf8ByteLength(canonicalJsonString(schema)) > maxBytes) {
    invalidTool("TOOL_SCHEMA_TOO_LARGE", toolName, kind);
  }

  try {
    return runtime.compile(schema);
  } catch {
    invalidTool(uncompilable, toolName, kind);
  }
}

/**
 * Compile and bound a Tool's two schemas.
 *
 * Called once per Tool, at registry build time — never once per invocation.
 */
export function validateToolSchemaSemantics(
  spec: ToolModelSpecInput,
  resultDetailsSchema: JsonObject,
  options: ToolRegistryOptions,
  runtime: ToolSchemaRuntime,
): ValidatedToolSchemas {
  validateToolRegistryOptions(options);
  if (spec.description.trim().length === 0) invalidTool("EMPTY_DESCRIPTION", spec.name);
  if (jsonUtf8ByteLength(spec.description) > options.maxDescriptionBytes) {
    invalidTool("TOOL_DESCRIPTION_TOO_LARGE", spec.name);
  }

  return {
    input: compileSchema(
      spec.inputSchema,
      "input",
      spec.name,
      options.maxInputSchemaBytes,
      runtime,
    ),
    result: compileSchema(
      resultDetailsSchema,
      "result",
      spec.name,
      options.maxResultSchemaBytes,
      runtime,
    ),
  };
}

/**
 * The catalog byte cost of one Tool: its model-visible spec, canonically serialized.
 *
 * This is the only thing that consumes the catalog budget. Adding a security fact projector or a
 * presentation projector costs nothing here, which is exactly the property the split exists for.
 */
export function toolModelSpecByteLength(spec: ToolModelSpecInput): number {
  return jsonUtf8ByteLength(
    canonicalJsonString({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }),
  );
}
