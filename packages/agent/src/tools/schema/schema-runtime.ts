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
const MAX_PROPERTY_NAME_BYTES = 64;
const MAX_ALLOWED_PROPERTY_NAMES = 16;
const MAX_ALLOWED_VALUES = 8;
const MAX_ALLOWED_VALUE_BYTES = 32;

/**
 * One schema violation, reduced to facts the schema itself declared.
 *
 * ```text
 * instancePath          canonical JSON Pointer into the arguments
 * keyword               which declared constraint failed
 * message               the validator's structural statement (never shown as-is to a model)
 * property              the declared name that is missing or unsupported
 * expectedType          the JSON type the schema declared, for `type` failures
 * allowedPropertyNames  the object's declared field names, for a closed root object
 * allowedValues         the declared short string members of an `enum`
 * ```
 *
 * The optional fields exist because "correct the reported fields" is not something a model can act
 * on. They are extracted here, at the one place that has both the AJV error and the compiled schema,
 * and each of them is bounded and taken from the schema rather than from the failing value: no
 * argument value ever leaves this boundary through them.
 */
export interface ToolSchemaIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly property?: string;
  readonly expectedType?: string;
  readonly allowedPropertyNames?: readonly string[];
  readonly allowedValues?: readonly string[];
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

    // The declared field names of the root object are the only ones a model can be told about
    // cheaply. A nested object's names are intentionally not resolved: the feedback stays bounded
    // and the path already says where the problem is.
    const rootPropertyNames = declaredPropertyNames(schema);

    let validate: ((value: unknown) => boolean) & {
      errors?:
        | readonly {
            readonly instancePath?: string | undefined;
            readonly keyword: string;
            readonly message?: string | undefined;
            readonly params?: Readonly<Record<string, unknown>> | undefined;
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
        const issues = errors
          .slice(0, MAX_VALIDATION_ISSUES)
          .map((error) => describeIssue(error, rootPropertyNames));
        const truncatedIssueCount = Math.max(0, errors.length - issues.length);
        return truncatedIssueCount === 0
          ? { valid: false, issues }
          : { valid: false, issues, truncatedIssueCount };
      },
    });
  };
}

function describeIssue(
  error: {
    readonly instancePath?: string | undefined;
    readonly keyword: string;
    readonly message?: string | undefined;
    readonly params?: Readonly<Record<string, unknown>> | undefined;
  },
  rootPropertyNames: readonly string[] | undefined,
): ToolSchemaIssue {
  const params = error.params ?? {};
  const property =
    error.keyword === "required"
      ? safeSchemaName(params["missingProperty"])
      : error.keyword === "additionalProperties"
        ? safeSchemaName(params["additionalProperty"])
        : undefined;
  const expectedType = error.keyword === "type" ? safeJsonTypeName(params["type"]) : undefined;
  const allowedValues =
    error.keyword === "enum" ? safeEnumValues(params["allowedValues"]) : undefined;
  const instancePath = error.instancePath ?? "";
  return Object.freeze({
    instancePath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation failed.",
    ...(property === undefined ? {} : { property }),
    ...(expectedType === undefined ? {} : { expectedType }),
    ...(instancePath !== "" || rootPropertyNames === undefined
      ? {}
      : { allowedPropertyNames: rootPropertyNames }),
    ...(allowedValues === undefined ? {} : { allowedValues }),
  });
}

/** Only a schema-authored property name that is short and printable may reach a model. */
function safeSchemaName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_PROPERTY_NAME_BYTES) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function safeJsonTypeName(value: unknown): string | undefined {
  return value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "object" ||
    value === "array" ||
    value === "null"
    ? value
    : undefined;
}

function safeEnumValues(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_VALUES) {
    return undefined;
  }
  const names: string[] = [];
  for (const member of value) {
    const name = safeSchemaName(member);
    if (name === undefined || Buffer.byteLength(name, "utf8") > MAX_ALLOWED_VALUE_BYTES) {
      return undefined;
    }
    names.push(name);
  }
  return Object.freeze(names);
}

/** The declared field names of a closed root object, when they are few enough to quote. */
function declaredPropertyNames(schema: JsonObject): readonly string[] | undefined {
  const properties = schema["properties"];
  if (properties === undefined || typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const keys = Object.keys(properties);
  if (keys.length === 0 || keys.length > MAX_ALLOWED_PROPERTY_NAMES) return undefined;
  const names: string[] = [];
  for (const key of keys) {
    const name = safeSchemaName(key);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return Object.freeze(names.sort());
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
