import type { ToolName } from "@caelush/protocol";
import { CODING_TOOL_PROMPT_SNIPPETS } from "@caelush/coding-agent";

/**
 * The legacy structured model guidance — a compatibility view over the canonical Coding snippets.
 *
 * ```text
 * BEFORE 4E   an eight-field guidance table, appended into AIToolSpec.description by the registry
 * AFTER  4E   the same eight fields, read out of the canonical Coding prompt snippet
 * ```
 *
 * ## Why the text moved
 *
 * Usage guidance used to be concatenated onto the Tool's `description`, which put it inside the
 * *provider tool definition*. That meant it was counted against the tool-catalog byte budget, it was
 * sent whether or not the Tool was exposed for the Run, and it could not be reasoned about as context
 * because it was not context.
 *
 * The canonical text now lives in `@caelush/coding-agent` as a `promptSnippet`, delivered to the model
 * through the budgeted Context path exactly once. An explicit `modelGuidance` a caller supplies is
 * still honoured — the field is public API until Phase 4F — but the built-in table is gone, so the
 * guidance text has exactly one source.
 *
 * ## What this module is not
 *
 * It is not a judgement about whether guidance *should* be appended. The composition root decides
 * that: production no longer appends, because the Coding prompt provider contributes the same text as
 * budgeted context instead.
 */
export interface ToolModelGuidance {
  readonly toolName: ToolName;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly argumentNotes: string;
  readonly sideEffects: string;
  readonly safety: string;
  readonly resultHandling: string;
}

const MAX_GUIDANCE_FIELD_BYTES = 2048;

/**
 * The snippet headings, in the order the canonical renderer writes them.
 *
 * `label` is the heading the Coding snippet uses; the key is the legacy field it fills. Keeping the
 * two names side by side is what lets the legacy structured shape survive a rename in the canonical
 * text without a second copy of the values.
 */
const GUIDANCE_FIELDS = [
  { key: "purpose", label: "Purpose" },
  { key: "whenToUse", label: "When" },
  { key: "whenNotToUse", label: "When not" },
  { key: "argumentNotes", label: "Args" },
  { key: "sideEffects", label: "Side effects" },
  { key: "safety", label: "Safety" },
  { key: "resultHandling", label: "Results" },
] as const satisfies readonly {
  readonly key: keyof Omit<ToolModelGuidance, "toolName">;
  readonly label: string;
}[];

function freezeGuidance(guidance: ToolModelGuidance): ToolModelGuidance {
  return Object.freeze({ ...guidance });
}

/**
 * Read one labelled value out of a rendered Coding snippet.
 *
 * A snippet is `"<tool name>"` followed by one `"<Label>: <value>"` line per field. The read is
 * strict: a missing or empty heading means the canonical text and this reader have drifted, which is a
 * defect rather than a default, so it throws instead of substituting an empty string.
 */
function readSnippetField(snippet: string, label: string, toolName: ToolName): string {
  for (const line of snippet.split("\n")) {
    if (!line.startsWith(`${label}:`)) continue;
    const value = line.slice(label.length + 1).trim();
    if (value.length > 0) return value;
  }
  throw new Error(`Missing model guidance field ${label} for tool ${toolName}.`);
}

export function createBuiltinToolModelGuidance(toolName: ToolName): ToolModelGuidance {
  const snippet = CODING_TOOL_PROMPT_SNIPPETS[toolName];
  if (snippet === undefined) throw new Error(`Missing model guidance for tool ${toolName}.`);
  const fields = GUIDANCE_FIELDS.map(
    (field) => [field.key, readSnippetField(snippet, field.label, toolName)] as const,
  );
  return freezeGuidance({ toolName, ...Object.fromEntries(fields) } as ToolModelGuidance);
}

export function cloneToolModelGuidance(guidance: ToolModelGuidance): ToolModelGuidance {
  return freezeGuidance({ ...guidance });
}

export function appendToolModelGuidance(description: string, guidance: ToolModelGuidance): string {
  return [
    description,
    `Purpose: ${guidance.purpose}`,
    `When: ${guidance.whenToUse}`,
    `When not: ${guidance.whenNotToUse}`,
    `Args: ${guidance.argumentNotes}`,
    `Side effects: ${guidance.sideEffects}`,
    `Safety: ${guidance.safety}`,
    `Results: ${guidance.resultHandling}`,
  ].join(" ");
}

export function normalizeToolModelGuidance(
  guidance: ToolModelGuidance,
  expectedToolName: ToolName,
): ToolModelGuidance {
  if (guidance === null || typeof guidance !== "object") {
    throw new Error("model guidance must be an object");
  }
  if (guidance.toolName !== expectedToolName) {
    throw new Error("model guidance tool name must match its definition");
  }
  for (const field of [
    "purpose",
    "whenToUse",
    "whenNotToUse",
    "argumentNotes",
    "sideEffects",
    "safety",
    "resultHandling",
  ] as const) {
    const value = guidance[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`model guidance field ${field} must be non-empty`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_GUIDANCE_FIELD_BYTES) {
      throw new Error(`model guidance field ${field} is too large`);
    }
  }
  return cloneToolModelGuidance(guidance);
}
