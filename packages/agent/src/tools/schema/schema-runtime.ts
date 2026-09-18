import { Ajv } from "ajv";
import type { JsonObject } from "@caelush/ai";

import { AgentToolSchemaCompileError } from "../types/errors.js";

/**
 * The canonical Tool schema runtime.
 *
 * Every Tool schema in Architecture V2 — input and result details — is compiled exactly once, here.
 * There is no second compiler: a legacy entry that still exposes `ToolSchemaRuntime` re-exports this
 * one rather than owning a copy.
 *
 * ## The frozen AJV policy
 *
 * ```text
 * allErrors        true    report every problem, so a model can fix them in one turn
 * strict           true    a schema that is not understood is rejected, not ignored
 * coerceTypes      false   the validator never repairs a model's argument types
 * useDefaults      false   the validator never invents a value the model did not send
 * removeAdditional false   the validator never silently drops an unknown property
 * ```
 *
 * `coerceTypes: false` is the load-bearing setting. "The model sent a string where a number was
 * declared" is a contract violation that a Tool may address with an explicit, deterministic
 * `prepareArguments` hook — never something the framework fixes behind the Tool's back.
 *
 * ## What is refused outright
 *
 * ```text
 * $async: true            validation would return a promise; this runtime is synchronous
 * $ref to another document a registered schema may not reach off-document
 * ```
 *
 * A schema that cannot be compiled fails registration. A *validation call* never throws for a
 * merely invalid value: an invalid value is `{ valid: false, issues }`.
 */

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
      readonly truncatedIssueCount?: number | undefined;
    };

/** A compiled schema. Immutable, synchronous and total over `unknown`. */
export interface CompiledToolSchema {
  validate(value: unknown): ToolSchemaValidationResult;
}

type SchemaCompiler = (schema: JsonObject) => CompiledToolSchema;

/** True when a schema uses a feature the frozen runtime refuses. */
export function containsForbiddenSchemaFeature(value: unknown): boolean {
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
      throw new AgentToolSchemaCompileError(
        "Tool schema uses an unsupported reference or async feature.",
        { reason: "INVALID_INPUT_SCHEMA" },
      );
    }

    let validate: ((value: unknown) => boolean) & {
      errors?:
        | readonly {
            readonly instancePath?: string | undefined;
            readonly keyword: string;
            readonly message?: string | undefined;
          }[]
        | null
        | undefined;
    };
    try {
      validate = ajv.compile(schema);
    } catch {
      throw new AgentToolSchemaCompileError("Tool schema could not be compiled.", {
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

/**
 * The one schema compiler.
 *
 * A runtime instance holds one AJV instance. Sharing it across a registry build is what makes
 * "compiled once at registry build time" true rather than aspirational.
 */
export class ToolSchemaRuntime {
  private readonly compiler: SchemaCompiler;

  constructor() {
    this.compiler = createSchemaCompiler();
  }

  compile(schema: JsonObject): CompiledToolSchema {
    return this.compiler(schema);
  }
}
