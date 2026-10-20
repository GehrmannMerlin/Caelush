import { createHash } from "node:crypto";

import type { ToolPreparationFailureFact, ToolPreparationFailureIssue } from "@caelush/agent";
import type {
  ResourceProgressFieldRecord,
  ResourceProgressPatternRecord,
  ResourceProgressTurnRecord,
} from "@caelush/protocol";

/**
 * What one accepted Tool result proves about progress.
 *
 * ```text
 * PREPARATION_FAILURE  the call was refused before execution by its declared schema
 * EXECUTION_FAILURE    something ran and failed, with a stable failure category
 * SUCCESS              something ran and succeeded
 * UNKNOWN              a historical result that carries no trusted classification
 * ```
 *
 * The list is deliberately short. `SUCCESS` is one category on purpose: telling a read from an edit
 * needs Tool metadata that Core does not own, and inventing it here would be a second tool catalog.
 * What the resource layer needs is narrower - "did a *new* failure mode appear, and did a later call
 * to the same Tool actually get through?" - and that is answerable from the accepted results alone.
 *
 * ## Why the pattern key ignores the arguments
 *
 * The failure this exists for is a model that keeps sending the same *wrong field* while changing
 * the patch body. Comparing arguments would call every attempt progress; comparing only the schema
 * facts says what a human would say: "same mistake again". So the key is the Tool, the stable code,
 * the declared constraint names and the classifier version - never a value, a byte length, a call id
 * or a timestamp.
 */
/**
 * The classifier's records are the durable records.
 *
 * Core derives them and Storage persists them, so there is exactly one definition of what a window
 * turn is - in the protocol package, where neither side has to import the other's runtime types.
 */
export type ResourceProgressField = ResourceProgressFieldRecord;
export type ResourceProgressPattern = ResourceProgressPatternRecord;
export type ResourceProgressTurn = ResourceProgressTurnRecord;

export const RESOURCE_PROGRESS_CLASSIFIER_VERSION = 1 as const;

/** The bounded fact a rejected call can contribute to the resource window. */
export interface PreparationFailureObservation {
  readonly patternKey: string;
  readonly toolName: string;
  readonly code: string;
}

/**
 * Build the durable preparation-failure fact from the Preparer's own feedback.
 *
 * Only `REJECTED` items reach this function: a skipped trailing call and a synthetic replan result
 * are scheduling facts, not schema mistakes, and classifying them as the same pattern is what would
 * make a corrective replan feed itself.
 */
export function preparationFailureFactFromRejection(feedback: {
  readonly code: string;
  readonly disposition: string;
  readonly details: { readonly [key: string]: unknown };
}): ToolPreparationFailureFact | undefined {
  if (feedback.disposition !== "SAFE_FAILURE") return undefined;
  const issues = readSafeIssues(feedback.details);
  return Object.freeze({
    kind: "PREPARATION_REJECTED" as const,
    code: feedback.code,
    issues: Object.freeze(issues),
    disposition: "SAFE_FAILURE" as const,
    classifierVersion: RESOURCE_PROGRESS_CLASSIFIER_VERSION,
  });
}

/** Derive the stable pattern identity of one preparation failure. */
export function toolFailurePatternKey(input: {
  readonly toolName: string;
  readonly fact: ToolPreparationFailureFact;
}): string {
  const signature = input.fact.issues
    .map((issue) => [issue.keyword, issue.path ?? "", issue.property ?? ""].join("\u0000"))
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        classifierVersion: input.fact.classifierVersion,
        toolName: input.toolName,
        code: input.fact.code,
        signature,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Reduce one accepted batch into the facts the window stores.
 *
 * A batch contributes at most one occurrence of a pattern, however many of its calls repeated it:
 * the same mistake sent three times in one batch is one turn of evidence, not three.
 */
export function resourceProgressTurn(input: {
  readonly turnId: string;
  readonly results: readonly {
    readonly toolName: string;
    readonly isError: boolean;
    readonly preparationFailure?: ToolPreparationFailureFact | undefined;
  }[];
}): ResourceProgressTurn | undefined {
  if (input.results.length === 0) return undefined;
  const patterns = new Map<string, ResourceProgressPattern>();
  const succeeded = new Set<string>();
  let classified = false;
  for (const result of input.results) {
    if (result.preparationFailure !== undefined) {
      classified = true;
      const key = toolFailurePatternKey({
        toolName: result.toolName,
        fact: result.preparationFailure,
      });
      patterns.set(key, {
        key,
        toolName: result.toolName,
        code: result.preparationFailure.code,
        fields: patternFields(result.preparationFailure),
      });
      continue;
    }
    if (!result.isError) {
      classified = true;
      succeeded.add(result.toolName);
      continue;
    }
    // A real execution failure has its own durable classification. It is not a schema pattern and
    // must not be folded into one: the recovery for the two is different.
    classified = true;
  }
  return Object.freeze({
    turnId: input.turnId,
    patterns: Object.freeze(
      [...patterns.values()].sort((left, right) => (left.key < right.key ? -1 : 1)),
    ),
    succeededTools: Object.freeze([...succeeded].sort()),
    classified,
  });
}

/** Project the stored issues into the labels a reminder can use. */
export function patternFields(fact: ToolPreparationFailureFact): readonly ResourceProgressField[] {
  const fields: ResourceProgressField[] = [];
  for (const issue of fact.issues.slice(0, 4)) {
    const name = safeName(issue.property ?? issue.path, 64);
    fields.push(
      Object.freeze({
        keyword: issue.keyword,
        ...(name === undefined ? {} : { name }),
      }),
    );
  }
  return Object.freeze(fields);
}

/** Render the field labels as one short, bounded phrase. */
export function describePatternFields(fields: readonly ResourceProgressField[]): string {
  if (fields.length === 0) return "the declared argument shape";
  return fields
    .map((field) => {
      const name = field.name === undefined ? "" : `"${field.name}"`;
      switch (field.keyword) {
        case "required":
          return `missing required ${name}`.trim();
        case "additionalProperties":
          return `unsupported ${name}`.trim();
        case "type":
          return `wrong type for ${name}`.trim();
        case "enum":
          return `unsupported value for ${name}`.trim();
        default:
          return `${name} violates ${field.keyword}`.trim();
      }
    })
    .join(", ");
}

function readSafeIssues(details: {
  readonly [key: string]: unknown;
}): readonly ToolPreparationFailureIssue[] {
  const value = details["issues"];
  if (!Array.isArray(value)) return Object.freeze([]);
  const issues: ToolPreparationFailureIssue[] = [];
  for (const entry of value.slice(0, 8)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const keyword = safeName(record["keyword"], 32);
    if (keyword === undefined) continue;
    const path = safeName(record["path"], 128);
    const property = safeName(record["property"], 64);
    issues.push(
      Object.freeze({
        keyword,
        ...(path === undefined ? {} : { path }),
        ...(property === undefined ? {} : { property }),
      }),
    );
  }
  return issues;
}

function safeName(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}
