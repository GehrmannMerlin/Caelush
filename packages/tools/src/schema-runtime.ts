import { Ajv } from "ajv";
import type { JsonObject } from "@caelush/protocol";
import { ToolSchemaCompileError } from "./errors.js";

const MAX_VALIDATION_ISSUES = 16;

export interface ToolSchemaIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ToolSchemaValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly issues: readonly ToolSchemaIssue[];
      readonly truncatedIssueCount?: number;
    };

export interface CompiledToolSchema {
  validate(value: unknown): ToolSchemaValidationResult;
}

type SchemaCompiler = (schema: JsonObject) => CompiledToolSchema;

function containsForbiddenSchemaFeature(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSchemaFeature);
  if (typeof value !== "object" || value === null) return false;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "$async" && nestedValue === true) return true;
    if (key === "$ref" && typeof nestedValue === "string" && !nestedValue.startsWith("#")) {
      return true;
    }
    if (containsForbiddenSchemaFeature(nestedValue)) return true;
  }
  return false;
}

function createSchemaCompiler(): SchemaCompiler {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });

  return (schema) => {
    if (containsForbiddenSchemaFeature(schema)) {
      throw new ToolSchemaCompileError(
        "Tool schema uses an unsupported reference or async feature.",
        {
          reason: "INVALID_INPUT_SCHEMA",
        },
      );
    }

    let validate: ((value: unknown) => boolean) & {
      errors?:
        | readonly {
            readonly instancePath?: string;
            readonly keyword: string;
            readonly message?: string;
          }[]
        | null;
    };
    try {
      validate = ajv.compile(schema);
    } catch {
      throw new ToolSchemaCompileError("Tool schema could not be compiled.", {
        reason: "INVALID_INPUT_SCHEMA",
      });
    }

    return Object.freeze({
      validate(value: unknown): ToolSchemaValidationResult {
        if (validate(value)) return { valid: true };

        const errors = validate.errors ?? [];
        const issues = errors.slice(0, MAX_VALIDATION_ISSUES).map((error) => ({
          instancePath: error.instancePath ?? "",
          keyword: error.keyword,
          message: error.message ?? "Schema validation failed.",
        }));
        const truncatedIssueCount = Math.max(0, errors.length - issues.length);
        return truncatedIssueCount === 0
          ? { valid: false, issues }
          : { valid: false, issues, truncatedIssueCount };
      },
    });
  };
}

export class ToolSchemaRuntime {
  private readonly compiler: SchemaCompiler;

  constructor() {
    this.compiler = createSchemaCompiler();
  }

  compile(schema: JsonObject): CompiledToolSchema {
    return this.compiler(schema);
  }
}
