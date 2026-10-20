import type { ToolName } from "@caelush/protocol";

import type { ToolSchemaIssue } from "../schema/schema-runtime.js";

/** The most issues a model is shown, even when the validator reported more. */
export const MAX_MODEL_SCHEMA_ISSUES = 8;

/** The UTF-8 byte bound of the whole rendered feedback. */
export const MAX_MODEL_SCHEMA_FEEDBACK_BYTES = 2_048;

/**
 * Render the schema violations of one rejected call into bounded, actionable text.
 *
 * The previous feedback said "correct the reported fields" while the actual fields stayed in
 * `details`, which a model never sees. A model that cannot see *which* field is wrong can only
 * guess, and guessing is what turns one schema mistake into dozens of model turns.
 *
 * What a line may contain is deliberately narrow — the tool name, a field path, a schema-declared
 * field name, a JSON type, a declared enum member — and never an argument value, a patch body, a
 * file path, a stack trace or raw validator output. Every quoted name was already bounded and
 * checked for control characters at the schema boundary; this renderer re-checks cheaply because
 * feedback is the last place before text becomes model input.
 *
 * Priority under a tight budget: the missing/unsupported field problems come first, because those
 * are the ones a model can fix without seeing its own arguments again.
 */
export function renderToolSchemaFeedback(input: {
  readonly toolName: ToolName;
  readonly issues: readonly ToolSchemaIssue[];
  readonly truncatedIssueCount?: number | undefined;
}): string {
  const ranked = [...input.issues].sort((left, right) => issueRank(left) - issueRank(right));
  const shown = ranked.slice(0, MAX_MODEL_SCHEMA_ISSUES).map(describeIssue);
  const omitted =
    Math.max(0, ranked.length - shown.length) + Math.max(0, input.truncatedIssueCount ?? 0);

  const header = `Arguments for "${input.toolName}" do not match its declared input schema.`;
  const footer = `Nothing was executed. Correct these fields and call "${input.toolName}" again.`;

  const lines: string[] = [];
  let bytes = Buffer.byteLength(`${header}\n${footer}`, "utf8");
  let dropped = 0;
  for (const line of shown) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + lineBytes > MAX_MODEL_SCHEMA_FEEDBACK_BYTES) {
      dropped += 1;
      continue;
    }
    bytes += lineBytes;
    lines.push(line);
  }
  const omittedTotal = omitted + dropped;
  const omissionLine =
    omittedTotal === 0 ? undefined : `(${String(omittedTotal)} further issue(s) omitted.)`;

  const body = [header, ...lines, ...(omissionLine === undefined ? [] : [omissionLine])];
  // Under an extreme budget the actionable lines win over the closing instruction, but the header
  // always survives so the model knows what the text is about.
  const withFooter = `${body.join("\n")}\n${footer}`;
  return Buffer.byteLength(withFooter, "utf8") <= MAX_MODEL_SCHEMA_FEEDBACK_BYTES
    ? withFooter
    : body.join("\n");
}

/** Missing and unsupported fields first; everything else keeps its validator order. */
function issueRank(issue: ToolSchemaIssue): number {
  switch (issue.keyword) {
    case "required":
      return 0;
    case "additionalProperties":
      return 1;
    case "type":
      return 2;
    case "enum":
      return 3;
    default:
      return 4;
  }
}

function describeIssue(issue: ToolSchemaIssue): string {
  const field = fieldLabel(issue.instancePath);
  const property = safeLabel(issue.property);
  switch (issue.keyword) {
    case "required":
      return property === undefined
        ? `${field}: a required field is missing`
        : `${field}: missing required field "${property}"`;
    case "additionalProperties": {
      if (property === undefined) return `${field}: unsupported extra field`;
      const allowed = declaredFields(issue.allowedPropertyNames);
      return allowed === undefined
        ? `${field}: unsupported field "${property}"`
        : `${field}: unsupported field "${property}"; declared fields are ${allowed}`;
    }
    case "type": {
      const expected = safeLabel(issue.expectedType);
      return expected === undefined
        ? `${field}: wrong value type`
        : `${field}: expected ${expected}`;
    }
    case "enum": {
      const allowed = declaredFields(issue.allowedValues);
      return allowed === undefined
        ? `${field}: value is not one of the declared options`
        : `${field}: expected one of ${allowed}`;
    }
    default:
      return `${field}: violates the declared "${safeKeyword(issue.keyword)}" constraint`;
  }
}

function fieldLabel(instancePath: string): string {
  const path = normalizeInstancePath(instancePath);
  return path.length === 0 ? "arguments" : `field "${path}"`;
}

/** Turn a JSON Pointer instance path into a readable dotted field path. */
export function normalizeInstancePath(instancePath: string): string {
  return instancePath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function declaredFields(values: readonly string[] | undefined): string | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const labels = values.map(safeLabel);
  return labels.some((label) => label === undefined)
    ? undefined
    : labels.map((label) => `"${label!}"`).join(", ");
}

function safeKeyword(keyword: string): string {
  return /^[a-zA-Z]{1,32}$/.test(keyword) ? keyword : "schema";
}

/** A name may carry no control character and must stay short; anything else is dropped. */
function safeLabel(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (Buffer.byteLength(value, "utf8") > 64) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}
