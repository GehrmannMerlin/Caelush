import { ToolRegistrationError } from "./errors.js";

export interface ToolRegistryOptions {
  readonly maxTools: number;
  readonly maxDescriptionBytes: number;
  readonly maxInputSchemaBytes: number;
  readonly maxOutputSchemaBytes: number;
  readonly maxCatalogBytes: number;
}

export const DEFAULT_TOOL_REGISTRY_OPTIONS: ToolRegistryOptions = Object.freeze({
  maxTools: 64,
  maxDescriptionBytes: 8192,
  maxInputSchemaBytes: 5000,
  maxOutputSchemaBytes: 16384,
  maxCatalogBytes: 256 * 1024,
});

export function validateToolRegistryOptions(options: ToolRegistryOptions): ToolRegistryOptions {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ToolRegistrationError(`Tool registry option ${name} must be a positive integer.`, {
        reason: "INVALID_REGISTRY_OPTION",
      });
    }
  }
  return options;
}
