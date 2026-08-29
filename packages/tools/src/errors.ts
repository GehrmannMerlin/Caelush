import type { ToolName } from "@caelush/protocol";

export type ToolRegistrationErrorReason =
  | "INVALID_DEFINITION"
  | "DUPLICATE_TOOL_NAME"
  | "EMPTY_DESCRIPTION"
  | "INVALID_INPUT_SCHEMA"
  | "INVALID_OUTPUT_SCHEMA"
  | "INPUT_SCHEMA_NOT_OBJECT"
  | "OUTPUT_SCHEMA_NOT_OBJECT"
  | "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "OUTPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE"
  | "TOOL_SCHEMA_TOO_LARGE"
  | "TOOL_DESCRIPTION_TOO_LARGE"
  | "TOOL_CATALOG_TOO_LARGE"
  | "TOOL_LIMIT_EXCEEDED"
  | "BUILDER_FINALIZED"
  | "INVALID_REGISTRY_OPTION"
  | "INVALID_OUTPUT_POLICY";

export interface ToolRegistrationErrorMetadata {
  readonly toolName?: ToolName;
  readonly reason: ToolRegistrationErrorReason;
  readonly schemaKind?: "input" | "output";
}

export class ToolRegistrationError extends Error {
  readonly reason: ToolRegistrationErrorReason;
  readonly toolName: ToolName | undefined;
  readonly schemaKind: "input" | "output" | undefined;

  constructor(message: string, metadata: ToolRegistrationErrorMetadata) {
    super(message);
    this.name = "ToolRegistrationError";
    this.reason = metadata.reason;
    this.toolName = metadata.toolName;
    this.schemaKind = metadata.schemaKind;
  }
}

export class ToolSchemaCompileError extends ToolRegistrationError {
  constructor(message: string, metadata: ToolRegistrationErrorMetadata) {
    super(message, metadata);
    this.name = "ToolSchemaCompileError";
  }
}

export class ToolRegistryStateError extends ToolRegistrationError {
  constructor(message: string, metadata: ToolRegistrationErrorMetadata) {
    super(message, metadata);
    this.name = "ToolRegistryStateError";
  }
}
