import { ToolDefinitionSchema, type ToolDefinition, type ToolName } from "@caelush/protocol";
import { canonicalJsonString, jsonUtf8ByteLength } from "./json-canonical.js";
import { ToolRegistrationError } from "./errors.js";
import { validateToolRegistryOptions, type ToolRegistryOptions } from "./options.js";
import type { CompiledToolSchema, ToolSchemaRuntime } from "./schema-runtime.js";

export interface ValidatedToolSchemas {
  readonly input: CompiledToolSchema;
  readonly output: CompiledToolSchema;
}

function containsUnsupportedFeature(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsupportedFeature);
  if (typeof value !== "object" || value === null) return false;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "$async" && nestedValue === true) return true;
    if (key === "$ref" && typeof nestedValue === "string" && !nestedValue.startsWith("#")) {
      return true;
    }
    if (containsUnsupportedFeature(nestedValue)) return true;
  }
  return false;
}

function throwDefinitionError(
  reason: ConstructorParameters<typeof ToolRegistrationError>[1]["reason"],
  toolName?: ToolName,
  schemaKind?: "input" | "output",
): never {
  const subject = toolName === undefined ? "Tool definition" : `Tool "${toolName}"`;
  const metadata = { reason } as {
    reason: ConstructorParameters<typeof ToolRegistrationError>[1]["reason"];
    toolName?: ToolName;
    schemaKind?: "input" | "output";
  };
  if (toolName !== undefined) metadata.toolName = toolName;
  if (schemaKind !== undefined) metadata.schemaKind = schemaKind;
  throw new ToolRegistrationError(`${subject} is invalid (${reason}).`, metadata);
}

function compileSchema(
  schema: ToolDefinition["inputSchema"],
  kind: "input" | "output",
  definition: ToolDefinition,
  maxBytes: number,
  runtime: ToolSchemaRuntime,
): CompiledToolSchema {
  const reasonPrefix = kind === "input" ? "INPUT_SCHEMA" : "OUTPUT_SCHEMA";
  if (schema.type !== "object") {
    throwDefinitionError(`${reasonPrefix}_NOT_OBJECT`, definition.name, kind);
  }
  if (schema.additionalProperties !== false) {
    throwDefinitionError(`${reasonPrefix}_ADDITIONAL_PROPERTIES_NOT_FALSE`, definition.name, kind);
  }
  if (containsUnsupportedFeature(schema)) {
    throwDefinitionError(
      kind === "input" ? "INVALID_INPUT_SCHEMA" : "INVALID_OUTPUT_SCHEMA",
      definition.name,
      kind,
    );
  }
  if (jsonUtf8ByteLength(canonicalJsonString(schema)) > maxBytes) {
    throwDefinitionError("TOOL_SCHEMA_TOO_LARGE", definition.name, kind);
  }

  try {
    return runtime.compile(schema);
  } catch {
    throwDefinitionError(
      kind === "input" ? "INVALID_INPUT_SCHEMA" : "INVALID_OUTPUT_SCHEMA",
      definition.name,
      kind,
    );
  }
}

export function validateToolDefinitionSemantics(
  value: unknown,
  options: ToolRegistryOptions,
  runtime: ToolSchemaRuntime,
): ValidatedToolSchemas {
  validateToolRegistryOptions(options);
  const parsed = ToolDefinitionSchema.safeParse(value);
  if (!parsed.success) throwDefinitionError("INVALID_DEFINITION");
  const definition = parsed.data;
  if (definition.description.trim().length === 0) {
    throwDefinitionError("EMPTY_DESCRIPTION", definition.name);
  }
  if (jsonUtf8ByteLength(definition.description) > options.maxDescriptionBytes) {
    throwDefinitionError("TOOL_DESCRIPTION_TOO_LARGE", definition.name);
  }

  return {
    input: compileSchema(
      definition.inputSchema,
      "input",
      definition,
      options.maxInputSchemaBytes,
      runtime,
    ),
    output: compileSchema(
      definition.outputSchema,
      "output",
      definition,
      options.maxOutputSchemaBytes,
      runtime,
    ),
  };
}
